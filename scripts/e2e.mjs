#!/usr/bin/env node
// End to end on NEAR testnet + Bitcoin signet, with real coins and the real
// MPC network:
//
//   1. maker opens an offer; the contract gets its deposit address from MPC
//   2. that address is re-derived independently from the MPC public view
//   3. maker sends signet BTC to it
//   4. taker pays NEAR with take_offer; the contract asks MPC to sign
//   5. the signed release transaction is read from the contract and broadcast
//
//   node scripts/e2e.mjs [sats] [price] [--usdc]
//
// With --usdc the offer is priced in test USDC (usdc.trueque.testnet) and the
// taker buys through ft_transfer_call.
//
// Writes a public report (ids, txids, links; no secrets) to docs/e2e-report.json.

import { writeFileSync } from "node:fs";
import { nearToYocto } from "near-api-js";
import { CONTRACT, EXPLORER, MPC, account, addressOfKey, broadcast, feeFor, feeRate, send, sleep, utxos, view, wallet } from "./lib.mjs";

const USDC_TOKEN = "usdc.trueque.testnet";
const USDC = process.argv.includes("--usdc");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SATS = Number(args[0] ?? 2000);
const PRICE = args[1] ?? (USDC ? "1.5" : "0.25");
const priceUnits = USDC ? BigInt(Math.round(Number(PRICE) * 1e6)) : nearToYocto(PRICE);
const MAKER = process.env.MAKER ?? "trueque-maker.testnet";
const TAKER = process.env.TAKER ?? "trueque-taker.testnet";
const MAKER_BTC = wallet(process.env.MAKER_BTC ?? "e2e-maker-20261107");
const TAKER_BTC = wallet(process.env.TAKER_BTC ?? "demo-taker");

const report = { contract: CONTRACT, currency: USDC ? `USDC (${USDC_TOKEN})` : "NEAR", network: "NEAR testnet + Bitcoin signet", started: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  report.steps.push({ step: name, ...data });
  console.log(`\n[${report.steps.length}] ${name}\n`, data);
};
const nearTx = (h) => `https://testnet.nearblocks.io/txns/${h}`;

const maker = account(MAKER);
const taker = account(TAKER);

// Test USDC for both sides: the faucet also registers the maker to receive the payout.
if (USDC) {
  for (const a of [maker, taker]) await a.callFunction({ contractId: USDC_TOKEN, methodName: "faucet", args: {}, gas: 30_000_000_000_000n });
}

// 1. Open the offer.
const created = await maker.callFunctionRaw({
  contractId: CONTRACT,
  methodName: "create_offer",
  args: { sats: SATS, price: priceUnits.toString(), refund_address: MAKER_BTC.address, token: USDC ? USDC_TOKEN : null },
  deposit: nearToYocto("0.02"),
  gas: 50_000_000_000_000n,
});
const offer = JSON.parse(Buffer.from(created.status.SuccessValue, "base64").toString());
if (!offer?.deposit_address) throw new Error("Offer not opened: " + JSON.stringify(created.status));
step("Maker opens an offer", { id: offer.id, sats: SATS, price: `${PRICE} ${USDC ? "USDC" : "NEAR"}`, deposit_address: offer.deposit_address, near_tx: nearTx(created.transaction.hash) });

// 2. Re-derive the address from the MPC contract, independently of Trueque.
const key = await view("derived_public_key", { path: offer.derivation_path, predecessor: CONTRACT, domain_id: 0 }, MPC);
const independent = addressOfKey(key);
if (independent !== offer.deposit_address) throw new Error(`Address mismatch: ${independent} vs ${offer.deposit_address}`);
step("Deposit address independently re-derived from the MPC contract", { path: offer.derivation_path, derived_key: key, address: independent });

// 3. Fund it with signet BTC.
const fundTxid = await send(MAKER_BTC, offer.deposit_address, SATS);
step("Maker deposits BTC at the offer address", { btc_txid: fundTxid, link: `${EXPLORER}/tx/${fundTxid}` });

let deposits = [];
for (let i = 0; i < 30 && !deposits.length; i++) {
  deposits = await utxos(offer.deposit_address);
  if (!deposits.length) await sleep(2000);
}
if (!deposits.length) throw new Error("Deposit not visible on Esplora");

// 4. Take it.
const fee = feeFor(deposits.length, 1, await feeRate());
const takeArgs = { id: offer.id, btc_address: TAKER_BTC.address, utxos: deposits.map(({ txid, vout, value }) => ({ txid, vout, value })), fee_sats: fee };
const taken = USDC
  ? await taker.callFunctionRaw({
      contractId: USDC_TOKEN,
      methodName: "ft_transfer_call",
      args: { receiver_id: CONTRACT, amount: priceUnits.toString(), msg: JSON.stringify(takeArgs) },
      deposit: 1n,
      gas: 300_000_000_000_000n,
    })
  : await taker.callFunctionRaw({ contractId: CONTRACT, methodName: "take_offer", args: takeArgs, deposit: priceUnits, gas: 300_000_000_000_000n });
step(`Taker pays ${USDC ? "USDC (ft_transfer_call)" : "NEAR"} into escrow; contract requests MPC signatures`, { near_tx: nearTx(taken.transaction.hash), fee_sats: fee, inputs: deposits.length });

// 5. Wait for the signatures, then broadcast the release.
let o;
const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  o = await view("get_offer", { id: offer.id });
  if (o.status === "Settled") break;
  await sleep(2000);
}
if (o.status !== "Settled") throw new Error("Not settled: " + JSON.stringify(o.settlements));
const release = o.settlements.at(-1);
step("MPC signed, signature verified on chain, maker paid", { status: o.status, signed: `${release.signed}/${release.total}`, seconds: Math.round((Date.now() - t0) / 1000), btc_txid: release.txid });

const releaseTxid = await broadcast(release.raw_tx);
step("Release transaction broadcast to Bitcoin signet", { btc_txid: releaseTxid, to: TAKER_BTC.address, sats: release.outputs[0].value, link: `${EXPLORER}/tx/${releaseTxid}` });

report.finished = new Date().toISOString();
report.config = await view("get_config");
if (USDC) report.maker_usdc_balance = await view("ft_balance_of", { account_id: MAKER }, USDC_TOKEN);
writeFileSync(new URL(`../docs/e2e-report${USDC ? "-usdc" : ""}.json`, import.meta.url), JSON.stringify(report, null, 2));
console.log("\nOK: trade settled end to end. Report in docs/e2e-report.json");

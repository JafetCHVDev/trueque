#!/usr/bin/env node
// End to end on NEAR testnet + Bitcoin testnet, with real coins, the real MPC
// network and the real NEAR Bitcoin light client:
//
//   1. maker opens an offer; the contract gets its deposit address from MPC
//   2. that address is re-derived independently from the MPC public view
//   3. maker sends testnet BTC to it and waits for a confirmation the light
//      client has seen
//   4. taker pays with the raw deposit tx + SPV proof; the contract parses it,
//      the light client verifies it, and the contract asks MPC to sign
//   5. the signed release transaction is read from the contract and broadcast
//
//   node scripts/e2e.mjs [sats] [price] [--usdc] [--offer=<id>]
//
// --usdc prices the offer in test USDC and buys through ft_transfer_call.
// --offer=<id> resumes with an offer that is already funded.
// Writes a public report (ids, txids, links; no secrets) to docs/.

import { writeFileSync } from "node:fs";
import { nearToYocto } from "near-api-js";
import { CONTRACT, EXPLORER, LIGHT_CLIENT, MPC, account, addressOfKey, broadcast, confirmations, feeFor, feeRate, send, sleep, utxos, view, wallet } from "./lib.mjs";
import { depositProof, forContract } from "./spv.mjs";

const USDC_TOKEN = "usdc.trueque.testnet";
const USDC = process.argv.includes("--usdc");
const RESUME = process.argv.find((a) => a.startsWith("--offer="))?.split("=")[1];
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SATS = Number(args[0] ?? 2000);
const PRICE = args[1] ?? (USDC ? "1.5" : "0.3");
const priceUnits = USDC ? BigInt(Math.round(Number(PRICE) * 1e6)) : nearToYocto(PRICE);
const MAKER = process.env.MAKER ?? "trueque-maker.testnet";
const TAKER = process.env.TAKER ?? "trueque-taker.testnet";
const MAKER_BTC = wallet(process.env.MAKER_BTC ?? "liquidity");
const TAKER_BTC = wallet(process.env.TAKER_BTC ?? "demo-taker");
const REPORT = `../docs/e2e-report-v2${USDC ? "-usdc" : ""}.json`;

const report = {
  contract: CONTRACT,
  light_client: LIGHT_CLIENT,
  currency: USDC ? `USDC (${USDC_TOKEN})` : "NEAR",
  network: "NEAR testnet + Bitcoin testnet3",
  started: new Date().toISOString(),
  steps: [],
};
const step = (name, data) => {
  report.steps.push({ step: name, ...data });
  console.log(`\n[${report.steps.length}] ${name}\n`, data);
};
const nearTx = (h) => `https://testnet.nearblocks.io/txns/${h}`;
const lcHeight = async () => (await view("get_last_block_header", {}, LIGHT_CLIENT)).block_height;

const maker = account(MAKER);
const taker = account(TAKER);

if (USDC) {
  // The faucet also registers the maker with the token to receive the payout.
  for (const a of [maker, taker]) await a.callFunction({ contractId: USDC_TOKEN, methodName: "faucet", args: {}, gas: 30_000_000_000_000n });
}

let offer;
if (RESUME) {
  offer = await view("get_offer", { id: Number(RESUME) });
  step("Resuming a funded offer", { id: offer.id, deposit_address: offer.deposit_address });
} else {
  // 1. Open the offer.
  const created = await maker.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "create_offer",
    args: { sats: SATS, price: priceUnits.toString(), refund_address: MAKER_BTC.address, token: USDC ? USDC_TOKEN : null },
    deposit: nearToYocto("0.02"),
    gas: 50_000_000_000_000n,
  });
  offer = JSON.parse(Buffer.from(created.status.SuccessValue, "base64").toString());
  if (!offer?.deposit_address) throw new Error("Offer not opened: " + JSON.stringify(created.status));
  step("Maker opens an offer", { id: offer.id, sats: SATS, price: `${PRICE} ${USDC ? "USDC" : "NEAR"}`, deposit_address: offer.deposit_address, near_tx: nearTx(created.transaction.hash) });

  // 2. Re-derive the address from the MPC contract, independently of Trueque.
  const key = await view("derived_public_key", { path: offer.derivation_path, predecessor: CONTRACT, domain_id: 0 }, MPC);
  const independent = addressOfKey(key);
  if (independent !== offer.deposit_address) throw new Error(`Address mismatch: ${independent} vs ${offer.deposit_address}`);
  step("Deposit address independently re-derived from the MPC contract", { path: offer.derivation_path, address: independent });

  // 3. Fund it.
  const fundTxid = await send(MAKER_BTC, offer.deposit_address, offer.sats);
  step("Maker deposits BTC at the offer address", { btc_txid: fundTxid, link: `${EXPLORER}/tx/${fundTxid}` });
}

// Wait for a confirmed deposit that the light client has also seen.
let deposits = [];
let proofs = [];
for (let i = 0; i < 360; i++) {
  deposits = (await utxos(offer.deposit_address).catch(() => [])).filter((u) => u.status?.confirmed);
  if (deposits.length) {
    proofs = await Promise.all(deposits.map((u) => depositProof(u.txid, u.vout)));
    const lc = await lcHeight();
    if (proofs.every((p) => p.height <= lc)) break;
    console.log(`  light client at ${lc}, deposit block ${Math.max(...proofs.map((p) => p.height))}`);
  } else if (i % 6 === 0) {
    console.log("  waiting for a Bitcoin block...");
  }
  await sleep(10_000);
}
if (!proofs.length) throw new Error("Deposit not confirmed in time");
step("Deposit confirmed and known to the light client", {
  height: proofs[0].height,
  confirmations: proofs[0].confirmations,
  light_client_tip: await lcHeight(),
});

// 4. Take it with the SPV proof.
const fee = feeFor(proofs.length, 1, await feeRate());
const takeArgs = { id: offer.id, btc_address: TAKER_BTC.address, deposits: proofs.map(forContract), fee_sats: fee };
const taken = USDC
  ? await taker.callFunctionRaw({
      contractId: USDC_TOKEN,
      methodName: "ft_transfer_call",
      args: { receiver_id: CONTRACT, amount: priceUnits.toString(), msg: JSON.stringify(takeArgs) },
      deposit: 1n,
      gas: 300_000_000_000_000n,
    })
  : await taker.callFunctionRaw({ contractId: CONTRACT, methodName: "take_offer", args: takeArgs, deposit: priceUnits, gas: 300_000_000_000_000n });
step(`Taker pays ${USDC ? "USDC (ft_transfer_call)" : "NEAR"} with the SPV proof; light client verifies; contract asks MPC to sign`, {
  near_tx: nearTx(taken.transaction.hash),
  fee_sats: fee,
});

// 5. Wait for the signatures, then broadcast the release.
let o;
const t0 = Date.now();
for (let i = 0; i < 60; i++) {
  o = await view("get_offer", { id: offer.id });
  if (o.status === "Settled" || o.status === "Open") break;
  await sleep(2000);
}
if (o.status !== "Settled") throw new Error(`Not settled (${o.status}): ` + JSON.stringify(o.settlements));
const release = o.settlements.at(-1);
step("Deposit proven on chain, MPC signed, signature verified, maker paid", {
  status: o.status,
  verified_confirmations: release.verified_confirmations,
  signed: `${release.signed}/${release.total}`,
  seconds: Math.round((Date.now() - t0) / 1000),
});

const releaseTxid = await broadcast(release.raw_tx);
step("Release transaction broadcast to Bitcoin testnet", {
  btc_txid: releaseTxid,
  known_to_bitcoin: (await confirmations(releaseTxid)) >= 0,
  to: TAKER_BTC.address,
  sats: release.outputs[0].value,
  link: `${EXPLORER}/tx/${releaseTxid}`,
});

report.finished = new Date().toISOString();
report.config = await view("get_config");
writeFileSync(new URL(REPORT, import.meta.url), JSON.stringify(report, null, 2));
console.log(`\nOK: trade settled end to end. Report in ${REPORT.slice(3)}`);

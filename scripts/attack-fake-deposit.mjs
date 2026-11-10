#!/usr/bin/env node
// Attack test, on the live contract: a buyer claims a deposit that does not
// exist. The fake transaction is well formed and pays the offer's escrow, and
// the SPV proof material is copied from a real block the light client knows.
// Expected: the light client rejects it, the contract returns the NEAR and the
// offer stays open.
//
//   node scripts/attack-fake-deposit.mjs

import { writeFileSync } from "node:fs";
import * as bitcoin from "bitcoinjs-lib";
import { nearToYocto } from "near-api-js";
import { CONTRACT, LIGHT_CLIENT, account, view, wallet } from "./lib.mjs";
import { merkleBranch, rpc } from "./spv.mjs";

const maker = account(process.env.MAKER ?? "trueque-maker.testnet");
const taker = account(process.env.TAKER ?? "trueque-taker.testnet");

const r = await maker.callFunctionRaw({
  contractId: CONTRACT,
  methodName: "create_offer",
  args: { sats: 1000, price: nearToYocto("0.1").toString(), refund_address: wallet("liquidity").address, token: null },
  deposit: nearToYocto("0.02"),
  gas: 50_000_000_000_000n,
});
const offer = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
console.log(`offer #${offer.id}, escrow ${offer.deposit_address} (never funded)`);

// A fake deposit: valid transaction bytes paying the escrow, never broadcast.
const tx = new bitcoin.Transaction();
tx.version = 2;
tx.addInput(Buffer.alloc(32, 7), 0);
tx.addOutput(bitcoin.address.toOutputScript(offer.deposit_address, bitcoin.networks.testnet), 1000n);

// Proof material from a real block the light client has.
const tip = (await view("get_last_block_header", {}, LIGHT_CLIENT)).block_height;
let h = tip - 20;
let block;
for (;; h--) {
  block = await rpc("getblock", [await rpc("getblockhash", [h]), 1]);
  if (block.tx.length >= 2) break;
}
const proof = {
  raw_tx: tx.toHex(),
  vout: 0,
  block_hash: block.hash,
  tx_index: 1,
  merkle_proof: merkleBranch(block.tx, 1).branch,
  coinbase_tx_id: block.tx[0],
  coinbase_merkle_proof: merkleBranch(block.tx, 0).branch,
};

const before = await taker.getBalance();
const res = await taker.callFunctionRaw({
  contractId: CONTRACT,
  methodName: "take_offer",
  args: { id: offer.id, btc_address: wallet("demo-taker").address, deposits: [proof], fee_sats: 200 },
  deposit: nearToYocto("0.1"),
  gas: 300_000_000_000_000n,
});
const spent = Number(before - (await taker.getBalance())) / 1e24;
const o = await view("get_offer", { id: offer.id });
const events = res.receipts_outcome.flatMap((x) => x.outcome.logs).filter((l) => l.startsWith("EVENT_JSON"));

const result = {
  offer: offer.id,
  near_tx: `https://testnet.nearblocks.io/txns/${res.transaction.hash}`,
  status_after: o.status,
  settlements_after: o.settlements.length,
  taker_spent_near: spent,
  events,
  passed: o.status === "Open" && o.settlements.length === 0 && spent < 0.05,
};
console.log(result);
writeFileSync(new URL("../docs/attack-fake-deposit.json", import.meta.url), JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
console.log("OK: fake deposit rejected, NEAR returned, offer still open");

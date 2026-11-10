#!/usr/bin/env node
// Fund several offer escrows with one Bitcoin transaction (avoids chaining
// spends of unconfirmed change through a lagging Esplora view).
//
//   node scripts/fund-many.mjs <wallet> <offerId> [offerId...]

import * as bitcoin from "bitcoinjs-lib";
import { NETWORK, broadcast, feeFor, feeRate, utxos, view, wallet } from "./lib.mjs";

const [name, ...ids] = process.argv.slice(2);
const w = wallet(name);
const outs = [];
for (const id of ids) {
  const o = await view("get_offer", { id: Number(id) });
  if (o.status !== "Open" || !o.deposit_address) throw new Error(`offer ${id} is ${o.status}`);
  outs.push({ address: o.deposit_address, value: o.sats, id });
}
const need = outs.reduce((a, o) => a + o.value, 0);
const coins = (await utxos(w.address)).sort((a, b) => b.value - a.value);
const rate = await feeRate();
const psbt = new bitcoin.Psbt({ network: NETWORK });
let total = 0;
for (const c of coins) {
  psbt.addInput({ hash: c.txid, index: c.vout, witnessUtxo: { script: w.payment.output, value: BigInt(c.value) } });
  total += c.value;
  if (total >= need + feeFor(psbt.inputCount, outs.length + 1, rate)) break;
}
const fee = feeFor(psbt.inputCount, outs.length + 1, rate);
if (total < need + fee) throw new Error(`${name} has ${total} sats, needs ${need + fee}`);
for (const o of outs) psbt.addOutput({ address: o.address, value: BigInt(o.value) });
if (total - need - fee >= 546) psbt.addOutput({ address: w.address, value: BigInt(total - need - fee) });
psbt.signAllInputs({ publicKey: Buffer.from(w.keyPair.publicKey), sign: (h) => Buffer.from(w.keyPair.sign(h)) }).finalizeAllInputs();
const txid = await broadcast(psbt.extractTransaction().toHex());
console.log(`funded offers ${ids.join(", ")} (${need} sats) in ${txid}`);

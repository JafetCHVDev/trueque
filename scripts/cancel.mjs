#!/usr/bin/env node
// Cancel an open offer as its maker; any BTC at the escrow address is signed
// back to the maker's refund address by the contract, then broadcast.
//
//   node scripts/cancel.mjs <offerId> [maker-account]

import { CONTRACT, account, broadcast, feeFor, feeRate, sleep, utxos, view } from "./lib.mjs";

const [idArg, makerId = "trueque-maker.testnet"] = process.argv.slice(2);
const id = Number(idArg);
const offer = await view("get_offer", { id });
if (!offer || offer.status !== "Open") throw new Error(`Offer ${id} is not open`);

const deposits = await utxos(offer.deposit_address);
const fee = deposits.length ? feeFor(deposits.length, 1, await feeRate()) : 0;
await account(makerId).callFunction({
  contractId: CONTRACT,
  methodName: "cancel_offer",
  args: { id, utxos: deposits.map(({ txid, vout, value }) => ({ txid, vout, value })), fee_sats: fee },
  gas: 300_000_000_000_000n,
});
console.log(`offer #${id} cancelled; refunding ${deposits.reduce((s, u) => s + u.value, 0)} sats`);
if (!deposits.length) process.exit(0);

for (let i = 0; i < 30; i++) {
  const o = await view("get_offer", { id });
  const refund = o.settlements.at(-1);
  if (refund?.raw_tx) {
    const txid = await broadcast(refund.raw_tx);
    console.log(`refund broadcast: https://mempool.space/signet/tx/${txid}`);
    process.exit(0);
  }
  await sleep(2000);
}
throw new Error("Refund signatures did not arrive; run retry_signatures");

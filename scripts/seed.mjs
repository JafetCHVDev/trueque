#!/usr/bin/env node
// Open funded offers so the market has Bitcoin to buy.
//
//   node scripts/seed.mjs <signet-wallet> <sats> <price> [count] [maker-account] [--usdc]
//
// Each offer gets its MPC-derived escrow address and is funded from the named
// signet wallet in .secrets/wallets/.

import { nearToYocto } from "near-api-js";
import { CONTRACT, account, send, sleep, wallet } from "./lib.mjs";

const USDC = process.argv.includes("--usdc");
const [name, sats, price, count = "1", makerId = "trueque-maker.testnet"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!name || !sats || !price) {
  console.error("usage: node scripts/seed.mjs <signet-wallet> <sats> <priceNEAR> [count] [maker-account]");
  process.exit(1);
}
const w = wallet(name);
const maker = account(makerId);

for (let i = 0; i < Number(count); i++) {
  const r = await maker.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "create_offer",
    args: {
      sats: Number(sats),
      price: (USDC ? BigInt(Math.round(Number(price) * 1e6)) : nearToYocto(price)).toString(),
      refund_address: w.address,
      token: USDC ? "usdc.trueque.testnet" : null,
    },
    deposit: nearToYocto("0.02"),
    gas: 50_000_000_000_000n,
  });
  const offer = JSON.parse(Buffer.from(r.status.SuccessValue, "base64").toString());
  const txid = await send(w, offer.deposit_address, Number(sats));
  console.log(`offer #${offer.id}: ${sats} sats for ${price} ${USDC ? "USDC" : "NEAR"} at ${offer.deposit_address}, funded by ${txid}`);
  await sleep(3000); // let Esplora see the change output before the next spend
}

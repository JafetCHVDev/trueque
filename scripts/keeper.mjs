#!/usr/bin/env node
// Keeper: makes settlements happen even if nobody keeps a browser open.
//
//   node scripts/keeper.mjs [--once] [account]
//
// Runs every 5 minutes in GitHub Actions (.github/workflows/keeper.yml) in
// broadcast only mode, so settlements reach Bitcoin even if nobody is online.
//
// Every 20 seconds it (1) broadcasts every fully signed settlement that Bitcoin
// has not seen yet and (2) asks MPC again for signatures missing for more than
// a minute (retry_signatures is permissionless). It holds no keys of any value:
// the NEAR account only pays gas, and the Bitcoin transactions were already
// signed by the contract.

import { esplora, account, broadcast, sleep, view, CONTRACT } from "./lib.mjs";

const once = process.argv.includes("--once");
const callerId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "trueque.testnet";
// Without a NEAR key (for example in CI) the keeper only broadcasts.
let caller = null;
try {
  caller = account(callerId);
} catch {
  console.log("No NEAR key found: broadcast only mode");
}
const firstSeenUnsigned = new Map();

async function known(txid) {
  try {
    await esplora(`/tx/${txid}`); // /status would answer even for unknown txids
    return true;
  } catch {
    return false;
  }
}

async function tick() {
  const offers = await view("list_offers", { status: null, limit: 100 });
  for (const o of offers) {
    for (const st of o.settlements) {
      if (st.raw_tx) {
        if (!(await known(st.txid))) {
          try {
            await broadcast(st.raw_tx);
            console.log(`[offer ${o.id}] broadcast ${st.kind} ${st.txid}`);
          } catch (e) {
            console.log(`[offer ${o.id}] broadcast failed: ${e.message.slice(0, 120)}`);
          }
        }
        continue;
      }
      const key = `${o.id}:${st.txid}`;
      const since = firstSeenUnsigned.get(key) ?? Date.now();
      firstSeenUnsigned.set(key, since);
      if (caller && Date.now() - since > 60_000) {
        try {
          await caller.callFunction({ contractId: CONTRACT, methodName: "retry_signatures", args: { id: o.id }, gas: 300_000_000_000_000n });
          console.log(`[offer ${o.id}] asked MPC again (${st.signed}/${st.total} signed)`);
          firstSeenUnsigned.set(key, Date.now());
        } catch (e) {
          console.log(`[offer ${o.id}] retry failed: ${e.message.slice(0, 120)}`);
        }
      }
    }
  }
}

do {
  try {
    await tick();
  } catch (e) {
    console.log("tick failed:", e.message);
  }
  if (!once) await sleep(20_000);
} while (!once);

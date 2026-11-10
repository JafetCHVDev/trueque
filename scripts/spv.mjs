// SPV proofs for Trueque deposits, built from a public Bitcoin testnet RPC.
// The contract hands them to the NEAR Bitcoin light client
// (btc-client-v4.testnet, verify_transaction_inclusion_v2).
//
// Hashes go to the contract in display order hex (as explorers show them);
// the contract reverses them into the internal order Bitcoin hashes with.

import { createHash } from "node:crypto";

export const BTC_RPC = process.env.BTC_RPC ?? "https://bitcoin-testnet-rpc.publicnode.com";

export async function rpc(method, params = []) {
  const res = await fetch(BTC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const rev = (hex) => Buffer.from(hex, "hex").reverse();

/** Merkle branch for leaf `index` among display order txids, as display order hex. */
export function merkleBranch(txids, index) {
  let level = txids.map(rev);
  const branch = [];
  let i = index;
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    branch.push(Buffer.from(level[i ^ 1]).reverse().toString("hex"));
    const next = [];
    for (let k = 0; k < level.length; k += 2) next.push(sha256d(Buffer.concat([level[k], level[k + 1]])));
    level = next;
    i >>= 1;
  }
  return { branch, root: Buffer.from(level[0]).reverse().toString("hex") };
}

/** Everything `take_offer` needs to prove output `vout` of confirmed tx `txid`. */
export async function depositProof(txid, vout) {
  const tx = await rpc("getrawtransaction", [txid, true]);
  if (!tx.blockhash) throw new Error(`${txid} is not confirmed yet`);
  const block = await rpc("getblock", [tx.blockhash, 1]);
  const index = block.tx.indexOf(txid);
  const own = merkleBranch(block.tx, index);
  const coinbase = merkleBranch(block.tx, 0);
  if (own.root !== block.merkleroot) throw new Error("Merkle root mismatch");
  return {
    raw_tx: tx.hex,
    vout,
    block_hash: tx.blockhash,
    tx_index: index,
    merkle_proof: own.branch,
    coinbase_tx_id: block.tx[0],
    coinbase_merkle_proof: coinbase.branch,
    // Not sent to the contract; handy for checks and the UI.
    confirmations: tx.confirmations,
    height: block.height,
  };
}

/** The proof fields `take_offer` accepts (drops the informational ones). */
export const forContract = ({ confirmations, height, ...p }) => p;

/** Borsh encoding of ProofArgsV2 for a direct view call to the light client. */
export function proofArgsV2(p, txidDisplay, confirmations) {
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const vec = (hashes) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(hashes.length);
    return Buffer.concat([len, ...hashes.map(rev)]);
  };
  return Buffer.concat([
    rev(txidDisplay),
    rev(p.block_hash),
    u64(p.tx_index),
    vec(p.merkle_proof),
    rev(p.coinbase_tx_id),
    vec(p.coinbase_merkle_proof),
    u64(confirmations),
  ]);
}

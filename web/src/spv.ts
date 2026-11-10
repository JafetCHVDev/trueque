// SPV proofs for deposits, built in the browser from a public Bitcoin testnet
// RPC. The Trueque contract hands them to the NEAR Bitcoin light client, so a
// purchase only goes through for a deposit that really is in the chain.

import * as bitcoin from "bitcoinjs-lib";
import { BTC_RPC } from "./config";

export interface DepositProof {
  raw_tx: string;
  vout: number;
  block_hash: string;
  tx_index: number;
  merkle_proof: string[];
  coinbase_tx_id: string;
  coinbase_merkle_proof: string[];
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(BTC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result as T;
}

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const rev = (h: string) => fromHex(h).reverse();
const display = (b: Uint8Array) => toHex(Uint8Array.from(b).reverse());

function merkleBranch(txids: string[], index: number): { branch: string[]; root: string } {
  let level: Uint8Array[] = txids.map(rev);
  const branch: string[] = [];
  let i = index;
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]);
    branch.push(display(level[i ^ 1]));
    const next: Uint8Array[] = [];
    for (let k = 0; k < level.length; k += 2) {
      const pair = new Uint8Array(64);
      pair.set(level[k]);
      pair.set(level[k + 1], 32);
      next.push(bitcoin.crypto.hash256(pair));
    }
    level = next;
    i >>= 1;
  }
  return { branch, root: display(level[0]) };
}

/** Proof that output `vout` of `txid` is in a block. Throws if unconfirmed. */
export async function depositProof(txid: string, vout: number): Promise<DepositProof> {
  const tx = await rpc<{ hex: string; blockhash?: string }>("getrawtransaction", [txid, true]);
  if (!tx.blockhash) throw new Error("The deposit is not confirmed yet");
  const block = await rpc<{ tx: string[]; merkleroot: string }>("getblock", [tx.blockhash, 1]);
  const index = block.tx.indexOf(txid);
  const own = merkleBranch(block.tx, index);
  if (own.root !== block.merkleroot) throw new Error("Merkle proof does not match the block");
  return {
    raw_tx: tx.hex,
    vout,
    block_hash: tx.blockhash,
    tx_index: index,
    merkle_proof: own.branch,
    coinbase_tx_id: block.tx[0],
    coinbase_merkle_proof: merkleBranch(block.tx, 0).branch,
  };
}

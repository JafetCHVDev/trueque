// Shared helpers for the Trueque scripts: NEAR testnet access with the local
// legacy keychain, a Bitcoin testnet client (Esplora for addresses, Bitcoin
// Core RPC for transactions) and a tiny P2WPKH wallet.
// Testnet coins have no value. Never put a mainnet key in .secrets/.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import { Account, JsonRpcProvider } from "near-api-js";
import * as ecc from "tiny-secp256k1";
import { rpc } from "./spv.mjs";

export const CONTRACT = process.env.TRUEQUE_CONTRACT ?? "trueque.testnet";
export const LIGHT_CLIENT = "btc-client-v4.testnet";
export const MPC = "v1.signer-prod.testnet";
export const NETWORK = bitcoin.networks.testnet;
/** BTC_NETWORK=signet operates the v1 contract (market.trueque.testnet). */
export const BTC_NETWORK = process.env.BTC_NETWORK ?? "testnet";
export const EXPLORER = `https://mempool.space/${BTC_NETWORK}`;
const ESPLORAS = [`https://blockstream.info/${BTC_NETWORK}/api`, `https://mempool.space/${BTC_NETWORK}/api`];
const ROOT = fileURLToPath(new URL("..", import.meta.url));

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

export const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC ?? "https://rpc.testnet.fastnear.com" });

export function account(accountId) {
  const file = join(homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  if (!existsSync(file)) throw new Error(`No key for ${accountId} in ~/.near-credentials/testnet`);
  return new Account(accountId, provider, JSON.parse(readFileSync(file, "utf8")).private_key);
}

export const view = (method, args = {}, contractId = CONTRACT) => provider.callFunction({ contractId, method, args });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function esplora(path, init) {
  let last;
  for (const base of ESPLORAS) {
    try {
      const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      if (res.ok) return body;
      if (init?.method === "POST" && res.status === 400) throw new Error(`Broadcast rejected: ${body}`);
      last = new Error(`${res.status} ${body}`);
    } catch (e) {
      if (String(e.message).startsWith("Broadcast rejected")) throw e;
      last = e;
    }
  }
  throw last;
}

/** UTXOs of an address: Esplora (includes the mempool), or confirmed ones from
 * the node's UTXO set when every Esplora rate limits this IP. */
export async function utxos(address) {
  try {
    return JSON.parse(await esplora(`/address/${address}/utxo`));
  } catch (e) {
    for (let i = 0; i < 30; i++) {
      try {
        const r = await rpc("scantxoutset", ["start", [`addr(${address})`]]);
        return r.unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8), status: { confirmed: true, block_height: u.height } }));
      } catch (err) {
        if (!/in progress/i.test(err.message)) throw err;
        await sleep(5000);
      }
    }
    throw e;
  }
}
/** Broadcast through Bitcoin Core RPC, falling back to Esplora. */
export async function broadcast(hex) {
  if (BTC_NETWORK !== "testnet") return esplora("/tx", { method: "POST", body: hex });
  try {
    return await rpc("sendrawtransaction", [hex]);
  } catch (e) {
    if (/already|known/i.test(e.message)) return bitcoin.Transaction.fromHex(hex).getId();
    return esplora("/tx", { method: "POST", body: hex });
  }
}

/** Confirmations of a transaction (0 in mempool), or -1 if Bitcoin does not know it. */
export async function confirmations(txid) {
  try {
    return (await rpc("getrawtransaction", [txid, true])).confirmations ?? 0;
  } catch {
    return -1;
  }
}

export async function feeRate() {
  try {
    const r = JSON.parse(await (await fetch(`https://mempool.space/${BTC_NETWORK}/api/v1/fees/recommended`, { signal: AbortSignal.timeout(8000) })).text());
    return Math.min(3, Math.max(1, r.halfHourFee ?? 1));
  } catch {
    return 1;
  }
}

/** Miner fee for spending n P2WPKH inputs to the given output count (P2WPKH/P2TR). */
export function feeFor(nIn, nOut, rate) {
  const vsize = Math.ceil(((4 + 1 + nIn * 41 + 1 + nOut * 43 + 4) * 4 + 2 + nIn * 109) / 4);
  return Math.max(vsize, Math.ceil(vsize * rate)) + 20;
}

export function wallet(name) {
  const file = join(ROOT, ".secrets", "wallets", `${name}.json`);
  const keyPair = ECPair.fromWIF(JSON.parse(readFileSync(file, "utf8")).wif, NETWORK);
  const payment = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyPair.publicKey), network: NETWORK });
  return { name, keyPair, payment, address: payment.address };
}

/** Pay `sats` from a signet wallet to `to`. Returns the txid. */
export async function send(w, to, sats) {
  const coins = (await utxos(w.address)).sort((a, b) => b.value - a.value);
  const rate = await feeRate();
  const psbt = new bitcoin.Psbt({ network: NETWORK });
  let total = 0;
  for (const c of coins) {
    psbt.addInput({ hash: c.txid, index: c.vout, witnessUtxo: { script: w.payment.output, value: BigInt(c.value) } });
    total += c.value;
    if (total >= sats + feeFor(psbt.inputCount, 2, rate)) break;
  }
  const fee = feeFor(psbt.inputCount, 2, rate);
  if (total < sats + fee) throw new Error(`${w.name} has ${total} sats, needs ${sats + fee}`);
  psbt.addOutput({ address: to, value: BigInt(sats) });
  const change = total - sats - fee;
  if (change >= 546) psbt.addOutput({ address: w.address, value: BigInt(change) });
  const signer = { publicKey: Buffer.from(w.keyPair.publicKey), sign: (h) => Buffer.from(w.keyPair.sign(h)) };
  psbt.signAllInputs(signer).finalizeAllInputs();
  return broadcast(psbt.extractTransaction().toHex());
}

/** Compressed public key -> P2WPKH testnet address (independent of the contract). */
export function addressOfKey(nearSecp256k1Key) {
  const xy = Buffer.from(bs58decode(nearSecp256k1Key.replace("secp256k1:", "")));
  const pub = Buffer.concat([Buffer.from([xy[63] & 1 ? 3 : 2]), xy.subarray(0, 32)]);
  return bitcoin.payments.p2wpkh({ pubkey: pub, network: NETWORK }).address;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s) {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

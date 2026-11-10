// Bitcoin signet side: Esplora client, address checks, fee estimates and a
// small in-browser P2WPKH wallet for guests (signet coins have no value).

import ecc from "@bitcoinerlab/secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import { ESPLORAS } from "./config";

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);
export const NET = bitcoin.networks.testnet; // signet shares testnet's address format

export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

async function esplora(path: string, init?: RequestInit): Promise<string> {
  let last: unknown;
  for (const base of ESPLORAS) {
    try {
      const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      if (res.ok) return body;
      if (init?.method === "POST" && res.status === 400) throw new BroadcastError(body);
      last = new Error(`${res.status} ${body}`);
    } catch (e) {
      if (e instanceof BroadcastError) throw e;
      last = e;
    }
  }
  throw last;
}

export class BroadcastError extends Error {}

export const getUtxos = async (address: string): Promise<EsploraUtxo[]> => JSON.parse(await esplora(`/address/${address}/utxo`));
export const tipHeight = async () => Number(await esplora("/blocks/tip/height"));

/** Esplora's /tx/:id/status answers {confirmed:false} even for unknown
 * transactions, so existence is checked on /tx/:id, which 404s. */
export async function txStatus(txid: string): Promise<{ found: boolean; confirmed: boolean; block_height?: number }> {
  try {
    const tx = JSON.parse(await esplora(`/tx/${txid}`));
    return { found: true, confirmed: !!tx.status?.confirmed, block_height: tx.status?.block_height };
  } catch {
    return { found: false, confirmed: false };
  }
}

/** Broadcast; an already-known transaction counts as success. */
export async function broadcast(hex: string): Promise<string> {
  try {
    return await esplora("/tx", { method: "POST", body: hex });
  } catch (e) {
    if (e instanceof BroadcastError && /already|known|exists|missing-inputs|inputs-missingorspent/i.test(e.message)) {
      return bitcoin.Transaction.fromHex(hex).getId();
    }
    throw e;
  }
}

/** Signet fee rate in sat/vB. Signet blocks are rarely full and public
 * estimators overshoot wildly there, so this stays between 1 and 3. */
export async function feeRate(): Promise<number> {
  try {
    const r = await fetch("https://mempool.space/signet/api/v1/fees/recommended", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return Math.min(3, Math.max(1, Math.ceil(j.halfHourFee ?? 1)));
  } catch {
    return 1;
  }
}

/** Miner fee for spending n P2WPKH inputs to nOut segwit outputs. Matches the contract's minimum. */
export function feeFor(nIn: number, nOut: number, rate: number): number {
  const vsize = Math.ceil(((4 + 1 + nIn * 41 + 1 + nOut * 43 + 4) * 4 + 2 + nIn * 109) / 4);
  return Math.max(vsize, Math.ceil(vsize * rate)) + 20;
}

export function isSignetAddress(a: string): boolean {
  try {
    bitcoin.address.toOutputScript(a.trim(), NET);
    return /^tb1/i.test(a.trim());
  } catch {
    return false;
  }
}

export const fmtSats = (n: number) => n.toLocaleString("en-US");
export const satsToBtc = (n: number) => (n / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
export const short = (s: string, n = 6) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

// ------------------------------------------------------------------ guest wallet

const BTC_KEY = "trueque.btc.v1";

export interface BtcWallet {
  address: string;
  send(to: string, sats: number): Promise<string>;
}

export function loadBtcWallet(create = false): BtcWallet | null {
  let wif: string | null = null;
  try {
    wif = localStorage.getItem(BTC_KEY);
  } catch {
    /* storage blocked */
  }
  if (!wif) {
    if (!create) return null;
    wif = ECPair.makeRandom({ network: NET }).toWIF();
    try {
      localStorage.setItem(BTC_KEY, wif);
    } catch {
      /* this tab only */
    }
  }
  const keyPair = ECPair.fromWIF(wif, NET);
  const pubkey = keyPair.publicKey;
  const payment = bitcoin.payments.p2wpkh({ pubkey, network: NET });
  const address = payment.address!;
  return {
    address,
    async send(to, sats) {
      const coins = (await getUtxos(address)).sort((a, b) => b.value - a.value);
      const rate = await feeRate();
      const psbt = new bitcoin.Psbt({ network: NET });
      let total = 0;
      for (const c of coins) {
        psbt.addInput({ hash: c.txid, index: c.vout, witnessUtxo: { script: payment.output!, value: BigInt(c.value) } });
        total += c.value;
        if (total >= sats + feeFor(psbt.inputCount, 2, rate)) break;
      }
      const fee = feeFor(psbt.inputCount, 2, rate);
      if (total < sats + fee) throw new Error(`Your signet wallet has ${fmtSats(total)} sats; this needs ${fmtSats(sats + fee)} including the miner fee.`);
      psbt.addOutput({ address: to, value: BigInt(sats) });
      const change = total - sats - fee;
      if (change >= 546) psbt.addOutput({ address, value: BigInt(change) });
      psbt.signAllInputs({ publicKey: pubkey, sign: (h: Uint8Array) => keyPair.sign(h) });
      psbt.finalizeAllInputs();
      return broadcast(psbt.extractTransaction().toHex());
    },
  };
}

export async function balanceOf(address: string): Promise<{ confirmed: number; pending: number }> {
  const u = await getUtxos(address);
  return {
    confirmed: u.filter((x) => x.status.confirmed).reduce((s, x) => s + x.value, 0),
    pending: u.filter((x) => !x.status.confirmed).reduce((s, x) => s + x.value, 0),
  };
}

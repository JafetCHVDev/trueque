// NEAR access: contract views over RPC, and a Session that signs calls either
// through a real wallet (near-connect: HOT, Meteor, MyNearWallet, Intear...)
// or a guest testnet account created in the browser for instant demos.

import { NearConnector } from "@hot-labs/near-connect";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { CONTRACT, FAUCET_HELPER, NEAR_NETWORK, NEAR_RPC } from "./config";

export const provider = new JsonRpcProvider({ url: NEAR_RPC });

export type Status = "Deriving" | "Open" | "Taken" | "Settled" | "Cancelled" | "Failed";

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
}

export interface SettlementView {
  kind: "Release" | "Refund";
  inputs: Utxo[];
  outputs: { address: string | null; value: number }[];
  fee_sats: number;
  signed: number;
  total: number;
  txid: string;
  raw_tx: string | null;
}

export interface Offer {
  id: number;
  maker: string;
  sats: number;
  price: string;
  maker_address: string;
  deposit_address: string | null;
  derivation_path: string;
  status: Status;
  created_ms: number;
  taker: string | null;
  taker_address: string | null;
  settlements: SettlementView[];
}

export interface Config {
  owner: string;
  mpc_contract: string;
  network: string;
  fee_bps: number;
  offer_bond: string;
  offers: number;
  trades: number;
  volume_sats: number;
  volume_near: string;
}

export const view = <T,>(method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId: CONTRACT, method, args }) as Promise<T>;

export const getOffer = (id: number) => view<Offer | null>("get_offer", { id });
export const listOffers = (status?: Status, limit = 100) => view<Offer[]>("list_offers", { status: status ?? null, limit });
export const getConfig = () => view<Config>("get_config");

// ------------------------------------------------------------------ sessions

export interface Session {
  kind: "guest" | "wallet";
  accountId: string;
  call(method: string, args: Record<string, unknown>, deposit?: bigint, gas?: bigint): Promise<string | undefined>;
  balance(): Promise<bigint>;
  signOut(): Promise<void>;
}

const balanceOf = async (accountId: string) => {
  const a = new Account(accountId, provider);
  return (await a.getBalance()) as bigint;
};

// ---- guest

const GUEST_KEY = "trueque.guest.v1";

function guestFromStorage(): Session | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    if (!raw) return null;
    const { accountId, secret } = JSON.parse(raw);
    return guestSession(accountId, secret);
  } catch {
    return null;
  }
}

function guestSession(accountId: string, secret: string): Session {
  const account = new Account(accountId, provider, secret as KeyPairString);
  return {
    kind: "guest",
    accountId,
    async call(methodName, args, deposit = 0n, gas = 100_000_000_000_000n) {
      const r = await account.callFunctionRaw({ contractId: CONTRACT, methodName, args, deposit, gas });
      const failure = (r.status as { Failure?: unknown }).Failure;
      if (failure) throw new Error(describeFailure(failure));
      for (const o of r.receipts_outcome) {
        const f = (o.outcome.status as { Failure?: unknown }).Failure;
        if (f && o.outcome.executor_id === CONTRACT) throw new Error(describeFailure(f));
      }
      return r.transaction.hash;
    },
    balance: () => balanceOf(accountId),
    async signOut() {
      try {
        localStorage.removeItem(GUEST_KEY);
      } catch {
        /* storage blocked */
      }
    },
  };
}

function describeFailure(f: unknown): string {
  const s = JSON.stringify(f);
  const m = s.match(/Smart contract panicked: ([^"\\]+)/);
  return m ? m[1] : s.slice(0, 300);
}

export async function createGuest(): Promise<Session> {
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = `trueque-guest-${Math.random().toString(36).slice(2, 9)}.testnet`;
  const res = await fetch(FAUCET_HELPER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`Testnet faucet refused: ${res.status} ${await res.text()}`);
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify({ accountId, secret: kp.toString() }));
  } catch {
    /* storage blocked: the guest lives for this tab only */
  }
  // The faucet account becomes visible to RPC a moment later.
  for (let i = 0; i < 20; i++) {
    try {
      await balanceOf(accountId);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return guestSession(accountId, kp.toString());
}

// ---- wallet

let connector: NearConnector | null = null;
function getConnector() {
  connector ??= new NearConnector({ network: NEAR_NETWORK, footerBranding: null });
  return connector;
}

function walletSession(accountId: string): Session {
  return {
    kind: "wallet",
    accountId,
    async call(methodName, args, deposit = 0n, gas = 100_000_000_000_000n) {
      const wallet = await getConnector().wallet();
      const outcome = await wallet.signAndSendTransaction({
        receiverId: CONTRACT,
        actions: [{ type: "FunctionCall", params: { methodName, args, gas: gas.toString(), deposit: deposit.toString() } }],
      });
      const failure = (outcome?.status as { Failure?: unknown } | undefined)?.Failure;
      if (failure) throw new Error(describeFailure(failure));
      return outcome?.transaction?.hash;
    },
    balance: () => balanceOf(accountId),
    async signOut() {
      await getConnector().disconnect();
    },
  };
}

export async function connectWallet(): Promise<Session> {
  const c = getConnector();
  const wallet = await c.connect();
  const [acc] = await wallet.getAccounts();
  return walletSession(acc.accountId);
}

export async function restoreSession(): Promise<Session | null> {
  const guest = guestFromStorage();
  if (guest) return guest;
  try {
    const { accounts } = await getConnector().getConnectedWallet();
    if (accounts[0]) return walletSession(accounts[0].accountId);
  } catch {
    /* not connected */
  }
  return null;
}

// ------------------------------------------------------------------ format

export const YOCTO = 10n ** 24n;

export function toYocto(near: string): bigint {
  const [w, f = ""] = near.trim().split(".");
  return BigInt(w || "0") * YOCTO + BigInt((f + "0".repeat(24)).slice(0, 24) || "0");
}

export function formatNear(yocto: string | bigint, digits = 4): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

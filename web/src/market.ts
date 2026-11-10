import { useCallback, useEffect, useRef, useState } from "react";
import { getUtxos, type EsploraUtxo } from "./btc";
import { getConfig, listOffers, type Config, type Offer } from "./near";

export interface Funding {
  utxos: EsploraUtxo[];
  confirmed: number;
  pending: number;
}

export interface MarketOffer extends Offer {
  funding?: Funding;
}

export const fundedTotal = (f?: Funding) => (f ? f.confirmed + f.pending : 0);

export async function fundingOf(address: string): Promise<Funding> {
  const utxos = await getUtxos(address);
  return {
    utxos,
    confirmed: utxos.filter((u) => u.status.confirmed).reduce((s, u) => s + u.value, 0),
    pending: utxos.filter((u) => !u.status.confirmed).reduce((s, u) => s + u.value, 0),
  };
}

/** Funding that cannot change any more: confirmed and covering the offer.
 * Only the contract can spend from an escrow, so it stays until settlement. */
const settledFunding = new Map<string, Funding>();
const lastChecked = new Map<string, number>();
const RECHECK_MS = 60_000;

/** Funding of an escrow, hitting the Bitcoin APIs only when it can still change. */
export async function cachedFunding(address: string, sats: number, force = false): Promise<Funding | undefined> {
  const done = settledFunding.get(address);
  if (done) return done;
  if (!force && Date.now() - (lastChecked.get(address) ?? 0) < RECHECK_MS) return undefined;
  lastChecked.set(address, Date.now());
  const f = await fundingOf(address);
  if (f.confirmed >= sats) settledFunding.set(address, f);
  return f;
}

/** All offers (newest first) plus the BTC funding of the open ones. Polls
 * while the tab is visible, sparing the public Bitcoin APIs. */
export function useMarket(intervalMs = 20_000) {
  const [offers, setOffers] = useState<MarketOffer[] | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const funding = useRef(new Map<number, Funding>());

  const refresh = useCallback(async () => {
    if (document.visibilityState === "hidden") return;
    try {
      const [all, cfg] = await Promise.all([listOffers(undefined, 100), getConfig()]);
      setConfig(cfg);
      const open = all.filter((o) => o.status === "Open" && o.deposit_address);
      await Promise.all(
        open.map(async (o) => {
          try {
            const f = await cachedFunding(o.deposit_address!, o.sats);
            if (f) funding.current.set(o.id, f);
          } catch {
            /* keep last known */
          }
        }),
      );
      setOffers(all.map((o) => ({ ...o, funding: funding.current.get(o.id) })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, intervalMs);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh, intervalMs]);

  return { offers, config, error, refresh };
}

export interface Reference {
  nearPerBtc: number;
  usdPerBtc: number;
}

/** Reference BTC price from a public market feed, for context only. */
export function useReferenceRate(): Reference | null {
  const [ref, setRef] = useState<Reference | null>(null);
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,near&vs_currencies=usd")
      .then((r) => r.json())
      .then((j) => {
        const btc = j?.bitcoin?.usd;
        const near = j?.near?.usd;
        if (btc && near) setRef({ nearPerBtc: btc / near, usdPerBtc: btc });
      })
      .catch(() => {});
  }, []);
  return ref;
}

/** Reference BTC price in the offer's own currency (USDC tracks USD). */
export const refFor = (ref: Reference | null, token: string | null) => (ref ? (token ? ref.usdPerBtc : ref.nearPerBtc) : null);

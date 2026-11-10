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

/** All offers (newest first) plus the live BTC funding of the open ones. Polls. */
export function useMarket(intervalMs = 15_000) {
  const [offers, setOffers] = useState<MarketOffer[] | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const funding = useRef(new Map<number, Funding>());

  const refresh = useCallback(async () => {
    try {
      const [all, cfg] = await Promise.all([listOffers(undefined, 100), getConfig()]);
      setConfig(cfg);
      const open = all.filter((o) => o.status === "Open" && o.deposit_address);
      await Promise.all(
        open.map(async (o) => {
          try {
            funding.current.set(o.id, await fundingOf(o.deposit_address!));
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
    return () => clearInterval(t);
  }, [refresh, intervalMs]);

  return { offers, config, error, refresh };
}

/** Reference BTC price in NEAR from a public market feed, for context only. */
export function useReferenceRate() {
  const [nearPerBtc, setRate] = useState<number | null>(null);
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,near&vs_currencies=usd")
      .then((r) => r.json())
      .then((j) => {
        const btc = j?.bitcoin?.usd;
        const near = j?.near?.usd;
        if (btc && near) setRate(btc / near);
      })
      .catch(() => {});
  }, []);
  return nearPerBtc;
}

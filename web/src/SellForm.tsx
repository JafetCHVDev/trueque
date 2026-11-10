import { useState } from "react";
import { fmtSats, isSignetAddress, loadBtcWallet } from "./btc";
import { GAS_DEFAULT } from "./config";
import { useReferenceRate } from "./market";
import { listOffers, toYocto, type Session } from "./near";
import { ErrorNote, Spinner } from "./ui";

export function SellForm({ session, onCreated, onConnect }: { session: Session | null; onCreated: (id: number) => void; onConnect: () => void }) {
  const ref = useReferenceRate();
  const [sats, setSats] = useState("2000");
  const [price, setPrice] = useState("0.25");
  const [refund, setRefund] = useState(() => loadBtcWallet()?.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const satsN = Number(sats);
  const priceN = Number(price);
  const implied = satsN > 0 && priceN > 0 ? priceN / (satsN / 1e8) : null;
  const premium = implied && ref ? (implied / ref - 1) * 100 : null;
  const valid = Number.isInteger(satsN) && satsN >= 1000 && priceN > 0 && isSignetAddress(refund);

  async function create() {
    if (!session) return onConnect();
    setBusy(true);
    setError(null);
    try {
      await session.call("create_offer", { sats: satsN, price: toYocto(price).toString(), refund_address: refund.trim() }, toYocto("0.02"), GAS_DEFAULT);
      const mine = (await listOffers(undefined, 20)).find((o) => o.maker === session.accountId);
      if (mine) onCreated(mine.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card sell">
      <div className="grid2">
        <label className="field">
          <span>Amount to sell (sats)</span>
          <input inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value.replace(/[^\d]/g, ""))} />
          <span className="muted small">Minimum 1,000 sats</span>
        </label>
        <label className="field">
          <span>Price (NEAR)</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))} />
          <span className="muted small">
            {implied ? `${implied.toLocaleString("en-US", { maximumFractionDigits: 0 })} NEAR per BTC` : " "}
            {premium !== null && (
              <>
                {" · "}
                <span className={premium > 0 ? "warn-text" : "ok-text"}>
                  {premium > 0 ? "+" : ""}
                  {premium.toFixed(1)}% vs market
                </span>
                {" · "}
                <button type="button" className="link-btn" onClick={() => setPrice(((ref! * satsN) / 1e8).toFixed(4))}>
                  use market
                </button>
              </>
            )}
          </span>
        </label>
      </div>
      <label className="field">
        <span>Your Bitcoin signet address (for refunds and change)</span>
        <input className="mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="tb1q…" spellCheck={false} />
        {!refund && (
          <button type="button" className="link-btn" onClick={() => setRefund(loadBtcWallet(true)!.address)}>
            Use an in-browser signet wallet
          </button>
        )}
      </label>
      <p className="muted small">
        After you open the offer, NEAR Chain Signatures derives a fresh Bitcoin address that only this contract can spend from.
        You deposit {satsN >= 1000 ? fmtSats(satsN) : "the"} sats there. A 0.02 NEAR anti-spam bond is returned when the offer closes.
      </p>
      <ErrorNote error={error} />
      <button className="btn primary wide" disabled={busy || (!!session && !valid)} onClick={create}>
        {busy ? (
          <>
            <Spinner /> Deriving your deposit address…
          </>
        ) : session ? (
          "Open offer"
        ) : (
          "Sign in to sell"
        )}
      </button>
    </div>
  );
}

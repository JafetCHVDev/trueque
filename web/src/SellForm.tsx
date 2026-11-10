import { useEffect, useRef, useState } from "react";
import { fmtSats, isTestnetAddress, loadBtcWallet } from "./btc";
import { GAS_DEFAULT, USDC_TOKEN } from "./config";
import { useReferenceRate } from "./market";
import { listOffers, toUsdcUnits, toYocto, usdcRegistered, type Session } from "./near";
import { ErrorNote, Spinner } from "./ui";

type Currency = "NEAR" | "USDC";

export function SellForm({ session, onCreated, onConnect }: { session: Session | null; onCreated: (id: number) => void; onConnect: () => void }) {
  const ref = useReferenceRate();
  const [currency, setCurrency] = useState<Currency>("USDC");
  const [sats, setSats] = useState("2000");
  const [price, setPrice] = useState("2");
  const [refund, setRefund] = useState(() => loadBtcWallet()?.address ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const touched = useRef(false);
  useEffect(() => {
    // Start at the market price once the reference loads, unless the user typed one.
    if (ref && !touched.current) setPrice(((ref.usdPerBtc * Number(sats)) / 1e8).toFixed(2));
  }, [ref]);

  const satsN = Number(sats);
  const priceN = Number(price);
  const refRate = ref ? (currency === "USDC" ? ref.usdPerBtc : ref.nearPerBtc) : null;
  const implied = satsN > 0 && priceN > 0 ? priceN / (satsN / 1e8) : null;
  const premium = implied && refRate ? (implied / refRate - 1) * 100 : null;
  const valid = Number.isInteger(satsN) && satsN >= 1000 && priceN > 0 && isTestnetAddress(refund);

  function switchTo(c: Currency) {
    setCurrency(c);
    const r = ref ? (c === "USDC" ? ref.usdPerBtc : ref.nearPerBtc) : null;
    if (r && satsN > 0) setPrice(((r * satsN) / 1e8).toFixed(c === "USDC" ? 2 : 4));
  }

  async function create() {
    if (!session) return onConnect();
    setError(null);
    try {
      if (currency === "USDC" && !(await usdcRegistered(session.accountId))) {
        // The payout is an ft_transfer to the seller, who must be registered with the token.
        setBusy("Registering you with the USDC token…");
        await session.call("storage_deposit", { account_id: session.accountId, registration_only: true }, toYocto("0.0125"), GAS_DEFAULT, USDC_TOKEN);
      }
      setBusy("Deriving your escrow address with Chain Signatures…");
      await session.call(
        "create_offer",
        {
          sats: satsN,
          price: (currency === "USDC" ? toUsdcUnits(price) : toYocto(price)).toString(),
          refund_address: refund.trim(),
          token: currency === "USDC" ? USDC_TOKEN : null,
        },
        toYocto("0.02"),
        GAS_DEFAULT,
      );
      const mine = (await listOffers(undefined, 20)).find((o) => o.maker === session.accountId);
      if (mine) onCreated(mine.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card sell">
      <div className="segmented" role="radiogroup" aria-label="Price currency">
        {(["USDC", "NEAR"] as Currency[]).map((c) => (
          <button key={c} type="button" role="radio" aria-checked={currency === c} className={currency === c ? "on" : ""} onClick={() => switchTo(c)}>
            Get paid in {c}
          </button>
        ))}
      </div>
      <div className="grid2">
        <label className="field">
          <span>Amount to sell (sats)</span>
          <input inputMode="numeric" value={sats} onChange={(e) => setSats(e.target.value.replace(/[^\d]/g, ""))} />
          <span className="muted small">Minimum 1,000 sats</span>
        </label>
        <label className="field">
          <span>Price ({currency})</span>
          <input inputMode="decimal" value={price} onChange={(e) => {
              touched.current = true;
              setPrice(e.target.value.replace(/[^\d.]/g, ""));
            }} />
          <span className="muted small">
            {implied ? `${implied.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${currency} per BTC` : " "}
            {premium !== null && (
              <>
                {" · "}
                <span className={premium > 0 ? "warn-text" : "ok-text"}>
                  {premium > 0 ? "+" : ""}
                  {premium.toFixed(1)}% vs market
                </span>
                {" · "}
                <button type="button" className="link-btn" onClick={() => setPrice(((refRate! * satsN) / 1e8).toFixed(currency === "USDC" ? 2 : 4))}>
                  use market
                </button>
              </>
            )}
          </span>
        </label>
      </div>
      <label className="field">
        <span>Your Bitcoin testnet address (for refunds and change)</span>
        <input className="mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="tb1q…" spellCheck={false} />
        {!refund && (
          <button type="button" className="link-btn" onClick={() => setRefund(loadBtcWallet(true)!.address)}>
            Use an in-browser testnet wallet
          </button>
        )}
      </label>
      <p className="muted small">
        After you open the offer, NEAR Chain Signatures derives a fresh Bitcoin address that only this contract can spend from.
        You deposit {satsN >= 1000 ? fmtSats(satsN) : "the"} sats there. A 0.02 NEAR anti-spam bond is returned when the offer
        closes{currency === "USDC" ? "; USDC offers use test USDC on testnet" : ""}.
      </p>
      <ErrorNote error={error} />
      <button className="btn primary wide" disabled={!!busy || (!!session && !valid)} onClick={create}>
        {busy ? (
          <>
            <Spinner /> {busy}
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

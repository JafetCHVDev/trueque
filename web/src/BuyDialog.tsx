import { useEffect, useMemo, useState } from "react";
import { feeFor, feeRate, fmtSats, isSignetAddress, loadBtcWallet, satsToBtc } from "./btc";
import { CONTRACT, GAS_TAKE, USDC_TOKEN } from "./config";
import { fundedTotal, type MarketOffer } from "./market";
import { formatUsdc, priceLabel, usdcBalance, type Session } from "./near";
import { ErrorNote, Modal, Pill, Spinner } from "./ui";

export function BuyDialog({
  offer,
  session,
  onClose,
  onTaken,
}: {
  offer: MarketOffer;
  session: Session;
  onClose: () => void;
  onTaken: (id: number) => void;
}) {
  const [address, setAddress] = useState(() => loadBtcWallet()?.address ?? "");
  const [rate, setRate] = useState(1);
  const [acceptUnconfirmed, setAcceptUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [usdc, setUsdc] = useState<bigint | null>(null);
  const isToken = !!offer.token;

  const loadUsdc = () => usdcBalance(session.accountId).then(setUsdc, () => setUsdc(0n));
  useEffect(() => {
    feeRate().then(setRate);
    if (isToken) loadUsdc();
  }, []);
  const short_ = isToken && usdc !== null && usdc < BigInt(offer.price);

  const f = offer.funding;
  const confirmedUtxos = (f?.utxos ?? []).filter((u) => u.status.confirmed);
  const useUtxos = useMemo(() => {
    const confirmedTotal = confirmedUtxos.reduce((s, u) => s + u.value, 0);
    if (confirmedTotal >= offer.sats) return confirmedUtxos;
    return acceptUnconfirmed ? f?.utxos ?? [] : confirmedUtxos;
  }, [f, confirmedUtxos, acceptUnconfirmed, offer.sats]);
  const total = useUtxos.reduce((s, u) => s + u.value, 0);
  const pendingNeeded = confirmedUtxos.reduce((s, u) => s + u.value, 0) < offer.sats && fundedTotal(f) >= offer.sats;
  const change = total - offer.sats;
  const fee = feeFor(Math.max(1, useUtxos.length), change >= 546 ? 2 : 1, rate);
  const receive = offer.sats - fee;
  const addrOk = isSignetAddress(address);
  const covered = total >= offer.sats && useUtxos.length > 0 && useUtxos.length <= 4;

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const take = {
        id: offer.id,
        btc_address: address.trim(),
        utxos: useUtxos.map(({ txid, vout, value }) => ({ txid, vout, value })),
        fee_sats: fee,
      };
      if (isToken) {
        // Stablecoin: the token transfers the price to Trueque and calls ft_on_transfer.
        await session.call(
          "ft_transfer_call",
          { receiver_id: CONTRACT, amount: offer.price, msg: JSON.stringify(take) },
          1n,
          GAS_TAKE,
          offer.token!,
        );
      } else {
        await session.call("take_offer", take, BigInt(offer.price), GAS_TAKE);
      }
      onTaken(offer.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Buy offer #${offer.id}`} onClose={onClose}>
      <div className="buy-summary">
        <div>
          <span className="label">You pay</span>
          <strong className={`big ${isToken ? "usdc" : "near"}`}>{priceLabel(offer)}</strong>
        </div>
        <span className="arrow" aria-hidden>
          →
        </span>
        <div>
          <span className="label">You receive</span>
          <strong className="big btc">{fmtSats(Math.max(0, receive))} sats</strong>
          <span className="muted small">{satsToBtc(Math.max(0, receive))} sBTC</span>
        </div>
      </div>

      <label className="field">
        <span>Your Bitcoin signet address</span>
        <input
          className="mono"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="tb1q…"
          spellCheck={false}
          autoComplete="off"
        />
        {!address && (
          <button type="button" className="link-btn" onClick={() => setAddress(loadBtcWallet(true)!.address)}>
            Create an in-browser signet wallet for me
          </button>
        )}
        {address && !addrOk && <span className="error small">Enter a signet segwit address (tb1…)</span>}
      </label>

      <dl className="facts">
        <div>
          <dt>Deposit at the offer address</dt>
          <dd>
            {fmtSats(fundedTotal(f))} sats {f && f.pending > 0 ? <Pill tone="warn">{fmtSats(f.pending)} unconfirmed</Pill> : <Pill tone="ok">confirmed</Pill>}
          </dd>
        </div>
        <div>
          <dt>Bitcoin miner fee</dt>
          <dd>
            {fmtSats(fee)} sats <span className="muted">({rate} sat/vB)</span>
          </dd>
        </div>
        {change >= 546 && (
          <div>
            <dt>Change back to the seller</dt>
            <dd>{fmtSats(change)} sats</dd>
          </div>
        )}
        {isToken && (
          <div>
            <dt>Your test USDC</dt>
            <dd>
              {usdc === null ? "…" : `${formatUsdc(usdc)} USDC`}{" "}
              {short_ && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={async () => {
                    try {
                      await session.call("faucet", {}, 0n, 30_000_000_000_000n, USDC_TOKEN);
                      await loadUsdc();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  Get 100 test USDC
                </button>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>Settlement</dt>
          <dd>Atomic: your {isToken ? "USDC" : "NEAR"} only reaches the seller once NEAR MPC has signed your BTC payout.</dd>
        </div>
      </dl>

      {pendingNeeded && (
        <label className="check">
          <input type="checkbox" checked={acceptUnconfirmed} onChange={(e) => setAcceptUnconfirmed(e.target.checked)} />
          <span>
            Part of the deposit is still unconfirmed. Until it confirms, the seller could replace that deposit. Accept the risk to
            buy now, or wait for a block.
          </span>
        </label>
      )}

      <ErrorNote error={error} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!addrOk || !covered || busy || receive < 546 || short_} onClick={buy}>
          {busy ? (
            <>
              <Spinner /> Confirming…
            </>
          ) : (
            `Pay ${priceLabel(offer)}`
          )}
        </button>
      </div>
    </Modal>
  );
}

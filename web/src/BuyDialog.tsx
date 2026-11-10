import { useEffect, useState } from "react";
import { feeFor, feeRate, fmtSats, isTestnetAddress, loadBtcWallet, satsToBtc } from "./btc";
import { CONTRACT, GAS_TAKE, USDC_TOKEN } from "./config";
import { fundedTotal, type MarketOffer } from "./market";
import { formatUsdc, priceLabel, usdcBalance, type Session } from "./near";
import { depositProof } from "./spv";
import { ErrorNote, Modal, Pill, Spinner } from "./ui";

const MAX_DEPOSITS = 2;

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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const isToken = !!offer.token;

  const loadUsdc = () => usdcBalance(session.accountId).then(setUsdc, () => setUsdc(0n));
  useEffect(() => {
    feeRate().then(setRate);
    if (isToken) loadUsdc();
  }, []);

  const f = offer.funding;
  // Only confirmed deposits can be proven to the light client; largest first.
  const confirmed = (f?.utxos ?? []).filter((u) => u.status.confirmed).sort((a, b) => b.value - a.value);
  const use: typeof confirmed = [];
  for (const u of confirmed) {
    if (use.reduce((s, x) => s + x.value, 0) >= offer.sats || use.length >= MAX_DEPOSITS) break;
    use.push(u);
  }
  const total = use.reduce((s, u) => s + u.value, 0);
  const covered = total >= offer.sats;
  const waitingForBlock = !covered && fundedTotal(f) >= offer.sats;
  const change = total - offer.sats;
  const fee = feeFor(Math.max(1, use.length), change >= 546 ? 2 : 1, rate);
  const receive = offer.sats - fee;
  const addrOk = isTestnetAddress(address);
  const shortUsdc = isToken && usdc !== null && usdc < BigInt(offer.price);

  async function buy() {
    setError(null);
    try {
      setBusy("Building the SPV proof of the deposit…");
      const deposits = await Promise.all(use.map((u) => depositProof(u.txid, u.vout)));
      const take = { id: offer.id, btc_address: address.trim(), deposits, fee_sats: fee };
      setBusy("Paying; the NEAR Bitcoin light client checks the proof…");
      if (isToken) {
        // The token sends the price to Trueque and calls ft_on_transfer. If the
        // proof fails, the token returns the whole amount.
        await session.call("ft_transfer_call", { receiver_id: CONTRACT, amount: offer.price, msg: JSON.stringify(take) }, 1n, GAS_TAKE, offer.token!);
      } else {
        await session.call("take_offer", take, BigInt(offer.price), GAS_TAKE);
      }
      onTaken(offer.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
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
          <span className="muted small">{satsToBtc(Math.max(0, receive))} tBTC</span>
        </div>
      </div>

      <label className="field">
        <span>Your Bitcoin testnet address</span>
        <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="tb1q…" spellCheck={false} autoComplete="off" />
        {!address && (
          <button type="button" className="link-btn" onClick={() => setAddress(loadBtcWallet(true)!.address)}>
            Create an in-browser testnet wallet for me
          </button>
        )}
        {address && !addrOk && <span className="error small">Enter a testnet segwit address (tb1…)</span>}
      </label>

      <dl className="facts">
        <div>
          <dt>Deposit at the escrow</dt>
          <dd>
            {fmtSats(fundedTotal(f))} sats{" "}
            {covered ? <Pill tone="ok">confirmed</Pill> : <Pill tone="warn">waiting for a block</Pill>}
          </dd>
        </div>
        <div>
          <dt>Deposit check</dt>
          <dd>On chain, by the NEAR Bitcoin light client (SPV proof, at least 1 confirmation)</dd>
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
              {shortUsdc && (
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
          <dt>If something fails</dt>
          <dd>A rejected proof returns your payment at once; unsigned payouts can be reclaimed after an hour.</dd>
        </div>
      </dl>

      {waitingForBlock && (
        <p className="muted small">
          The seller's deposit is in the mempool. Once it is in a block, the contract can verify it and you can buy.
        </p>
      )}

      <ErrorNote error={error} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!addrOk || !covered || !!busy || receive < 546 || shortUsdc} onClick={buy}>
          {busy ? (
            <>
              <Spinner /> {busy}
            </>
          ) : (
            `Pay ${priceLabel(offer)}`
          )}
        </button>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useState } from "react";
import { balanceOf, broadcast, feeFor, feeRate, fmtSats, loadBtcWallet, satsToBtc, short, txStatus } from "./btc";
import { BuyDialog } from "./BuyDialog";
import { BTC_EXPLORER, CONTRACT, MPC_CONTRACT, NEAR_EXPLORER } from "./config";
import { fundedTotal, fundingOf, type Funding } from "./market";
import { getOffer, priceLabel, priceValue, type Offer, type Session, type SettlementView } from "./near";
import { Copy, ErrorNote, Ext, Pill, Qr, Spinner, timeAgo } from "./ui";

type TxState = { found: boolean; confirmed: boolean; block_height?: number };

export function OfferPage({ id, session, onConnect }: { id: number; session: Session | null; onConnect: () => void }) {
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);
  const [funding, setFunding] = useState<Funding | undefined>();
  const [txs, setTxs] = useState<Record<string, TxState>>({});
  const [buying, setBuying] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const o = await getOffer(id).catch(() => undefined);
    if (o === undefined) return;
    setOffer(o);
    if (!o) return;
    if (o.deposit_address) fundingOf(o.deposit_address).then(setFunding, () => {});
    for (const st of o.settlements) {
      if (!st.raw_tx) continue;
      let s = await txStatus(st.txid);
      if (!s.found) {
        // Anyone can broadcast a signed settlement; the page does it for you.
        try {
          await broadcast(st.raw_tx);
          s = await txStatus(st.txid);
        } catch {
          /* parent not visible yet: retried on the next poll */
        }
      }
      setTxs((prev) => ({ ...prev, [st.txid]: s }));
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  if (offer === undefined) return <div className="page center"><Spinner /></div>;
  if (offer === null) return <div className="page center"><p>Offer #{id} does not exist.</p></div>;

  const me = session?.accountId;
  const isMaker = me === offer.maker;
  const release = offer.settlements.find((s) => s.kind === "Release");
  const refunds = offer.settlements.filter((s) => s.kind === "Refund");
  const funded = fundedTotal(funding);
  const usedOutpoints = new Set(offer.settlements.flatMap((s) => s.inputs.map((i) => `${i.txid}:${i.vout}`)));
  const leftovers = (funding?.utxos ?? []).filter((u) => !usedOutpoints.has(`${u.txid}:${u.vout}`));
  const guestBtc = loadBtcWallet();

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const refundArgs = async (utxos: { txid: string; vout: number; value: number }[]) => ({
    id: offer.id,
    utxos: utxos.map(({ txid, vout, value }) => ({ txid, vout, value })),
    fee_sats: utxos.length ? feeFor(utxos.length, 1, await feeRate()) : 0,
  });

  return (
    <div className="page offer-page">
      <a href="#/" className="back">
        ← Market
      </a>
      <header className="offer-head">
        <div>
          <p className="eyebrow">Offer #{offer.id}</p>
          <h1>
            <span className="btc">{fmtSats(offer.sats)} sats</span> <span className="muted">for</span>{" "}
            <span className={offer.token ? "usdc" : "near"}>{priceLabel(offer)}</span>
          </h1>
          <p className="muted">
            {satsToBtc(offer.sats)} sBTC · {(priceValue(offer) / (offer.sats / 1e8)).toLocaleString("en-US", { maximumFractionDigits: 0 })} {offer.token ? "USDC" : "NEAR"} per BTC · by{" "}
            <span className="mono">{offer.maker}</span> · {timeAgo(offer.created_ms)}
          </p>
        </div>
        <StatusPill status={offer.status} />
      </header>

      <div className="offer-grid">
        <ol className="timeline">
          <Step
            done={!!offer.deposit_address}
            active={offer.status === "Deriving"}
            title="Deposit address derived by NEAR Chain Signatures"
          >
            {offer.deposit_address ? (
              <>
                <p>
                  Key path <code>{offer.derivation_path}</code> of <code>{CONTRACT}</code> on the MPC network{" "}
                  <code>{MPC_CONTRACT}</code>. No person holds this key; it signs only what the contract asks.
                </p>
                <div className="deposit">
                  <Qr value={`bitcoin:${offer.deposit_address}?amount=${satsToBtc(offer.sats)}`} size={132} />
                  <div>
                    <span className="label">Escrow address</span>
                    <Copy text={offer.deposit_address} />
                    <Ext href={`${BTC_EXPLORER}/address/${offer.deposit_address}`}>View on mempool</Ext>
                  </div>
                </div>
              </>
            ) : offer.status === "Failed" ? (
              <p className="error">Derivation failed; the bond was returned.</p>
            ) : (
              <p>Waiting for the MPC contract…</p>
            )}
          </Step>

          <Step done={funded >= offer.sats || !!release} active={offer.status === "Open" && funded < offer.sats} title="Seller deposits BTC into escrow">
            {release ? (
              <p>{fmtSats(release.inputs.reduce((s, i) => s + i.value, 0))} sats locked in {release.inputs.length} UTXO(s).</p>
            ) : (
              <>
                <p>
                  {fmtSats(funded)} / {fmtSats(offer.sats)} sats{" "}
                  {funding && funding.pending > 0 && <Pill tone="warn">{fmtSats(funding.pending)} unconfirmed</Pill>}
                  {funding && funding.confirmed >= offer.sats && <Pill tone="ok">confirmed</Pill>}
                </p>
                {isMaker && offer.status === "Open" && funded < offer.sats && guestBtc && (
                  <FundFromWallet address={offer.deposit_address!} need={offer.sats - funded} onDone={refresh} />
                )}
              </>
            )}
          </Step>

          <Step done={!!offer.taker} active={offer.status === "Open" && funded >= offer.sats} title={`Buyer pays ${offer.token ? "USDC" : "NEAR"} into the contract`}>
            {offer.taker ? (
              <p>
                <span className="mono">{offer.taker}</span> paid {priceLabel(offer)}. Payout to{" "}
                <span className="mono">{short(offer.taker_address ?? "", 10)}</span>.
              </p>
            ) : offer.status === "Open" ? (
              <p>Open for any buyer. The payment stays in the contract until the BTC payout is signed.</p>
            ) : (
              <p className="muted">Offer closed without a buyer.</p>
            )}
          </Step>

          {release && (
            <>
              <Step done={release.signed === release.total} active={release.signed < release.total} title="NEAR MPC signs the Bitcoin payout">
                <SettlementBody st={release} session={session} offerId={offer.id} busy={busy} act={act} />
              </Step>
              <Step done={!!txs[release.txid]?.confirmed} active={!!release.raw_tx && !txs[release.txid]?.confirmed} title="Native BTC lands in the buyer's wallet">
                <BroadcastBody st={release} tx={txs[release.txid]} />
              </Step>
            </>
          )}

          {refunds.map((st) => (
            <Step key={st.txid} done={!!txs[st.txid]?.confirmed} active={!txs[st.txid]?.confirmed} title="Refund to the seller">
              <SettlementBody st={st} session={session} offerId={offer.id} busy={busy} act={act} />
              {st.raw_tx && <BroadcastBody st={st} tx={txs[st.txid]} />}
            </Step>
          ))}
        </ol>

        <aside className="card actions">
          {offer.status === "Open" && !isMaker && (
            <>
              <h3>Buy this offer</h3>
              <p className="muted small">Pay in {offer.token ? "USDC" : "NEAR"}, receive native BTC on signet. No bridge, no wrapped token.</p>
              <button
                className="btn primary wide"
                disabled={funded < offer.sats}
                onClick={() => (session ? setBuying(true) : onConnect())}
              >
                {funded < offer.sats ? "Waiting for the deposit" : session ? `Buy for ${priceLabel(offer)}` : "Sign in to buy"}
              </button>
            </>
          )}
          {offer.status === "Open" && isMaker && (
            <>
              <h3>Your offer</h3>
              <p className="muted small">
                Cancel any time before someone buys it. Deposited BTC is signed back to{" "}
                <span className="mono">{short(offer.maker_address, 8)}</span>.
              </p>
              <button className="btn ghost wide" disabled={!!busy} onClick={() => act("cancel", async () => session!.call("cancel_offer", await refundArgs(funding?.utxos ?? [])))}>
                {busy === "cancel" ? <Spinner /> : funded ? "Cancel and refund my BTC" : "Cancel offer"}
              </button>
            </>
          )}
          {(offer.status === "Settled" || offer.status === "Cancelled") && isMaker && leftovers.length > 0 && offer.settlements.every((s) => s.signed === s.total) && (
            <>
              <h3>Extra BTC at the escrow</h3>
              <p className="muted small">{fmtSats(leftovers.reduce((s, u) => s + u.value, 0))} sats arrived after the offer closed.</p>
              <button className="btn ghost wide" disabled={!!busy} onClick={() => act("recover", async () => session!.call("recover", await refundArgs(leftovers)))}>
                {busy === "recover" ? <Spinner /> : "Recover to my address"}
              </button>
            </>
          )}
          {offer.status === "Settled" && (
            <>
              <h3>Settled</h3>
              <p className="muted small">The seller was paid the moment the BTC payout signature was verified on chain.</p>
            </>
          )}
          <ErrorNote error={error} />
          <dl className="facts compact">
            <div>
              <dt>Contract</dt>
              <dd>
                <Ext href={`${NEAR_EXPLORER}/address/${CONTRACT}`}>{CONTRACT}</Ext>
              </dd>
            </div>
            <div>
              <dt>Seller refund address</dt>
              <dd className="mono">{short(offer.maker_address, 10)}</dd>
            </div>
          </dl>
        </aside>
      </div>

      {buying && session && (
        <BuyDialog
          offer={{ ...offer, funding }}
          session={session}
          onClose={() => setBuying(false)}
          onTaken={() => {
            setBuying(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Offer["status"] }) {
  const tone = { Deriving: "neutral", Open: "btc", Taken: "near", Settled: "ok", Cancelled: "neutral", Failed: "bad" } as const;
  return <Pill tone={tone[status]}>{status}</Pill>;
}

function Step({ done, active, title, children }: { done: boolean; active?: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={`step ${done ? "done" : ""} ${active ? "active" : ""}`}>
      <span className="dot" aria-hidden>
        {done ? "✓" : active ? <Spinner /> : ""}
      </span>
      <div>
        <h4>{title}</h4>
        {children}
      </div>
    </li>
  );
}

function SettlementBody({
  st,
  session,
  offerId,
  busy,
  act,
}: {
  st: SettlementView;
  session: Session | null;
  offerId: number;
  busy: string | null;
  act: (l: string, f: () => Promise<unknown>) => void;
}) {
  return (
    <>
      <p>
        {st.signed}/{st.total} input signature(s). Each one is checked on chain with <code>ecrecover</code> against the offer's
        derived key before it is accepted.
      </p>
      <ul className="outs">
        {st.outputs.map((o, i) => (
          <li key={i}>
            <span className="mono">{short(o.address ?? "?", 10)}</span> <strong>{fmtSats(o.value)} sats</strong>
          </li>
        ))}
        <li className="muted">
          miner fee <strong>{fmtSats(st.fee_sats)} sats</strong>
        </li>
      </ul>
      {st.signed < st.total && session && (
        <button className="btn ghost small" disabled={!!busy} onClick={() => act("retry", () => session.call("retry_signatures", { id: offerId }))}>
          {busy === "retry" ? <Spinner /> : "Ask MPC again"}
        </button>
      )}
    </>
  );
}

function BroadcastBody({ st, tx }: { st: SettlementView; tx?: TxState }) {
  if (!st.raw_tx) return <p className="muted">Waiting for signatures.</p>;
  return (
    <>
      <p>
        {tx?.confirmed ? (
          <Pill tone="ok">confirmed in block {tx.block_height}</Pill>
        ) : tx?.found ? (
          <Pill tone="warn">in mempool</Pill>
        ) : (
          <Pill tone="neutral">broadcasting…</Pill>
        )}{" "}
        <Ext href={`${BTC_EXPLORER}/tx/${st.txid}`}>{short(st.txid, 10)}</Ext>
      </p>
      <details>
        <summary>Signed transaction (anyone can broadcast it)</summary>
        <Copy text={st.raw_tx} label={short(st.raw_tx, 24)} />
      </details>
    </>
  );
}

function FundFromWallet({ address, need, onDone }: { address: string; need: number; onDone: () => void }) {
  const w = loadBtcWallet()!;
  const [bal, setBal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    balanceOf(w.address).then((b) => setBal(b.confirmed + b.pending), () => {});
  }, [w.address]);
  return (
    <div className="fund">
      <p className="small muted">
        In-browser wallet <span className="mono">{short(w.address, 8)}</span>: {bal === null ? "…" : `${fmtSats(bal)} sats`}
      </p>
      <button
        className="btn primary small"
        disabled={busy || bal === null || bal < need}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await w.send(address, need);
            onDone();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : `Deposit ${fmtSats(need)} sats from it`}
      </button>
      <ErrorNote error={error} />
    </div>
  );
}

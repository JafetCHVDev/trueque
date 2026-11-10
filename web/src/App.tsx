import { useCallback, useEffect, useState } from "react";
import { balanceOf, fmtSats, loadBtcWallet, satsToBtc, short } from "./btc";
import { BuyDialog } from "./BuyDialog";
import { BTC_EXPLORER, CONTRACT, MPC_CONTRACT, NEAR_EXPLORER, REPO_URL } from "./config";
import { fundedTotal, refFor, useMarket, useReferenceRate, type MarketOffer, type Reference } from "./market";
import { connectWallet, createGuest, formatNear, formatUsdc, priceLabel, priceValue, restoreSession, type Session } from "./near";
import { OfferPage } from "./OfferPage";
import { SellForm } from "./SellForm";
import { Copy, ErrorNote, Ext, Modal, Pill, Spinner, timeAgo } from "./ui";

function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const f = () => {
      setHash(window.location.hash || "#/");
      if (!window.location.hash.startsWith("#how") && !window.location.hash.startsWith("#market")) window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return hash;
}

const go = (h: string) => (window.location.hash = h);

export default function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [signin, setSignin] = useState(false);
  const market = useMarket();

  useEffect(() => {
    restoreSession().then(setSession);
  }, []);

  const offerMatch = route.match(/^#\/offer\/(\d+)/);
  const openSignin = useCallback(() => setSignin(true), []);

  return (
    <>
      <Header session={session} onSignin={openSignin} onSignOut={async () => (await session?.signOut(), setSession(null))} />
      <main>
        {offerMatch ? (
          <OfferPage id={Number(offerMatch[1])} session={session} onConnect={openSignin} />
        ) : route.startsWith("#/sell") ? (
          <section className="page narrow">
            <p className="eyebrow">Sell Bitcoin</p>
            <h1>Open an offer</h1>
            <p className="lead">Name your amount and your price in USDC or NEAR. Buyers pay the contract; you are paid the moment their BTC payout is signed.</p>
            <SellForm session={session} onConnect={openSignin} onCreated={(id) => go(`#/offer/${id}`)} />
          </section>
        ) : route.startsWith("#/activity") ? (
          <Activity session={session} offers={market.offers} onSignin={openSignin} />
        ) : (
          <Home session={session} market={market} onSignin={openSignin} />
        )}
      </main>
      <Footer />
      {signin && (
        <SignIn
          onClose={() => setSignin(false)}
          onSession={(s) => {
            setSession(s);
            setSignin(false);
          }}
        />
      )}
    </>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="var(--logo-bg)" />
      <path d="M18 24h20l-6-6M46 40H26l6 6" fill="none" stroke="var(--btc)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="46" cy="24" r="4" fill="var(--near)" />
      <circle cx="18" cy="40" r="4" fill="var(--near)" />
    </svg>
  );
}

function Header({ session, onSignin, onSignOut }: { session: Session | null; onSignin: () => void; onSignOut: () => void }) {
  const [bal, setBal] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return setBal(null);
    const f = () => session.balance().then((b) => setBal(formatNear(b, 2)), () => {});
    f();
    const t = setInterval(f, 10_000);
    return () => clearInterval(t);
  }, [session]);
  return (
    <header className="top">
      <a href="#/" className="brand">
        <Logo />
        <span>Trueque</span>
      </a>
      <nav>
        <a href="#market">Market</a>
        <a href="#/sell">Sell</a>
        <a href="#/activity">Activity</a>
        <a href="#how">How it works</a>
      </nav>
      <div className="top-right">
        <Pill tone="neutral">testnet · signet</Pill>
        {session ? (
          <div className="account">
            <span className="mono small">{short(session.accountId, 10)}</span>
            {bal && <span className="small muted">{bal} NEAR</span>}
            <button className="link-btn small" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        ) : (
          <button className="btn primary small" onClick={onSignin}>
            Sign in
          </button>
        )}
      </div>
    </header>
  );
}

function SignIn({ onClose, onSession }: { onClose: () => void; onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (label: string, f: () => Promise<Session>) => {
    setBusy(label);
    setError(null);
    try {
      onSession(await f());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title="Sign in" onClose={onClose}>
      <div className="signin">
        <button className="option" disabled={!!busy} onClick={() => run("guest", createGuest)}>
          <strong>{busy === "guest" ? <Spinner /> : "⚡"} Instant guest account</strong>
          <span>A fresh NEAR testnet account with 10 test NEAR, created in this browser by the public faucet. Best for trying a trade in a minute.</span>
        </button>
        <button className="option" disabled={!!busy} onClick={() => run("wallet", connectWallet)}>
          <strong>{busy === "wallet" ? <Spinner /> : "◈"} Connect a NEAR wallet</strong>
          <span>HOT, Meteor, MyNearWallet, Intear and more, through near-connect. Testnet accounts only.</span>
        </button>
      </div>
      <ErrorNote error={error} />
    </Modal>
  );
}

function Home({ session, market, onSignin }: { session: Session | null; market: ReturnType<typeof useMarket>; onSignin: () => void }) {
  const { offers, config, error } = market;
  const ref = useReferenceRate();
  const [buying, setBuying] = useState<MarketOffer | null>(null);
  const open = (offers ?? []).filter((o) => o.status === "Open");
  const funded = open.filter((o) => fundedTotal(o.funding) >= o.sats).sort((a, b) => (premium(a, ref) ?? 0) - (premium(b, ref) ?? 0));
  const usdcVolume = config?.token_volume?.reduce((s, [, v]) => s + BigInt(v), 0n) ?? 0n;
  const waiting = open.filter((o) => fundedTotal(o.funding) < o.sats);
  const settled = (offers ?? []).filter((o) => o.status === "Settled").slice(0, 6);

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Peer to peer · native Bitcoin · NEAR Chain Signatures</p>
          <h1>
            Trade real Bitcoin for USDC or NEAR.
            <br />
            <span className="grad">No bridge. No wrapped BTC. No custodian.</span>
          </h1>
          <p className="lead">
            Every offer's BTC sits at its own Bitcoin address that only a NEAR smart contract can spend from, through the NEAR MPC
            network. Buyers pay in USDC or NEAR, and the contract signs the Bitcoin payout itself. Neither side has to trust the other.
          </p>
          <div className="hero-cta">
            <a className="btn primary" href="#market">
              Buy Bitcoin
            </a>
            <a className="btn ghost" href="#/sell">
              Sell Bitcoin
            </a>
          </div>
        </div>
        <div className="stats">
          <Stat label="Trades settled" value={config ? String(config.trades) : "…"} />
          <Stat label="BTC volume" value={config ? `${fmtSats(config.volume_sats)} sats` : "…"} />
          <Stat label="Paid in NEAR" value={config ? `${formatNear(config.volume_near, 2)} NEAR` : "…"} />
          <Stat label="Paid in USDC" value={config ? `${formatUsdc(usdcVolume)} USDC` : "…"} />
        </div>
      </section>

      <section id="market" className="page">
        <div className="section-head">
          <div>
            <p className="eyebrow">Market</p>
            <h2>Bitcoin for sale</h2>
          </div>
          {ref && (
            <span className="muted small">
              Reference: 1 BTC ≈ ${ref.usdPerBtc.toLocaleString("en-US", { maximumFractionDigits: 0 })} ≈{" "}
              {ref.nearPerBtc.toLocaleString("en-US", { maximumFractionDigits: 0 })} NEAR
            </span>
          )}
        </div>
        <ErrorNote error={error} />
        {!offers ? (
          <div className="center pad">
            <Spinner />
          </div>
        ) : funded.length === 0 ? (
          <div className="empty card">
            <p>No funded offers right now.</p>
            <a className="btn ghost small" href="#/sell">
              Open the first one
            </a>
          </div>
        ) : (
          <div className="offers">
            {funded.map((o) => (
              <OfferCard key={o.id} o={o} ref_={ref} me={session?.accountId} onBuy={() => (session ? setBuying(o) : onSignin())} />
            ))}
          </div>
        )}
        {waiting.length > 0 && (
          <details className="waiting">
            <summary>{waiting.length} offer(s) waiting for the seller's BTC deposit</summary>
            <div className="offers">
              {waiting.map((o) => (
                <OfferCard key={o.id} o={o} ref_={ref} me={session?.accountId} />
              ))}
            </div>
          </details>
        )}
      </section>

      {settled.length > 0 && (
        <section className="page">
          <p className="eyebrow">Recent trades</p>
          <h2>Settled on Bitcoin by a NEAR contract</h2>
          <ul className="recent">
            {settled.map((o) => {
              const r = o.settlements.find((s) => s.kind === "Release");
              return (
                <li key={o.id}>
                  <a href={`#/offer/${o.id}`}>#{o.id}</a>
                  <span className="btc">{fmtSats(o.sats)} sats</span>
                  <span className={o.token ? "usdc" : "near"}>{priceLabel(o)}</span>
                  <span className="mono small muted">{short(o.taker ?? "", 10)}</span>
                  {r && <Ext href={`${BTC_EXPLORER}/tx/${r.txid}`}>{short(r.txid, 6)}</Ext>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <HowItWorks />
      {buying && session && (
        <BuyDialog offer={buying} session={session} onClose={() => setBuying(null)} onTaken={(id) => go(`#/offer/${id}`)} />
      )}
    </>
  );
}

/** Price per BTC implied by an offer, in its own currency. */
const rate = (o: MarketOffer) => priceValue(o) / (o.sats / 1e8);

/** Percent above (+) or below (-) the reference price. */
function premium(o: MarketOffer, ref: Reference | null): number | null {
  const r = refFor(ref, o.token);
  return r ? (rate(o) / r - 1) * 100 : null;
}

function OfferCard({ o, ref_, me, onBuy }: { o: MarketOffer; ref_: Reference | null; me?: string; onBuy?: () => void }) {
  const r = rate(o);
  const prem = premium(o, ref_);
  const f = o.funding;
  return (
    <article className="offer card">
      <a href={`#/offer/${o.id}`} className="offer-main">
        <span className="btc big">{fmtSats(o.sats)} sats</span>
        <span className="muted small">{satsToBtc(o.sats)} sBTC</span>
      </a>
      <div className="offer-price">
        <span className={`big ${o.token ? "usdc" : "near"}`}>{priceLabel(o)}</span>
        <span className="muted small">
          {r.toLocaleString("en-US", { maximumFractionDigits: 0 })} {o.token ? "USDC" : "NEAR"}/BTC
          {prem !== null && (
            <span className={prem > 0 ? "warn-text" : "ok-text"}>
              {" "}
              · {prem > 0 ? "+" : ""}
              {prem.toFixed(1)}%
            </span>
          )}
        </span>
      </div>
      <div className="offer-meta">
        {f && f.confirmed >= o.sats ? (
          <Pill tone="ok">BTC locked · confirmed</Pill>
        ) : fundedTotal(f) >= o.sats ? (
          <Pill tone="warn">BTC locked · unconfirmed</Pill>
        ) : (
          <Pill tone="neutral">
            {fmtSats(fundedTotal(f))} / {fmtSats(o.sats)} deposited
          </Pill>
        )}
        <span className="muted small">
          {o.maker === me ? "your offer" : short(o.maker, 12)} · {timeAgo(o.created_ms)}
        </span>
      </div>
      {onBuy && o.maker !== me ? (
        <button className="btn primary" onClick={onBuy}>
          Buy
        </button>
      ) : (
        <a className="btn ghost" href={`#/offer/${o.id}`}>
          View
        </a>
      )}
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Activity({ session, offers, onSignin }: { session: Session | null; offers: MarketOffer[] | null; onSignin: () => void }) {
  const w = loadBtcWallet();
  const [btcBal, setBtcBal] = useState<{ confirmed: number; pending: number } | null>(null);
  useEffect(() => {
    if (w) balanceOf(w.address).then(setBtcBal, () => {});
  }, [w?.address]);
  if (!session)
    return (
      <section className="page narrow center">
        <h1>Your activity</h1>
        <button className="btn primary" onClick={onSignin}>
          Sign in
        </button>
      </section>
    );
  const mine = (offers ?? []).filter((o) => o.maker === session.accountId || o.taker === session.accountId);
  return (
    <section className="page">
      <p className="eyebrow">Activity</p>
      <h1>Your trades</h1>
      {w && (
        <div className="card wallet-card">
          <div>
            <span className="label">In-browser signet wallet</span>
            <Copy text={w.address} />
          </div>
          <div>
            <span className="label">Balance</span>
            <strong className="btc">{btcBal ? `${fmtSats(btcBal.confirmed + btcBal.pending)} sats` : "…"}</strong>
            {btcBal && btcBal.pending > 0 && <span className="muted small"> ({fmtSats(btcBal.pending)} unconfirmed)</span>}
          </div>
          <Ext href={`${BTC_EXPLORER}/address/${w.address}`}>mempool</Ext>
        </div>
      )}
      {mine.length === 0 ? (
        <div className="empty card">
          <p>No trades yet.</p>
          <a className="btn ghost small" href="#/">
            Browse the market
          </a>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Offer</th>
                <th>Role</th>
                <th>Amount</th>
                <th>Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((o) => (
                <tr key={o.id} onClick={() => go(`#/offer/${o.id}`)}>
                  <td>#{o.id}</td>
                  <td>{o.maker === session.accountId ? "Seller" : "Buyer"}</td>
                  <td className="btc">{fmtSats(o.sats)} sats</td>
                  <td className={o.token ? "usdc" : "near"}>{priceLabel(o)}</td>
                  <td>{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="page how">
      <p className="eyebrow">How it works</p>
      <h2>A NEAR contract that holds Bitcoin keys, without anyone holding them</h2>
      <Diagram />
      <div className="steps3">
        <div className="card">
          <span className="num">1</span>
          <h3>Escrow address from Chain Signatures</h3>
          <p>
            Opening an offer makes the contract ask the NEAR MPC network (<code>{MPC_CONTRACT}</code>) for the key derived from its
            own account and the path <code>trueque/&lt;salt&gt;/&lt;offer&gt;</code>. The P2WPKH address of that key is the escrow. The
            private key never exists in one place, and only <code>{CONTRACT}</code> can request signatures for it.
          </p>
        </div>
        <div className="card">
          <span className="num">2</span>
          <h3>The contract writes the Bitcoin transaction</h3>
          <p>
            When a buyer pays the NEAR price, the contract builds the payout transaction on chain: the deposit as inputs, the
            buyer's address (and change back to the seller) as outputs. It computes each BIP143 sighash itself and asks MPC to sign
            them. The buyer cannot redirect the coins, and the seller cannot take them back.
          </p>
        </div>
        <div className="card">
          <span className="num">3</span>
          <h3>Verified, then settled</h3>
          <p>
            Each returned signature is checked on chain with <code>ecrecover</code> against the derived key. Only when every input is
            signed does the contract pay the seller. The signed transaction is stored in the contract, so anyone can broadcast it;
            this site does it for you.
          </p>
        </div>
      </div>
      <div className="card trust">
        <h3>What you are trusting</h3>
        <ul>
          <li>
            <strong>The NEAR MPC network</strong> to sign only what the contract requests (threshold ECDSA across independent
            nodes).
          </li>
          <li>
            <strong>The open source contract</strong>: once an offer is taken it can only ever produce a payout to the buyer; before
            that, only a refund to the seller. Coins used by one settlement can never be signed again.
          </li>
          <li>
            <strong>The buyer's own check of the deposit.</strong> The contract cannot read Bitcoin, so the buyer's client verifies
            the UTXOs at the escrow address (this site shows confirmations). Verifying deposits on chain with a Bitcoin light client
            is next on the roadmap.
          </li>
        </ul>
      </div>
    </section>
  );
}

function Diagram() {
  return (
    <svg
      className="diagram"
      viewBox="0 0 900 230"
      role="img"
      aria-label="Seller deposits BTC to an MPC controlled address, buyer pays NEAR to the contract, the contract asks MPC to sign the BTC payout to the buyer and pays the seller"
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="currentColor" />
        </marker>
      </defs>
      <g className="d-box">
        <rect x="10" y="20" width="170" height="70" rx="12" />
        <text x="95" y="50">Seller</text>
        <text x="95" y="72" className="d-sub">has BTC, wants NEAR</text>
      </g>
      <g className="d-box">
        <rect x="10" y="140" width="170" height="70" rx="12" />
        <text x="95" y="170">Buyer</text>
        <text x="95" y="192" className="d-sub">has NEAR, wants BTC</text>
      </g>
      <g className="d-box btc-box">
        <rect x="300" y="20" width="250" height="70" rx="12" />
        <text x="425" y="50">Escrow BTC address</text>
        <text x="425" y="72" className="d-sub">key held by NEAR MPC</text>
      </g>
      <g className="d-box near-box">
        <rect x="300" y="140" width="250" height="70" rx="12" />
        <text x="425" y="170">Trueque contract</text>
        <text x="425" y="192" className="d-sub">builds + verifies the BTC tx</text>
      </g>
      <g className="d-box mpc-box">
        <rect x="680" y="80" width="210" height="70" rx="12" />
        <text x="785" y="110">NEAR MPC network</text>
        <text x="785" y="132" className="d-sub">threshold ECDSA</text>
      </g>
      <g className="d-arrows">
        <path d="M180 55H296" markerEnd="url(#arrow)" className="btc-line" />
        <text x="238" y="45">1 BTC</text>
        <path d="M180 175H296" markerEnd="url(#arrow)" className="near-line" />
        <text x="238" y="165">2 NEAR</text>
        <path d="M550 165C610 165 630 130 676 120" markerEnd="url(#arrow)" />
        <text x="618" y="178">3 sign</text>
        <path d="M680 100C630 80 600 60 554 58" markerEnd="url(#arrow)" className="btc-line" />
        <text x="618" y="66">4 signature</text>
        <path d="M425 90C425 125 260 125 184 160" markerEnd="url(#arrow)" className="btc-line" strokeDasharray="5 5" />
        <text x="318" y="132">5 BTC to buyer</text>
        <path d="M300 150C255 125 220 105 184 82" markerEnd="url(#arrow)" className="near-line" strokeDasharray="5 5" />
        <text x="206" y="112">NEAR to seller</text>
      </g>
    </svg>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <span>
        <strong>Trueque</strong>: Spanish for barter, value for value with no one in the middle.
      </span>
      <span className="foot-links">
        <Ext href={REPO_URL}>Source</Ext>
        <Ext href={`${NEAR_EXPLORER}/address/${CONTRACT}`}>Contract</Ext>
        <span className="muted">Testnet and signet only. Test coins have no value.</span>
      </span>
    </footer>
  );
}

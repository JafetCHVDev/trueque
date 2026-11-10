# Trueque

**Peer to peer native Bitcoin for NEAR, settled by NEAR Chain Signatures.**
No bridge, no wrapped BTC, no custodian.

*Trueque* is Spanish for barter: value for value, with no one in the middle.

- Live contract: [`market.trueque.testnet`](https://testnet.nearblocks.io/address/market.trueque.testnet) (NEAR testnet, Bitcoin signet)
- MPC signer: `v1.signer-prod.testnet` (the NEAR Chain Signatures network)
- Built for NEAR HACKATHON (Nov 2026). Tracks: Unstoppable DeFi, Real-World Money, Open Innovation.

## The problem

Getting Bitcoin in or out of an ecosystem today means trusting someone: a centralized exchange, a bridge multisig, or the
issuer of a wrapped token. Peer to peer markets avoid the middleman but bring back counterparty risk: whoever sends first
can be cheated. In Latin America, where P2P is how many people actually buy and sell BTC, that risk is paid every day in
scams and in escrow fees to whoever holds the coins.

## What Trueque does

A seller locks real BTC at a Bitcoin address that **no person controls**: its key is derived by the NEAR MPC network for
the Trueque contract, and the MPC network only signs what the contract asks. A buyer pays the price in NEAR into the
contract. The contract then **writes the Bitcoin transaction itself** (the deposit as inputs, the buyer's address as
output), asks MPC to sign it, verifies the signature on chain, and only then pays the seller. The signed transaction is
public in contract state; anyone can broadcast it.

So the swap is atomic across two chains with no wrapped asset:

- once an offer is taken, its coins can only ever be signed to the buyer;
- before that, only back to the seller;
- the seller is paid in the same step in which the buyer's BTC payout becomes valid.

## How NEAR is used (and why it matters)

| NEAR feature | What it does in Trueque |
| --- | --- |
| **Chain Signatures** (`v1.signer-prod.testnet`, domain 0, secp256k1) | Each offer gets its own key at path `trueque/<salt>/<offer>`, derived for the contract account. Its P2WPKH address is the escrow. The contract calls `derived_public_key` at offer creation and `sign` at settlement. |
| **Smart contract as the Bitcoin wallet** | The contract builds the transaction, computes every BIP143 sighash, DER encodes the MPC signatures and assembles the final segwit transaction. Nothing off chain decides where coins go. |
| **On chain verification** | Every MPC signature is checked with `env::ecrecover` against the offer's derived key before it is accepted. |
| **Promises and callbacks** | Key derivation and signing are cross contract calls with callbacks, so a failed or slow MPC response never moves funds; `retry_signatures` resumes it. |
| **Named accounts and instant onboarding** | The web app can create a funded testnet account in the browser in one click, so anyone can try a trade without a wallet. |

## Try it (about 2 minutes, no install)

Hosted demo: _link added when deployed_. Locally: see [Run it locally](#run-it-locally).

1. Open the app. **See** the live market: funded offers show `BTC locked · confirmed`, with stats read from the contract.
2. Click **Sign in → Instant guest account**. **See** a new `trueque-guest-….testnet` account with about 10 NEAR in the header.
3. Click **Buy** on any offer, then **Create an in-browser signet wallet for me**. **See** the summary: NEAR you pay, sats
   you receive, the Bitcoin miner fee.
4. Click **Pay**. **See** the offer page fill its timeline in about 10 seconds: *NEAR MPC signs the Bitcoin payout* (1/1
   signatures, verified with `ecrecover`), then *Native BTC lands in the buyer's wallet* with a link to the transaction
   on mempool.space signet.
5. Open **Activity**. **See** the trade and your in-browser signet wallet balance (pending until the next signet block).
6. To sell: **Sell → Open offer**. **See** a fresh escrow address with a QR code, derived by Chain Signatures for your
   offer. With BTC in your in-browser wallet, click **Deposit … sats from it**; the offer appears in the market once funded.
   **Cancel and refund my BTC** returns the coins with a contract signed refund.

The same flow without a browser, against the live contract with real signet coins:

```sh
npm install
node scripts/e2e.mjs 2000 0.25   # needs NEAR testnet keys and a funded signet wallet, see Scripts
```

### Verified on testnet

From [`docs/e2e-report.json`](docs/e2e-report.json), first end to end run:

| Step | Evidence |
| --- | --- |
| Maker opens offer #0; contract gets its escrow address from MPC | [NEAR tx](https://testnet.nearblocks.io/txns/7AovWi5DfkGaPvv6WJ4VrnXwRkk4u4byMbmdkRDg2chR), address `tb1qa52l96j8nhjexdzv227a60wac98mp9qnfarsce` |
| Address re-derived independently from `v1.signer-prod.testnet` | matches |
| Maker deposits 2,000 sats | [signet tx](https://mempool.space/signet/tx/76fe8cb626fe2c3165b8118f55dfb14d6bb909a2f3c7d843d768c563838f8b5c) |
| Taker pays 0.25 NEAR; MPC signs; contract verifies and pays the maker | [NEAR tx](https://testnet.nearblocks.io/txns/C4KeiRNLYVE55g4CC3Fpce6CSDNzsnMJvrabF2cE7zxr) |
| Contract signed release accepted by Bitcoin | [signet tx](https://mempool.space/signet/tx/5bc8e5ce0e6f29a9d0da1cdda52f2f1b50f02634df3e59f5ade5641dd82a4da1) |

## Architecture

```
contract/        Rust NEAR contract (near-sdk 5)
  src/lib.rs     offers, take/cancel/recover, MPC calls and callbacks, views
  src/btc.rs     BIP143 sighash, segwit serialization, DER, bech32 addresses
  src/tests.rs   unit tests, incl. real ECDSA signatures checked by ecrecover
web/             React + Vite app (near-connect wallets, guest accounts, bitcoinjs for the guest signet wallet)
scripts/
  e2e.mjs        full trade on testnet + signet, writes docs/e2e-report.json
  seed.mjs       open and fund offers
  keeper.mjs     broadcasts signed settlements, retries missing MPC signatures
  verify-vector.mjs  checks the contract's sighash + signature with bitcoinjs
```

### Offer lifecycle

```
create_offer ──► Deriving ──(MPC derived_public_key)──► Open ──take_offer──► Taken ──(MPC sign, ecrecover)──► Settled
                    │                                    │                                                      │
                    └─ Failed (bond returned)            └─ cancel_offer ──► Cancelled (+ signed refund)       └─ recover (late deposits)
```

### Contract interface

| Method | Who | What |
| --- | --- | --- |
| `create_offer(sats, price, refund_address)` + 0.02 NEAR bond | maker | Opens an offer; returns it with its `deposit_address` once MPC answers. |
| `take_offer(id, btc_address, utxos, fee_sats)` + price | taker | Locks the NEAR, builds the payout tx, requests one MPC signature per input. |
| `cancel_offer(id, utxos, fee_sats)` | maker | Closes an open offer; with `utxos`, signs a refund to the maker. |
| `recover(id, utxos, fee_sats)` | maker | Sweeps coins that reached a closed offer's address later. Coins already used by a settlement are rejected. |
| `retry_signatures(id)` | anyone | Asks MPC again for missing signatures. |
| `get_offer`, `list_offers(status?, from_id?, limit?)`, `get_config` | view | Offers include every settlement with outputs, signing progress, `txid` and the signed `raw_tx`. |

Events are emitted as NEP-297 logs (`EVENT_JSON:{"standard":"trueque",...}`): `offer_created`, `offer_taken`,
`offer_settled`, `offer_cancelled`, `refund_signed`.

## Security model

What the contract guarantees:

- **The payout is fixed on chain.** `take_offer` builds the outputs (buyer amount, change to the seller); callers only
  provide inputs. A wrong UTXO value only produces an invalid signature (BIP143 commits to amounts), never a different
  payment.
- **One spend per coin.** Inputs used by any settlement of an offer can never be signed again, so a seller cannot
  "recover" coins already sold.
- **No payment without a valid payout.** The seller's NEAR is released in the callback that verifies the last
  signature with `ecrecover`. If MPC times out, nothing moves and anyone can call `retry_signatures`.
- **Exclusive states.** Open offers can be taken or cancelled, never both. Taken offers cannot be cancelled.

What you still trust:

- **The NEAR MPC network** to sign only for the requesting contract (threshold ECDSA across independent nodes).
- **The buyer's client to check the deposit.** The contract cannot read Bitcoin yet. The app reads the escrow
  address from Esplora and shows confirmations; it warns before buying against unconfirmed deposits. See the roadmap.

This is hackathon software on testnet and signet. It has not been audited.

## Run it locally

Requirements: Node 20+, Rust with `wasm32-unknown-unknown`, [`cargo-near`](https://github.com/near/cargo-near) and
[`near-cli-rs`](https://github.com/near/near-cli-rs).

```sh
npm install
npm run dev -w web            # http://localhost:5173, uses market.trueque.testnet
```

Contract:

```sh
cd contract
cargo test                    # on Windows: set AWS_LC_SYS_PREBUILT_NASM=1
cargo near build non-reproducible-wasm --no-abi
near contract deploy <account> use-file target/near/trueque.wasm \
  with-init-call new json-args '{"mpc_contract":"v1.signer-prod.testnet","network":"signet","fee_bps":30}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

Point the app at your deployment with `VITE_CONTRACT=<account> npm run dev -w web`.

Independent check of the Bitcoin code (runs the signing test, then verifies the transaction with bitcoinjs):

```sh
npm run verify:vector         # OK: 1 input(s) verified by bitcoinjs, txid ...
```

### Scripts

The scripts read NEAR keys from `~/.near-credentials/testnet/<account>.json` (as written by `near-cli-rs` with
`save-to-legacy-keychain`) and signet wallets from `.secrets/wallets/<name>.json` (`{"wif": "..."}`, gitignored).
Signet coins have no value; never put a mainnet key there.

## Roadmap

1. **Verify deposits on chain.** The MPC contract (v3.18) already exposes `verify_foreign_transaction` with a Bitcoin
   inspector, but Bitcoin is not yet in the testnet signer's available chains. With it, `take_offer` will accept the
   raw deposit transaction, check its outputs and txid in the contract, and ask MPC to attest its confirmations. That
   removes the last client side check.
2. **Stablecoin prices** (NEP-141, `ft_transfer_call`), so offers can be priced in USDC.
3. **NEAR Intents for the buyer side**, so a buyer can pay from any chain the 1Click API supports.
4. **Mainnet**: the contract already supports `network: "mainnet"` (bc1 addresses).

## Disclosure

- Written from scratch during NEAR HACKATHON (first commit 2026-11-10). Open source libraries: near-sdk, bech32, bs58,
  hex (contract); React, Vite, near-api-js, @hot-labs/near-connect, bitcoinjs-lib, ecpair, @bitcoinerlab/secp256k1,
  qrcode (web). AI coding assistants were used.
- The author also builds BitGate, a P2P Bitcoin market on Stellar that verifies payments with SPV proofs. Trueque shares
  no code with it and is not submitted elsewhere in this hackathon.

## License

MIT

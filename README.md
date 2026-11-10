# Trueque

**Peer to peer native Bitcoin for NEAR, settled by NEAR Chain Signatures.**
No bridge, no wrapped BTC, no custodian.

*Trueque* is Spanish for barter: value for value, with no one in the middle.

- Demo: **https://jafetchvdev.github.io/trueque/** (NEAR testnet + Bitcoin signet, guest accounts, no install)
- Live contract: [`market.trueque.testnet`](https://testnet.nearblocks.io/address/market.trueque.testnet)
- Test USDC (NEP-141 with a public faucet): [`usdc.trueque.testnet`](https://testnet.nearblocks.io/address/usdc.trueque.testnet)
- MPC signer: `v1.signer-prod.testnet` (the NEAR Chain Signatures network)
- Built for NEAR HACKATHON (Nov 2026). Tracks: Unstoppable DeFi, Real-World Money, Open Innovation.

## The problem

Getting Bitcoin in or out of an ecosystem today means trusting someone: a centralized exchange, a bridge multisig, or the
issuer of a wrapped token. Peer to peer markets avoid the middleman but bring back counterparty risk: whoever sends first
can be cheated. In Latin America, where P2P is how many people actually buy and sell BTC, that risk is paid every day in
scams and in escrow fees to whoever holds the coins.

## What Trueque does

A seller locks real BTC at a Bitcoin address that **no person controls**: its key is derived by the NEAR MPC network for
the Trueque contract, and the MPC network only signs what the contract asks. A buyer pays the price into the contract, in
USDC (any accepted NEP-141 stablecoin, through `ft_transfer_call`) or in NEAR. The contract then **writes the Bitcoin transaction itself** (the deposit as inputs, the buyer's address as
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
| **NEP-141 stablecoins** | Offers can be priced in USDC. Buying is one `ft_transfer_call`; if anything is wrong the contract panics and the token refunds the buyer automatically. Payouts that fail (an unregistered seller) become claimable with `withdraw_owed`. |
| **Promises and callbacks** | Key derivation and signing are cross contract calls with callbacks, so a failed or slow MPC response never moves funds; `retry_signatures` resumes it. |
| **Named accounts and instant onboarding** | The web app can create a funded testnet account in the browser in one click, so anyone can try a trade without a wallet. |

## Try it (about 2 minutes, no install)

Open **https://jafetchvdev.github.io/trueque/** (or [run it locally](#run-it-locally)).

1. **See** the live market: funded offers priced in USDC or NEAR, each with `BTC locked`, the implied BTC price and its
   distance from the market reference. The stats at the top are read from the contract.
2. Click **Sign in → Instant guest account**. **See** a new `trueque-guest-….testnet` account with about 10 NEAR in the header.
3. Click **Buy** on a USDC offer, then **Create an in-browser signet wallet for me** and **Get 100 test USDC**. **See**
   the summary: USDC you pay, sats you receive, the Bitcoin miner fee.
4. Click **Pay**. **See** the offer page fill its timeline in about 10 seconds: *NEAR MPC signs the Bitcoin payout* (1/1
   signatures, verified with `ecrecover`), then *Native BTC lands in the buyer's wallet* with a link to the transaction
   on mempool.space signet. NEAR priced offers work the same way, paying with attached NEAR.
5. Open **Activity**. **See** the trade and your in-browser signet wallet balance (pending until the next signet block).
6. To sell: **Sell → Get paid in USDC → Open offer** (the price starts at the market reference). **See** a fresh escrow
   address with a QR code, derived by Chain Signatures for your offer. With the sats you just bought, click
   **Deposit … sats from it**; the offer appears in the market once funded. **Cancel and refund my BTC** returns the coins
   with a refund transaction signed by the contract.

The same flow without a browser, against the live contract with real signet coins:

```sh
npm install
node scripts/e2e.mjs 2000 0.25          # priced in NEAR
node scripts/e2e.mjs 1500 1.5 --usdc    # priced in test USDC, bought with ft_transfer_call
```

Both need NEAR testnet keys and a funded signet wallet, see [Scripts](#scripts).

### Verified on testnet

From [`docs/e2e-report.json`](docs/e2e-report.json), first end to end run:

| Step | Evidence |
| --- | --- |
| Maker opens offer #0; contract gets its escrow address from MPC | [NEAR tx](https://testnet.nearblocks.io/txns/7AovWi5DfkGaPvv6WJ4VrnXwRkk4u4byMbmdkRDg2chR), address `tb1qa52l96j8nhjexdzv227a60wac98mp9qnfarsce` |
| Address re-derived independently from `v1.signer-prod.testnet` | matches |
| Maker deposits 2,000 sats | [signet tx](https://mempool.space/signet/tx/76fe8cb626fe2c3165b8118f55dfb14d6bb909a2f3c7d843d768c563838f8b5c) |
| Taker pays 0.25 NEAR; MPC signs; contract verifies and pays the maker | [NEAR tx](https://testnet.nearblocks.io/txns/C4KeiRNLYVE55g4CC3Fpce6CSDNzsnMJvrabF2cE7zxr) |
| Contract signed release accepted by Bitcoin | [signet tx](https://mempool.space/signet/tx/5bc8e5ce0e6f29a9d0da1cdda52f2f1b50f02634df3e59f5ade5641dd82a4da1) |

Priced in USDC ([`docs/e2e-report-usdc.json`](docs/e2e-report-usdc.json)), after upgrading the live contract in place
with a state migration:

| Step | Evidence |
| --- | --- |
| Offer #4: 1,500 sats for 1.5 USDC | [NEAR tx](https://testnet.nearblocks.io/txns/9ummRTobE1HXohb4RtgBi9FZ7TUKp86WdMfjeanjomRU), [deposit](https://mempool.space/signet/tx/d8f6bc72c00508ebb198cc9cb370ce536e5ff9fbe082704a49a7ed2121dafc3b) |
| Buyer pays with `ft_transfer_call`; MPC signs; seller receives 1.4955 USDC (0.3% fee) | [NEAR tx](https://testnet.nearblocks.io/txns/7F6yAG8ZcuH5xgs29Z8xjKcj2f4uKExVKVeCH48tu8tG) |
| Release accepted by Bitcoin | [signet tx](https://mempool.space/signet/tx/91a76214764d1a1fb6ccd3d742f7f9b81d2a4015747157b10ac3b213b1bd7676) |

Refunds: offers #1 and #2 were cancelled by their maker and the contract signed the BTC back
([refund 1](https://mempool.space/signet/tx/bf0fa821342d45a2f55eb51eb5e2255bc473c492a3887a1791084fe742841168),
[refund 2](https://mempool.space/signet/tx/49b1221c49539da92e8b12d2854b0bd6eadc280eec31c466c613b6ecda0cbfb7)).

## Architecture

```
contract/        Rust NEAR contract (near-sdk 5)
  src/lib.rs     offers, take/cancel/recover, MPC calls and callbacks, views
  src/btc.rs     BIP143 sighash, segwit serialization, DER, bech32 addresses
  src/tests.rs   26 unit tests, incl. real ECDSA signatures checked by ecrecover and USDC purchases
token/           test USDC (NEP-141, near-contract-standards) with a public faucet
web/             React + Vite app (near-connect wallets, guest accounts, bitcoinjs for the guest signet wallet)
scripts/
  e2e.mjs        full trade on testnet + signet, writes docs/e2e-report.json
  seed.mjs       open and fund offers (NEAR or --usdc)
  cancel.mjs     cancel an offer and broadcast its contract signed refund
  keeper.mjs     broadcasts signed settlements, retries missing MPC signatures
                 (also runs every 5 minutes in GitHub Actions, broadcast only, no secrets)
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
| `create_offer(sats, price, refund_address, token?)` + 0.02 NEAR bond | maker | Opens an offer priced in NEAR or in an accepted token; returns it with its `deposit_address` once MPC answers. |
| `take_offer(id, btc_address, utxos, fee_sats)` + price | taker | NEAR offers: locks the NEAR, builds the payout tx, requests one MPC signature per input. |
| `ft_transfer_call` on the token, `msg` = `{"id","btc_address","utxos","fee_sats"}` | taker | Token offers: same as `take_offer`, through `ft_on_transfer`. Overpayment is returned; any failure refunds the transfer. |
| `cancel_offer(id, utxos, fee_sats)` | maker | Closes an open offer; with `utxos`, signs a refund to the maker. |
| `recover(id, utxos, fee_sats)` | maker | Sweeps coins that reached a closed offer's address later. Coins already used by a settlement are rejected. |
| `retry_signatures(id)` | anyone | Asks MPC again for missing signatures. |
| `withdraw_owed(token)` | anyone owed | Claims a token payout that could not be delivered. |
| `add_token`, `set_fee_bps`, `migrate` | owner | Accept a stablecoin, set the protocol fee (max 5%), upgrade state. |
| `get_offer`, `list_offers(status?, from_id?, limit?)`, `get_config` | view | Offers include every settlement with outputs, signing progress, `txid` and the signed `raw_tx`. |

Events are emitted as NEP-297 logs (`EVENT_JSON:{"standard":"trueque",...}`): `offer_created`, `offer_taken`,
`offer_settled`, `offer_cancelled`, `refund_signed`, `payout_owed`.

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
2. **NEAR Intents for the buyer side**, so a buyer can pay from any chain the 1Click API supports.
3. **Mainnet** with real USDC: the contract already supports `network: "mainnet"` (bc1 addresses) and any NEP-141 token
   the owner accepts.
4. **Buy orders**: today sellers post offers; the same escrow works in reverse for buyers posting bids.

## Disclosure

- Written from scratch during NEAR HACKATHON (first commit 2026-11-10). Open source libraries: near-sdk, bech32, bs58,
  hex, near-contract-standards (contracts); React, Vite, near-api-js, @hot-labs/near-connect, bitcoinjs-lib, ecpair, @bitcoinerlab/secp256k1,
  qrcode (web). AI coding assistants were used.
- The author also builds BitGate, a P2P Bitcoin market on Stellar that verifies payments with SPV proofs. Trueque shares
  no code with it and is not submitted elsewhere in this hackathon.

## License

MIT

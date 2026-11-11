# Trueque

**Peer to peer native Bitcoin for USDC or NEAR, settled by NEAR Chain Signatures and verified by a Bitcoin light client on NEAR.**
No bridge, no wrapped BTC, no custodian, and no trusted check of the deposit.

*Trueque* is Spanish for barter: value for value, with no one in the middle.

- Demo: **https://jafetchvdev.github.io/trueque/** (NEAR testnet + Bitcoin testnet, guest accounts, no install)
- Contract: [`trueque.testnet`](https://testnet.nearblocks.io/address/trueque.testnet)
- Bitcoin light client it trusts: [`btc-client-v4.testnet`](https://testnet.nearblocks.io/address/btc-client-v4.testnet) (by [Near-One](https://github.com/Near-One/btc-light-client-contract), follows Bitcoin testnet)
- MPC signer: `v1.signer-prod.testnet` (the NEAR Chain Signatures network)
- Test USDC (NEP-141 with a public faucet): [`usdc.trueque.testnet`](https://testnet.nearblocks.io/address/usdc.trueque.testnet)
- Built for NEAR HACKATHON (Nov 2026). Tracks: Unstoppable DeFi, Real-World Money, Open Innovation.

## The problem

Getting Bitcoin in or out of an ecosystem today means trusting someone: a centralized exchange, a bridge multisig, or the
issuer of a wrapped token. Peer to peer markets avoid the middleman but bring back counterparty risk: whoever sends first
can be cheated. In Latin America, where P2P is how many people actually buy and sell BTC, that risk is paid every day in
scams and in escrow fees to whoever holds the coins.

## What Trueque does

1. A seller opens an offer. The contract asks the NEAR MPC network for a key derived for the contract itself, and its
   Bitcoin address becomes the offer's escrow. **No person controls that key**; MPC only signs what the contract asks.
2. The seller deposits real BTC there.
3. A buyer pays the price (USDC through `ft_transfer_call`, or NEAR) **together with the raw deposit transaction and an SPV
   proof**. The contract parses the transaction itself (txid, amount, escrow output) and asks the Bitcoin light client on
   NEAR to confirm it is in a block with enough confirmations. If it is not, the payment is returned in the same flow.
4. The contract **writes the Bitcoin payout itself** (the deposit as input, the buyer's address as output), asks MPC to
   sign it, checks every signature with `ecrecover`, and only then pays the seller. The signed transaction is public;
   anyone can broadcast it.
5. If MPC never signs, the buyer **reclaims the payment** after an hour and the offer reopens.

The swap is atomic across two chains with no wrapped asset, and no step relies on anyone's word.

## How NEAR is used (and why it matters)

| NEAR feature | What it does in Trueque |
| --- | --- |
| **Chain Signatures** (`v1.signer-prod.testnet`, domain 0, secp256k1) | Each offer gets its own key at path `trueque/<salt>/<offer>`, derived for the contract account. Its P2WPKH address is the escrow. The contract calls `derived_public_key` at offer creation and `sign` at settlement. |
| **A Bitcoin light client as a NEAR contract** (`btc-client-v4.testnet`) | `verify_transaction_inclusion_v2` checks the deposit's Merkle proof (and the coinbase proof) against block headers it validated, and that the block has the required confirmations. The contract computes the txid from the raw transaction, so a proof for some other transaction is useless. |
| **Smart contract as the Bitcoin wallet** | The contract parses Bitcoin transactions, computes BIP143 sighashes, DER encodes MPC signatures and assembles the final segwit transaction. Nothing off chain decides where coins go. |
| **Promises, callbacks and `ecrecover`** | Proof verification and signing are cross contract calls with callbacks. A failed proof refunds the buyer; a slow MPC never moves funds; every signature is checked on chain. |
| **NEP-141** | Offers priced in USDC are bought with one `ft_transfer_call`. If the proof fails, the token returns the whole transfer as unused. |
| **Named accounts and instant onboarding** | The web app creates a funded testnet account in the browser in one click, so anyone can try a trade without a wallet. |

## Try it (about 2 minutes, no install)

Open **https://jafetchvdev.github.io/trueque/** (or [run it locally](#run-it-locally)).

1. **See** the live market: offers priced in USDC or NEAR whose BTC is already confirmed at their escrow, each with the
   implied BTC price and its distance from the market reference. The stats at the top come from the contract.
2. Click **Sign in → Instant guest account**. **See** a new `trueque-guest-….testnet` account with about 10 NEAR in the header.
3. Click **Buy** on a USDC offer, then **Create an in-browser testnet wallet for me** and **Get 100 test USDC**. **See** the
   summary: what you pay, the sats you receive, the miner fee, and "Deposit check: on chain, by the NEAR Bitcoin light client".
4. Click **Pay**. The app builds the SPV proof of the seller's deposit and sends it with the payment. **See** the offer page:
   *Deposit proven on chain* (by `btc-client-v4.testnet`), then *NEAR MPC signs the Bitcoin payout* (verified with
   `ecrecover`), then *Native BTC lands in the buyer's wallet* with a link to the transaction on mempool.space testnet.
5. To sell: **Sell → Get paid in USDC → Open offer**. **See** a fresh escrow address with a QR code, derived by Chain
   Signatures for your offer. Deposit to it (the in-browser wallet can do it with the sats you bought). After one Bitcoin
   block the offer can be bought. **Cancel and refund my BTC** returns the coins with a refund signed by the contract.

### Try to cheat it

```sh
node scripts/attack-fake-deposit.mjs
```

A buyer claims a deposit that does not exist: a well formed transaction paying the escrow, with proof material copied from
a real block. Live result ([`docs/attack-fake-deposit.json`](docs/attack-fake-deposit.json),
[NEAR tx](https://testnet.nearblocks.io/txns/2aU88Say7vrYADzXeUNzrApE1zDi8JoaqPj8LMN1NoaU)): the light client answers
`false`, the contract emits `take_rejected`, returns the NEAR (the buyer paid only gas) and the offer stays open.

### Verified on testnet

The full flow against the live contracts, with real coins:

```sh
npm install
node scripts/e2e.mjs 2000 0.3            # priced in NEAR
node scripts/e2e.mjs 1500 1.1 --usdc     # priced in test USDC, bought with ft_transfer_call
```

Each run writes its evidence (NEAR transactions, Bitcoin transactions, confirmations proven) to `docs/e2e-report-v2*.json`.
Live results on 2026-11-10:

| Paid in | Report | Seller deposit (BTC) | Buyer pays + proof (NEAR) | Payout signed by MPC (BTC) |
| --- | --- | --- | --- | --- |
| NEAR | [`e2e-report-v2.json`](docs/e2e-report-v2.json) | [196b6263...](https://mempool.space/testnet/tx/196b62633f713977bed04a357fe5b1675250563ee986b96ff268fd8f19d6c21b) | [498gp4Rz...](https://testnet.nearblocks.io/txns/498gp4RzYcJT79SNcuvWR8hG7282puqXrFM11sVY4qLf) | [15bafa8d...](https://mempool.space/testnet/tx/15bafa8dba8c3bdb6c4e3bc90f9d1b5684a0af4b4973cac956bf0ca9c58c9154) |
| USDC | [`e2e-report-v2-usdc.json`](docs/e2e-report-v2-usdc.json) | [4a5fcac8...](https://mempool.space/testnet/tx/4a5fcac8538a557d6a3af382c9c977525c0f8c44f1bb7ba0eda4e2a5d9e71e3e) | [DchgMvnW...](https://testnet.nearblocks.io/txns/DchgMvnWnH1LtdPNHvkdHVg6WmJPF2UcNGwWZ6LF3XYB) | [96ed4910...](https://mempool.space/testnet/tx/96ed49102760f964e345e96f1c265b099565ac00d519792261cca0e8409aedc0) |

In both, the light client proved the deposit, MPC signed in the same block and the contract checked the signature before
the payout was broadcast.

The first release ([`market.trueque.testnet`](https://testnet.nearblocks.io/address/market.trueque.testnet), tag
[`v1-signet`](https://github.com/JafetCHVDev/trueque/tree/v1-signet)) ran the same escrow on Bitcoin signet, where no light
client exists, and settled 7 trades in NEAR and USDC plus 2 contract signed refunds; see
[`docs/e2e-report.json`](docs/e2e-report.json) and [`docs/e2e-report-usdc.json`](docs/e2e-report-usdc.json). Version 2
moved to Bitcoin testnet to verify deposits on chain.

## Architecture

```
contract/        Rust NEAR contract (near-sdk 5)
  src/lib.rs     offers, proof verified purchases, reclaim, MPC calls and callbacks, views
  src/btc.rs     transaction parser (txid from the stripped serialization), BIP143 sighash,
                 segwit serialization, DER, bech32 addresses
  src/tests.rs   30 unit tests: real ECDSA signatures checked by ecrecover, light client
                 verdicts (accepted, rejected, partial), reclaim timing, USDC flows
token/           test USDC (NEP-141, near-contract-standards) with a public faucet
web/             React + Vite app: near-connect wallets, guest accounts, SPV proofs built in the
                 browser, bitcoinjs for the guest testnet wallet
scripts/
  e2e.mjs        full trade on NEAR testnet + Bitcoin testnet, writes docs/e2e-report-v2*.json
  attack-fake-deposit.mjs  tries to buy with a deposit that does not exist (must fail)
  spv.mjs        SPV proofs from a Bitcoin Core RPC
  seed.mjs       open and fund offers (NEAR or --usdc)
  cancel.mjs     cancel an offer and broadcast its contract signed refund
  keeper.mjs     broadcasts signed settlements, retries missing MPC signatures
                 (also runs every 5 minutes in GitHub Actions, broadcast only, no secrets)
  verify-vector.mjs  checks the contract's sighash + signature with bitcoinjs
```

### Offer lifecycle

```
create_offer ─► Deriving ─(MPC derived_public_key)─► Open ─take─► Verifying ─(light client)─► Taken ─(MPC sign, ecrecover)─► Settled
                   │                                  │  ▲              │                       │                               │
                   └─ Failed (bond returned)          │  └── proof rejected: payment returned   └─ reclaim_payment after 1 h    └─ recover
                                                      └─ cancel_offer ─► Cancelled (+ signed refund)     (offer reopens)            (late deposits)
```

### Contract interface

| Method | Who | What |
| --- | --- | --- |
| `create_offer(sats, price, refund_address, token?)` + 0.02 NEAR bond | maker | Opens an offer priced in NEAR or in an accepted token; returns it with its `deposit_address` once MPC answers. |
| `take_offer(id, btc_address, deposits, fee_sats)` + price | taker | NEAR offers. `deposits`: `[{raw_tx, vout, block_hash, tx_index, merkle_proof, coinbase_tx_id, coinbase_merkle_proof}]`, hashes in display hex. |
| `ft_transfer_call` on the token, `msg` = `{"id","btc_address","deposits","fee_sats"}` | taker | Token offers, through `ft_on_transfer`. Overpayment is returned; a rejected proof returns everything. |
| `reclaim_payment(id)` | anyone | Pays the taker back if MPC has not signed an hour after the last request; the offer reopens. |
| `cancel_offer(id, utxos, fee_sats)` | maker | Closes an open offer; with `utxos`, signs a refund to the maker. |
| `recover(id, utxos, fee_sats)` | maker | Sweeps coins that reached a closed offer's address later. Coins already used by a settlement are rejected. |
| `retry_signatures(id)` | anyone | Asks MPC again for missing signatures. |
| `withdraw_owed(token)` | anyone owed | Claims a token payout that could not be delivered. |
| `add_token`, `set_fee_bps`, `set_min_confirmations` | owner | Accept a stablecoin, set the protocol fee (max 5%), set the required confirmations. |
| `get_offer`, `list_offers(status?, from_id?, limit?)`, `get_config` | view | Offers include every settlement with outputs, proven confirmations, signing progress, `txid` and the signed `raw_tx`. |

Events are NEP-297 logs (`EVENT_JSON:{"standard":"trueque","version":"2.0.0",...}`): `offer_created`, `offer_verifying`,
`take_rejected`, `offer_taken`, `offer_settled`, `payment_reclaimed`, `offer_cancelled`, `refund_signed`, `payout_owed`.

## Security model

What the contract guarantees:

- **The deposit is proven, not claimed.** Amount and recipient are read from the raw transaction, its txid is computed in
  the contract, and the light client must confirm it is in the chain. A 64 byte transaction (which could pose as an inner
  Merkle node) is refused, and the coinbase proof ties the proof to the real block.
- **The payout is fixed on chain.** The contract builds the outputs (buyer amount, change to the seller); nobody can
  redirect the coins.
- **One spend per coin.** Inputs used by any live settlement of an offer can never be signed again, so a seller cannot
  recover coins already sold.
- **No payment without a valid payout.** The seller is paid in the callback that verifies the last signature.
- **No stuck payments.** A rejected proof refunds at once. If MPC does not sign, `reclaim_payment` refunds the buyer after
  an hour; MPC requests expire within minutes, and a late signature for the abandoned payout is ignored.
- **Exclusive states.** An offer being verified can be neither cancelled nor bought by someone else.
- **No surprise fees.** The protocol fee can only be lowered, so an open offer never pays more than it showed.
- **Bounded storage.** An offer can hold at most 6 settlements, so nobody can bloat the contract's storage through it.

What you trust:

- **The NEAR MPC network** to sign only for the requesting contract (threshold ECDSA across independent nodes).
- **The Bitcoin light client** to follow the heaviest valid chain. It checks proof of work header by header; on testnet the
  difficulty is low, so mainnet would require more confirmations (`set_min_confirmations`).

This is hackathon software on testnet. It has not had an independent audit; the self review, its findings and fixes are in
[`docs/audit.md`](docs/audit.md).

## Run it locally

Requirements: Node 20+, Rust with `wasm32-unknown-unknown`, [`cargo-near`](https://github.com/near/cargo-near) and
[`near-cli-rs`](https://github.com/near/near-cli-rs).

```sh
npm install
npm run dev -w web            # http://localhost:5173, uses trueque.testnet
```

Contract:

```sh
cd contract
cargo test                    # on Windows: set AWS_LC_SYS_PREBUILT_NASM=1
cargo near build non-reproducible-wasm --no-abi
near contract deploy <account> use-file target/near/trueque.wasm \
  with-init-call new json-args '{"mpc_contract":"v1.signer-prod.testnet","network":"testnet","fee_bps":30,"light_client":"btc-client-v4.testnet","min_confirmations":1}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

Point the app at your deployment with `VITE_CONTRACT=<account> npm run dev -w web`.

Independent check of the Bitcoin code (runs the signing test, then verifies the transaction with bitcoinjs):

```sh
npm run verify:vector         # OK: 1 input(s) verified by bitcoinjs, txid ...
```

### Scripts

The scripts read NEAR keys from `~/.near-credentials/testnet/<account>.json` (as written by `near-cli-rs` with
`save-to-legacy-keychain`) and Bitcoin testnet wallets from `.secrets/wallets/<name>.json` (`{"wif": "..."}`, gitignored).
Bitcoin data comes from mempool.space / blockstream Esplora and from a public Bitcoin Core RPC
(`bitcoin-testnet-rpc.publicnode.com`, override with `BTC_RPC`). Testnet coins have no value; never put a mainnet key there.

## Roadmap

1. **A second, independent deposit attestation.** The MPC contract (v3.18) has `verify_foreign_transaction` with a Bitcoin
   inspector; once Bitcoin is enabled there, the contract can require both the light client and MPC to agree.
2. **NEAR Intents for the buyer side**, so a buyer can pay from any chain the 1Click API supports.
3. **Mainnet** with real USDC and 3 to 6 confirmations: the contract already supports `network: "mainnet"`.
4. **Buy orders**: today sellers post offers; the same escrow works in reverse for buyers posting bids.

## Disclosure

- Written from scratch during NEAR HACKATHON (first commit 2026-11-10). Open source libraries: near-sdk, bech32, bs58,
  hex, near-contract-standards (contracts); React, Vite, near-api-js, @hot-labs/near-connect, bitcoinjs-lib, ecpair,
  @bitcoinerlab/secp256k1, qrcode (web). The Bitcoin light client is Near-One's deployed contract, used as is. AI coding
  assistants were used.
- The author also builds BitGate, a P2P Bitcoin market on Stellar that verifies payments with SPV proofs. Trueque shares
  no code with it and is not submitted elsewhere in this hackathon.

## License

MIT

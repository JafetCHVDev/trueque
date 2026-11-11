# Internal security review, 2026-11-11

Scope: `contract/src/lib.rs`, `contract/src/btc.rs` (contract `trueque.testnet`), and the buyer flow of the web app.
This is a self review made during the hackathon, not an independent audit.

## Live checks

- Purchase from the public demo with an in-browser testnet wallet: offer #11, 3,000 sats for 2.22 test USDC. Light client
  proof, MPC signature verified with `ecrecover`, payout broadcast to Bitcoin testnet.
- End to end runs in NEAR and USDC: [`e2e-report-v2.json`](e2e-report-v2.json), [`e2e-report-v2-usdc.json`](e2e-report-v2-usdc.json).
- Fake deposit attack, rejected by the light client and refunded: [`attack-fake-deposit.json`](attack-fake-deposit.json).

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | Medium | The protocol fee is read when an offer settles, so the owner could raise it on offers already open. | Fixed: `set_fee_bps` can only lower the fee. Test `fee_can_only_be_lowered`. |
| 2 | Medium | A maker could call `recover` without limit with made up UTXOs; each call stores a settlement paid for by the contract's storage balance. | Fixed: at most 6 settlements per offer. Test `settlements_per_offer_are_capped`. |
| 3 | Low | `reclaim_payment` assumes no valid signature exists for the abandoned payout. MPC requests time out within minutes, and late answers are ignored, but if a signature were produced and its callback ran out of gas, the signature would be public while the contract never recorded it. | Accepted: the callback has 35 Tgas for a few Tgas of work. A mainnet version should also check, before refunding, that the deposit is still unspent. |
| 4 | Low | An open or cancelled offer keeps its storage after the bond is returned, so creating and cancelling offers in a loop costs the contract a little storage each time. The attacker pays comparable gas, so it is not profitable. | Accepted for testnet. Mainnet: keep the storage cost out of the bond. |
| 5 | Info | `min_confirmations` is 1 on testnet. Testnet difficulty is low and reorgs are cheap. | Mainnet needs 6 or more (`set_min_confirmations`). |
| 6 | Info | Anyone can call `retry_signatures`, which restarts the one hour reclaim window. It only matters while MPC is failing, and a retry that succeeds completes the trade. | By design: restarting the window is what makes reclaim safe. |

## Checked and fine

- Deposit parsing: the txid is recomputed from the stripped transaction, trailing bytes are rejected, 64 byte transactions
  are refused, the output must pay the offer's own escrow script, duplicates and coins already used are refused.
- State machine: an offer being verified can be neither cancelled nor bought again; a second buyer in the same block fails
  and gets the NEAR or tokens back (panic in `take_offer`, or unused amount in `ft_on_transfer`).
- Payouts: the maker is paid only in the callback that verifies the last signature; overpayments are returned; failed
  token payouts become claimable with `withdraw_owed`.
- Signatures: each MPC signature must recover the offer's derived key over the exact sighash before it is stored.
- Addresses: only segwit (P2WPKH, P2WSH, P2TR) for the configured network are accepted.

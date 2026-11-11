use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const MAKER_BTC: &str = "tb1qxs8qnv50kswwe76nlmvq4rshpq6uxuyqkh9nqz";
const TAKER_BTC: &str = "tb1qtfwzh58sy9n9mnl8j49y0d8t8fyu7947lykvgf";
const HASH: &str = "00000000000000000000000000000000000000000000000000000000000000aa";

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}

fn key_string(sk: &SigningKey) -> String {
    let point = sk.verifying_key().to_encoded_point(false);
    format!("secp256k1:{}", bs58::encode(&point.as_bytes()[1..]).into_string())
}

fn me() -> AccountId {
    "trueque.testnet".parse().unwrap()
}

fn usdc() -> AccountId {
    "usdc.trueque.testnet".parse().unwrap()
}

fn ctx_at(predecessor: AccountId, deposit: NearToken, ms: u64, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(predecessor)
        .attached_deposit(deposit)
        .block_timestamp(ms * 1_000_000)
        .random_seed([9u8; 32]);
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
}

fn ctx(predecessor: AccountId, deposit: NearToken) {
    ctx_at(predecessor, deposit, 1_000, vec![]);
}

/// Contract with (`lc = true`) or without a Bitcoin light client.
fn setup(lc: bool) -> Trueque {
    ctx(accounts(0), NearToken::from_yoctonear(0));
    let light_client = lc.then(|| "btc-client-v4.testnet".parse().unwrap());
    let mut c = Trueque::new("v1.signer-prod.testnet".parse().unwrap(), "testnet".into(), 30, light_client, Some(1));
    c.add_token(usdc());
    c
}

/// Opens an offer for 10_000 sats priced 1 NEAR, or 25 USDC with `token`.
fn open_offer(c: &mut Trueque, token: bool) -> u64 {
    ctx(accounts(1), OFFER_BOND);
    let price = if token { 25_000_000 } else { NearToken::from_near(1).as_yoctonear() };
    let _ = c.create_offer(10_000, U128(price), MAKER_BTC.into(), token.then(usdc));
    let id = c.next_id - 1;
    ctx(me(), NearToken::from_yoctonear(0));
    c.on_derived_key(id, Ok(key_string(&key())));
    id
}

/// A real, parseable deposit transaction paying `values` to the offer's escrow.
fn deposit(c: &Trueque, id: u64, values: &[u64]) -> Vec<DepositProof> {
    let escrow = c.offers.get(&id).unwrap().escrow_script();
    values
        .iter()
        .enumerate()
        .map(|(n, v)| {
            let inputs = vec![Input { txid: [n as u8 + 1; 32], vout: 0, value: v + 500 }];
            let outputs = vec![
                Output { value: 300, script: btc::address_to_script("testnet", MAKER_BTC).unwrap() },
                Output { value: *v, script: escrow.clone() },
            ];
            let raw = btc::signed_tx(&inputs, &outputs, &[vec![0x30, 0x01, 0x01]], &[2u8; 33]);
            DepositProof {
                raw_tx: hex::encode(raw),
                vout: 1,
                block_hash: HASH.into(),
                tx_index: 1,
                merkle_proof: vec![HASH.into()],
                coinbase_tx_id: HASH.into(),
                coinbase_merkle_proof: vec![HASH.into()],
            }
        })
        .collect()
}

fn mpc_sign(sk: &SigningKey, sighash: &[u8]) -> MpcSignature {
    let (sig, rid) = sk.sign_prehash_recoverable(sighash).unwrap();
    let bytes = sig.to_bytes();
    let mut big_r = vec![0x02];
    big_r.extend_from_slice(&bytes[..32]);
    MpcSignature {
        big_r: MpcPoint { affine_point: hex::encode(big_r) },
        s: MpcScalar { scalar: hex::encode(&bytes[32..]) },
        recovery_id: rid.to_byte(),
    }
}

fn sign_all(c: &mut Trueque, id: u64, sk: &SigningKey, settlement: usize) -> Vec<bool> {
    ctx(me(), NearToken::from_yoctonear(0));
    let hashes = c.offers.get(&id).unwrap().settlements[settlement].sighashes.clone();
    hashes
        .iter()
        .enumerate()
        .map(|(i, h)| c.on_signature(id, settlement as u32, i as u32, Ok(mpc_sign(sk, h))))
        .collect()
}

fn verdict(c: &mut Trueque, id: u64, results: Vec<PromiseResult>) -> u128 {
    ctx_at(me(), NearToken::from_yoctonear(0), 2_000, results);
    c.on_deposits_verified(id).0
}

const YES: fn() -> PromiseResult = || PromiseResult::Successful(b"true".to_vec());

#[test]
fn offer_gets_a_deposit_address() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Open);
    assert!(o.deposit_address.unwrap().starts_with("tb1q"));
}

#[test]
fn verified_trade_settles_and_produces_a_signed_tx() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    assert!(matches!(c.take_offer(id, TAKER_BTC.into(), d, 200), PromiseOrValue::Promise(_)));
    assert_eq!(c.get_offer(id).unwrap().status, Status::Verifying);
    assert_eq!(c.get_offer(id).unwrap().pending_taker, Some(accounts(2)));

    assert_eq!(verdict(&mut c, id, vec![YES()]), 0);
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Taken);
    assert_eq!(o.settlements[0].verified_confirmations, 1);
    // The amount came from the deposit transaction itself.
    assert_eq!(o.settlements[0].inputs[0].value, 10_000);

    assert_eq!(sign_all(&mut c, id, &key(), 0), vec![true]);
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Settled);
    assert_eq!(o.settlements[0].outputs[0].value, 9_800);
    let raw = o.settlements[0].raw_tx.clone().unwrap();
    // Printed for the independent bitcoinjs check in scripts/verify-vector.mjs.
    println!(
        "VECTOR {{\"raw\":\"{}\",\"pubkey\":\"{}\",\"value\":10000}}",
        raw,
        hex::encode(c.offers.get(&id).unwrap().pubkey())
    );
    assert_eq!(c.get_config().trades, 1);
}

#[test]
fn rejected_proof_refunds_and_reopens() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    // Light client panicked (e.g. not enough confirmations) or answered false.
    assert_eq!(verdict(&mut c, id, vec![PromiseResult::Failed]), NearToken::from_near(1).as_yoctonear());
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Open);
    assert!(o.settlements.is_empty());
    assert_eq!(o.pending_taker, None);
}

#[test]
fn every_deposit_must_be_proven() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[6_000, 6_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 300);
    let refund = verdict(&mut c, id, vec![YES(), PromiseResult::Successful(b"false".to_vec())]);
    assert_eq!(refund, NearToken::from_near(1).as_yoctonear());
    assert_eq!(c.get_offer(id).unwrap().status, Status::Open);
}

#[test]
#[should_panic(expected = "That output does not pay this offer's address")]
fn deposit_to_another_address_is_rejected() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let mut d = deposit(&c, id, &[10_000]);
    d[0].vout = 0; // the output paying the maker, not the escrow
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "Truncated transaction")]
fn malformed_deposit_is_rejected() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let mut d = deposit(&c, id, &[10_000]);
    d[0].raw_tx.truncate(40);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "Offer is not open")]
fn cannot_take_while_verifying() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(3), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "Only an open offer can be cancelled")]
fn maker_cannot_cancel_while_verifying() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.cancel_offer(id, vec![], 0);
}

#[test]
fn change_goes_back_to_the_maker() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[6_000, 7_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 300);
    verdict(&mut c, id, vec![YES(), YES()]);
    let outs = &c.get_offer(id).unwrap().settlements[0].outputs;
    assert_eq!(outs[0].value, 9_700);
    assert_eq!(outs[1].value, 3_000);
    assert_eq!(outs[1].address.as_deref(), Some(MAKER_BTC));
    assert_eq!(sign_all(&mut c, id, &key(), 0), vec![true, true]);
    assert_eq!(c.get_offer(id).unwrap().status, Status::Settled);
}

#[test]
fn without_light_client_the_take_is_immediate() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Taken);
    assert_eq!(o.settlements[0].verified_confirmations, 0);
}

#[test]
fn signature_from_another_key_is_rejected() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    let impostor = SigningKey::from_bytes(&[8u8; 32].into()).unwrap();
    assert_eq!(sign_all(&mut c, id, &impostor, 0), vec![false]);
    assert_eq!(c.get_offer(id).unwrap().status, Status::Taken);
    assert_eq!(sign_all(&mut c, id, &key(), 0), vec![true]);
}

#[test]
fn taker_reclaims_after_an_hour_without_signatures() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    // Anyone may trigger it; the payment always goes to the taker.
    ctx_at(accounts(4), NearToken::from_yoctonear(0), 1_000 + RECLAIM_AFTER_MS, vec![]);
    c.reclaim_payment(id);
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Open);
    assert!(o.settlements[0].voided);
    assert_eq!(o.taker, None);
    // A late MPC answer for the abandoned payout is ignored...
    assert_eq!(sign_all(&mut c, id, &key(), 0), vec![false]);
    assert!(c.get_offer(id).unwrap().settlements[0].raw_tx.is_none());
    // ...and the same deposit can be sold again.
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(3), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    assert_eq!(c.get_offer(id).unwrap().status, Status::Taken);
    assert_eq!(sign_all(&mut c, id, &key(), 1), vec![true]);
    assert_eq!(c.get_offer(id).unwrap().status, Status::Settled);
}

#[test]
#[should_panic(expected = "MPC may still answer")]
fn reclaim_too_early_is_rejected() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    ctx_at(accounts(2), NearToken::from_yoctonear(0), 1_000 + RECLAIM_AFTER_MS - 1, vec![]);
    c.reclaim_payment(id);
}

#[test]
#[should_panic(expected = "Offer is not waiting for signatures")]
fn settled_offer_cannot_be_reclaimed() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    sign_all(&mut c, id, &key(), 0);
    ctx_at(accounts(2), NearToken::from_yoctonear(0), 1_000 + RECLAIM_AFTER_MS, vec![]);
    c.reclaim_payment(id);
}

#[test]
#[should_panic(expected = "This settlement was abandoned")]
fn abandoned_settlement_cannot_be_retried() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    ctx_at(accounts(2), NearToken::from_yoctonear(0), 1_000 + RECLAIM_AFTER_MS, vec![]);
    c.reclaim_payment(id);
    c.retry_signatures(id);
}

#[test]
fn usdc_offer_settles_through_ft_transfer_call() {
    let mut c = setup(true);
    let id = open_offer(&mut c, true);
    let msg = near_sdk::serde_json::to_string(&json!({
        "id": id, "btc_address": TAKER_BTC, "fee_sats": 200,
        "deposits": deposit(&c, id, &[10_000]),
    }))
    .unwrap();
    ctx(usdc(), NearToken::from_yoctonear(0));
    assert!(matches!(c.ft_on_transfer(accounts(2), U128(26_000_000), msg), PromiseOrValue::Promise(_)));
    // Success: only the overpayment goes back.
    assert_eq!(verdict(&mut c, id, vec![YES()]), 1_000_000);
    assert_eq!(sign_all(&mut c, id, &key(), 0), vec![true]);
    let cfg = c.get_config();
    assert_eq!(cfg.token_volume, vec![(usdc(), U128(25_000_000))]);
    assert_eq!(c.get_owed(accounts(0), usdc()).0, 75_000);
}

#[test]
fn usdc_rejected_proof_returns_everything() {
    let mut c = setup(true);
    let id = open_offer(&mut c, true);
    let msg = near_sdk::serde_json::to_string(&json!({
        "id": id, "btc_address": TAKER_BTC, "fee_sats": 200,
        "deposits": deposit(&c, id, &[10_000]),
    }))
    .unwrap();
    ctx(usdc(), NearToken::from_yoctonear(0));
    let _ = c.ft_on_transfer(accounts(2), U128(25_000_000), msg);
    assert_eq!(verdict(&mut c, id, vec![PromiseResult::Failed]), 25_000_000);
    assert_eq!(c.get_offer(id).unwrap().status, Status::Open);
}

#[test]
#[should_panic(expected = "pay with ft_transfer_call")]
fn usdc_offer_cannot_be_bought_with_near() {
    let mut c = setup(true);
    let id = open_offer(&mut c, true);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "Attach the full price")]
fn underpaying_is_rejected() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_millinear(999));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "The maker cannot take their own offer")]
fn maker_cannot_take() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(1), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "The deposit does not cover the offer")]
fn underfunded_deposit_is_rejected() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[9_999]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
}

#[test]
#[should_panic(expected = "Fee below 1 sat/vB")]
fn fee_too_low_rejected() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 50);
}

#[test]
fn maker_cancels_with_refund() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.cancel_offer(id, vec![Utxo { txid: HASH.into(), vout: 1, value: 10_000 }], 200);
    let o = c.get_offer(id).unwrap();
    assert_eq!(o.status, Status::Cancelled);
    assert_eq!(o.settlements[0].kind, Kind::Refund);
    assert_eq!(sign_all(&mut c, id, &key(), 0), vec![true]);
    assert!(c.get_offer(id).unwrap().settlements[0].raw_tx.is_some());
}

#[test]
#[should_panic(expected = "UTXO already used by this offer")]
fn maker_cannot_recover_the_coins_sold() {
    let mut c = setup(false);
    let id = open_offer(&mut c, false);
    let d = deposit(&c, id, &[10_000]);
    ctx(accounts(2), NearToken::from_near(1));
    let _ = c.take_offer(id, TAKER_BTC.into(), d, 200);
    sign_all(&mut c, id, &key(), 0);
    let sold = c.get_offer(id).unwrap().settlements[0].inputs[0].txid.clone();
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.recover(id, vec![Utxo { txid: sold, vout: 1, value: 10_000 }], 200);
}

#[test]
fn failed_token_payout_becomes_claimable() {
    let mut c = setup(true);
    ctx(me(), NearToken::from_yoctonear(0));
    c.on_ft_payout(usdc(), accounts(1), U128(5_000_000), Err(PromiseError::Failed));
    assert_eq!(c.get_owed(accounts(1), usdc()).0, 5_000_000);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    let _ = c.withdraw_owed(usdc());
    assert_eq!(c.get_owed(accounts(1), usdc()).0, 0);
}

#[test]
fn list_filters_by_status() {
    let mut c = setup(true);
    open_offer(&mut c, false);
    ctx(accounts(1), OFFER_BOND);
    let _ = c.create_offer(2_000, U128(5), MAKER_BTC.into(), None);
    assert_eq!(c.list_offers(None, None, None).len(), 2);
    assert_eq!(c.list_offers(Some(Status::Open), None, None).len(), 1);
    assert_eq!(c.list_offers(Some(Status::Deriving), None, None)[0].id, 1);
}

#[test]
#[should_panic(expected = "Too many settlements for this offer")]
fn settlements_per_offer_are_capped() {
    let mut c = setup(true);
    let id = open_offer(&mut c, false);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.cancel_offer(id, vec![Utxo { txid: HASH.into(), vout: 0, value: 10_000 }], 200);
    sign_all(&mut c, id, &key(), 0);
    for vout in 1..=MAX_SETTLEMENTS as u32 {
        ctx(accounts(1), NearToken::from_yoctonear(0));
        c.recover(id, vec![Utxo { txid: HASH.into(), vout, value: 10_000 }], 200);
        sign_all(&mut c, id, &key(), vout as usize);
    }
}

#[test]
fn fee_can_only_be_lowered() {
    let mut c = setup(true);
    ctx(accounts(0), NearToken::from_yoctonear(0));
    c.set_fee_bps(10);
    assert_eq!(c.get_config().fee_bps, 10);
    let raised = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_fee_bps(30)));
    assert!(raised.is_err());
}

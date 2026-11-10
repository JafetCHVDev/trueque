use super::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const MAKER_BTC: &str = "tb1qxs8qnv50kswwe76nlmvq4rshpq6uxuyqkh9nqz";
const TAKER_BTC: &str = "tb1qtfwzh58sy9n9mnl8j49y0d8t8fyu7947lykvgf";
const DEPOSIT_TXID: &str = "5c6b07287e3a4d2f9b1e0a6c8d7f5e4b3a291807f6e5d4c3b2a1908f7e6d5c4b";

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}

fn key_string(sk: &SigningKey) -> String {
    let point = sk.verifying_key().to_encoded_point(false);
    format!("secp256k1:{}", bs58::encode(&point.as_bytes()[1..]).into_string())
}

fn ctx(predecessor: AccountId, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("trueque.testnet".parse().unwrap())
        .predecessor_account_id(predecessor)
        .attached_deposit(deposit)
        .random_seed([9u8; 32]);
    testing_env!(b.build());
}

fn me() -> AccountId {
    "trueque.testnet".parse().unwrap()
}

fn setup() -> Trueque {
    ctx(accounts(0), NearToken::from_yoctonear(0));
    Trueque::new("v1.signer-prod.testnet".parse().unwrap(), "signet".into(), 30)
}

/// Opens offer 0 (10_000 sats for 1 NEAR) with the test key as derived key.
fn open_offer(c: &mut Trueque) {
    ctx(accounts(1), OFFER_BOND);
    let _ = c.create_offer(10_000, U128(NearToken::from_near(1).as_yoctonear()), MAKER_BTC.into(), None);
    ctx(me(), NearToken::from_yoctonear(0));
    c.on_derived_key(0, Ok(key_string(&key())));
}

fn utxo(value: u64, vout: u32) -> Utxo {
    Utxo { txid: DEPOSIT_TXID.into(), vout, value }
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

fn sign_all(c: &mut Trueque, sk: &SigningKey, settlement: usize) -> Vec<bool> {
    ctx(me(), NearToken::from_yoctonear(0));
    let hashes = c.offers.get(&0).unwrap().settlements[settlement].sighashes.clone();
    hashes
        .iter()
        .enumerate()
        .map(|(i, h)| c.on_signature(0, settlement as u32, i as u32, Ok(mpc_sign(sk, h))))
        .collect()
}

#[test]
fn offer_gets_a_deposit_address() {
    let mut c = setup();
    open_offer(&mut c);
    let o = c.get_offer(0).unwrap();
    assert_eq!(o.status, Status::Open);
    let addr = o.deposit_address.unwrap();
    assert!(addr.starts_with("tb1q"), "{addr}");
    assert_eq!(o.derivation_path, format!("trueque/{}/0", c.salt));
}

#[test]
fn failed_derivation_marks_offer_failed() {
    let mut c = setup();
    ctx(accounts(1), OFFER_BOND);
    let _ = c.create_offer(10_000, U128(1), MAKER_BTC.into(), None);
    ctx(me(), NearToken::from_yoctonear(0));
    assert!(c.on_derived_key(0, Ok("garbage".into())).is_none());
    assert_eq!(c.get_offer(0).unwrap().status, Status::Failed);
}

#[test]
fn full_trade_settles_and_produces_a_signed_tx() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
    assert_eq!(c.get_offer(0).unwrap().status, Status::Taken);

    assert_eq!(sign_all(&mut c, &key(), 0), vec![true]);
    let o = c.get_offer(0).unwrap();
    assert_eq!(o.status, Status::Settled);
    let st = &o.settlements[0];
    assert_eq!(st.outputs.len(), 1);
    assert_eq!(st.outputs[0].value, 9_800);
    assert_eq!(st.outputs[0].address.as_deref(), Some(TAKER_BTC));
    assert_eq!(st.fee_sats, 200);
    let raw = st.raw_tx.clone().unwrap();
    // Printed for the independent bitcoinjs check in scripts/verify-vector.mjs.
    println!("VECTOR {{\"raw\":\"{}\",\"pubkey\":\"{}\",\"value\":10000}}", raw, hex::encode(c.offers.get(&0).unwrap().pubkey()));
    assert_eq!(c.get_config().trades, 1);
    assert_eq!(c.get_config().volume_sats, 10_000);
}

#[test]
fn change_goes_back_to_the_maker() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(6_000, 0), utxo(7_000, 1)], 300);
    let o = c.get_offer(0).unwrap();
    let outs = &o.settlements[0].outputs;
    assert_eq!(outs[0].value, 9_700);
    assert_eq!(outs[1].value, 3_000);
    assert_eq!(outs[1].address.as_deref(), Some(MAKER_BTC));
    assert_eq!(sign_all(&mut c, &key(), 0), vec![true, true]);
    assert_eq!(c.get_offer(0).unwrap().status, Status::Settled);
}

#[test]
fn signature_from_another_key_is_rejected() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
    let impostor = SigningKey::from_bytes(&[8u8; 32].into()).unwrap();
    assert_eq!(sign_all(&mut c, &impostor, 0), vec![false]);
    assert_eq!(c.get_offer(0).unwrap().status, Status::Taken);
    // The real key still completes it.
    assert_eq!(sign_all(&mut c, &key(), 0), vec![true]);
    assert_eq!(c.get_offer(0).unwrap().status, Status::Settled);
}

#[test]
#[should_panic(expected = "Attach the full price")]
fn underpaying_is_rejected() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_millinear(999));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
}

#[test]
#[should_panic(expected = "The maker cannot take their own offer")]
fn maker_cannot_take() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(1), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
}

#[test]
#[should_panic(expected = "The deposit does not cover the offer yet")]
fn underfunded_deposit_is_rejected() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(9_999, 0)], 200);
}

#[test]
#[should_panic(expected = "Offer is not open")]
fn cannot_take_twice() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
    ctx(accounts(3), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
}

#[test]
#[should_panic(expected = "Address is for a different Bitcoin network")]
fn mainnet_address_rejected_on_signet() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq".into(), vec![utxo(10_000, 0)], 200);
}

#[test]
#[should_panic(expected = "Fee below 1 sat/vB")]
fn fee_too_low_rejected() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 50);
}

#[test]
fn maker_cancels_with_refund() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.cancel_offer(0, vec![utxo(10_000, 0)], 200);
    let o = c.get_offer(0).unwrap();
    assert_eq!(o.status, Status::Cancelled);
    assert_eq!(o.settlements[0].kind, Kind::Refund);
    assert_eq!(o.settlements[0].outputs[0].address.as_deref(), Some(MAKER_BTC));
    assert_eq!(sign_all(&mut c, &key(), 0), vec![true]);
    assert!(c.get_offer(0).unwrap().settlements[0].raw_tx.is_some());
}

#[test]
#[should_panic(expected = "Offer is not open")]
fn cancelled_offer_cannot_be_taken() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.cancel_offer(0, vec![], 0);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
}

#[test]
#[should_panic(expected = "Only the maker can cancel")]
fn only_maker_cancels() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_yoctonear(0));
    c.cancel_offer(0, vec![], 0);
}

#[test]
#[should_panic(expected = "UTXO already used by this offer")]
fn maker_cannot_recover_the_coins_sold() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
    sign_all(&mut c, &key(), 0);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.recover(0, vec![utxo(10_000, 0)], 200);
}

#[test]
fn maker_recovers_a_late_extra_deposit() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
    sign_all(&mut c, &key(), 0);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    c.recover(0, vec![utxo(5_000, 7)], 200);
    assert_eq!(sign_all(&mut c, &key(), 1), vec![true]);
    let o = c.get_offer(0).unwrap();
    assert_eq!(o.settlements[1].kind, Kind::Refund);
    assert_eq!(o.settlements[1].outputs[0].value, 4_800);
}

#[test]
fn list_filters_by_status() {
    let mut c = setup();
    open_offer(&mut c);
    ctx(accounts(1), OFFER_BOND);
    let _ = c.create_offer(2_000, U128(5), MAKER_BTC.into(), None);
    assert_eq!(c.list_offers(None, None, None).len(), 2);
    assert_eq!(c.list_offers(Some(Status::Open), None, None).len(), 1);
    assert_eq!(c.list_offers(Some(Status::Deriving), None, None)[0].id, 1);
}

fn usdc() -> AccountId {
    "usdc.trueque.testnet".parse().unwrap()
}

/// Opens offer 0 priced at 25 USDC (6 decimals).
fn open_usdc_offer(c: &mut Trueque) {
    ctx(accounts(0), NearToken::from_yoctonear(0));
    c.add_token(usdc());
    ctx(accounts(1), OFFER_BOND);
    let _ = c.create_offer(10_000, U128(25_000_000), MAKER_BTC.into(), Some(usdc()));
    ctx(me(), NearToken::from_yoctonear(0));
    c.on_derived_key(0, Ok(key_string(&key())));
}

fn take_msg(fee: u64) -> String {
    format!(r#"{{"id":0,"btc_address":"{TAKER_BTC}","utxos":[{{"txid":"{DEPOSIT_TXID}","vout":0,"value":10000}}],"fee_sats":{fee}}}"#)
}

#[test]
fn usdc_offer_settles_through_ft_transfer_call() {
    let mut c = setup();
    open_usdc_offer(&mut c);
    assert_eq!(c.get_offer(0).unwrap().token, Some(usdc()));
    // The token contract calls ft_on_transfer; an overpayment of 1 USDC comes back as unused.
    ctx(usdc(), NearToken::from_yoctonear(0));
    let unused = c.ft_on_transfer(accounts(2), U128(26_000_000), take_msg(200));
    match unused {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 1_000_000),
        _ => panic!("expected a value"),
    }
    assert_eq!(c.get_offer(0).unwrap().status, Status::Taken);
    assert_eq!(c.get_offer(0).unwrap().taker, Some(accounts(2)));
    assert_eq!(sign_all(&mut c, &key(), 0), vec![true]);
    let cfg = c.get_config();
    assert_eq!(c.get_offer(0).unwrap().status, Status::Settled);
    assert_eq!(cfg.token_volume, vec![(usdc(), U128(25_000_000))]);
    assert_eq!(cfg.volume_near.0, 0);
    // 0.3% protocol fee accrues to the owner in USDC.
    assert_eq!(c.get_owed(accounts(0), usdc()).0, 75_000);
}

#[test]
#[should_panic(expected = "This offer is not priced in this token")]
fn other_token_is_rejected() {
    let mut c = setup();
    open_usdc_offer(&mut c);
    ctx("fake-usdc.testnet".parse().unwrap(), NearToken::from_yoctonear(0));
    let _ = c.ft_on_transfer(accounts(2), U128(25_000_000), take_msg(200));
}

#[test]
#[should_panic(expected = "Send the full price")]
fn usdc_underpayment_is_rejected() {
    let mut c = setup();
    open_usdc_offer(&mut c);
    ctx(usdc(), NearToken::from_yoctonear(0));
    let _ = c.ft_on_transfer(accounts(2), U128(24_999_999), take_msg(200));
}

#[test]
#[should_panic(expected = "pay with ft_transfer_call")]
fn usdc_offer_cannot_be_bought_with_near() {
    let mut c = setup();
    open_usdc_offer(&mut c);
    ctx(accounts(2), NearToken::from_near(1));
    c.take_offer(0, TAKER_BTC.into(), vec![utxo(10_000, 0)], 200);
}

#[test]
#[should_panic(expected = "Token not accepted")]
fn unlisted_token_cannot_price_offers() {
    let mut c = setup();
    ctx(accounts(1), OFFER_BOND);
    let _ = c.create_offer(10_000, U128(1), MAKER_BTC.into(), Some(usdc()));
}

#[test]
fn failed_token_payout_becomes_claimable() {
    let mut c = setup();
    ctx(me(), NearToken::from_yoctonear(0));
    c.on_ft_payout(usdc(), accounts(1), U128(5_000_000), Err(PromiseError::Failed));
    assert_eq!(c.get_owed(accounts(1), usdc()).0, 5_000_000);
    ctx(accounts(1), NearToken::from_yoctonear(0));
    let _ = c.withdraw_owed(usdc());
    assert_eq!(c.get_owed(accounts(1), usdc()).0, 0);
}

//! Trueque: peer to peer native Bitcoin for NEAR.
//!
//! A maker sells BTC for NEAR. Every offer gets its own Bitcoin deposit address,
//! derived by NEAR Chain Signatures for this contract: no person holds that key,
//! only the MPC network, and it only signs what this contract asks for.
//!
//! Lifecycle:
//! 1. `create_offer`: the contract asks the MPC contract for the derived key of
//!    the offer path and publishes the P2WPKH deposit address.
//! 2. The maker sends the BTC to that address.
//! 3. `take_offer`: a taker pays the NEAR price into the contract. The contract
//!    builds the Bitcoin transaction that pays the taker, computes the BIP143
//!    sighash of every input and asks the MPC network to sign them.
//! 4. Each signature is checked with `ecrecover` against the derived key. When
//!    every input is signed the trade settles: the maker is paid, and anyone can
//!    broadcast the signed Bitcoin transaction (`get_offer(...).settlements`).
//!
//! Once taken, an offer can only ever produce a transaction that pays the
//! taker; before that, only one that refunds the maker. Neither side can take
//! the other's money, and no operator can either.

mod btc;

use btc::{Input, Output};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

const DOMAIN_ID: u32 = 0; // secp256k1 signing domain of the MPC contract
const MIN_SATS: u64 = 1_000;
const MAX_INPUTS: usize = 4;
const MAX_FEE_BPS: u16 = 500;
/// Anti spam bond, returned to the maker when the offer closes.
const OFFER_BOND: NearToken = NearToken::from_millinear(20);
const GAS_DERIVE: Gas = Gas::from_tgas(10);
const GAS_DERIVE_CB: Gas = Gas::from_tgas(10);
const GAS_SIGN: Gas = Gas::from_tgas(15);
const GAS_SIGN_CB: Gas = Gas::from_tgas(20);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Offers,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    /// Waiting for the MPC contract to return the derived key.
    Deriving,
    /// Deposit address published; can be taken or cancelled.
    Open,
    /// Paid by a taker; waiting for the MPC signatures.
    Taken,
    /// Release transaction fully signed and the maker paid.
    Settled,
    /// Closed by the maker. A refund transaction may be attached.
    Cancelled,
    /// The key derivation failed; the bond was returned.
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// Pays the BTC to the taker.
    Release,
    /// Returns the BTC to the maker.
    Refund,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Settlement {
    kind: Kind,
    inputs: Vec<(Vec<u8>, u32, u64)>,
    outputs: Vec<(u64, Vec<u8>)>,
    sighashes: Vec<Vec<u8>>,
    sigs: Vec<Option<Vec<u8>>>,
}

impl Settlement {
    fn btc_inputs(&self) -> Vec<Input> {
        self.inputs
            .iter()
            .map(|(t, v, value)| Input { txid: t.as_slice().try_into().unwrap(), vout: *v, value: *value })
            .collect()
    }
    fn btc_outputs(&self) -> Vec<Output> {
        self.outputs.iter().map(|(value, script)| Output { value: *value, script: script.clone() }).collect()
    }
    fn complete(&self) -> bool {
        self.sigs.iter().all(Option::is_some)
    }
}

#[near(serializers = [borsh])]
pub struct Offer {
    maker: AccountId,
    sats: u64,
    price: u128,
    bond: u128,
    maker_address: String,
    maker_script: Vec<u8>,
    path: String,
    /// Uncompressed (x || y) derived public key, 64 bytes.
    pubkey_xy: Option<Vec<u8>>,
    status: Status,
    created_ms: u64,
    taker: Option<AccountId>,
    taker_address: Option<String>,
    settlements: Vec<Settlement>,
}

impl Offer {
    fn pubkey(&self) -> [u8; 33] {
        let xy: [u8; 64] = self.pubkey_xy.as_ref().expect("No key yet").as_slice().try_into().unwrap();
        btc::compress(&xy)
    }
}

#[near(serializers = [json])]
pub struct Utxo {
    /// Display order txid hex.
    pub txid: String,
    pub vout: u32,
    pub value: u64,
}

#[near(serializers = [json])]
pub struct MpcPoint {
    affine_point: String,
}

#[near(serializers = [json])]
pub struct MpcScalar {
    scalar: String,
}

/// Secp256k1 signature returned by the MPC contract.
#[near(serializers = [json])]
pub struct MpcSignature {
    big_r: MpcPoint,
    s: MpcScalar,
    recovery_id: u8,
}

#[near(serializers = [json])]
pub struct OutputView {
    pub address: Option<String>,
    pub value: u64,
}

#[near(serializers = [json])]
pub struct SettlementView {
    pub kind: Kind,
    pub inputs: Vec<Utxo>,
    pub outputs: Vec<OutputView>,
    pub fee_sats: u64,
    pub signed: usize,
    pub total: usize,
    pub txid: String,
    /// Fully signed transaction hex, present once every input is signed.
    pub raw_tx: Option<String>,
}

#[near(serializers = [json])]
pub struct OfferView {
    pub id: u64,
    pub maker: AccountId,
    pub sats: u64,
    pub price: U128,
    pub maker_address: String,
    pub deposit_address: Option<String>,
    pub derivation_path: String,
    pub status: Status,
    pub created_ms: u64,
    pub taker: Option<AccountId>,
    pub taker_address: Option<String>,
    pub settlements: Vec<SettlementView>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub mpc_contract: AccountId,
    pub network: String,
    pub fee_bps: u16,
    pub offer_bond: U128,
    pub offers: u64,
    pub trades: u64,
    pub volume_sats: u64,
    pub volume_near: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Trueque {
    owner: AccountId,
    mpc: AccountId,
    network: String,
    /// Mixed into every derivation path so a redeploy never reuses addresses.
    salt: String,
    fee_bps: u16,
    offers: IterableMap<u64, Offer>,
    next_id: u64,
    trades: u64,
    volume_sats: u64,
    volume_near: u128,
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    log!("EVENT_JSON:{}", json!({"standard": "trueque", "version": "1.0.0", "event": name, "data": [data]}));
}

#[near]
impl Trueque {
    #[init]
    pub fn new(mpc_contract: AccountId, network: String, fee_bps: u16) -> Self {
        require!(network == "mainnet" || network == "testnet" || network == "signet", "Unknown network");
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        Self {
            owner: env::predecessor_account_id(),
            mpc: mpc_contract,
            network,
            salt: hex::encode(&env::random_seed()[..4]),
            fee_bps,
            offers: IterableMap::new(Key::Offers),
            next_id: 0,
            trades: 0,
            volume_sats: 0,
            volume_near: 0,
        }
    }

    // ---------------------------------------------------------------- maker

    /// Open an offer to sell `sats` for `price` yoctoNEAR. `refund_address` is
    /// where the maker gets the BTC back (refund or change). Attach the bond.
    #[payable]
    pub fn create_offer(&mut self, sats: u64, price: U128, refund_address: String) -> Promise {
        let bond = env::attached_deposit();
        require!(bond >= OFFER_BOND, "Attach the 0.02 NEAR offer bond");
        require!(sats >= MIN_SATS, "Offer at least 1000 sats");
        require!(sats <= 2_100_000_000_000_000, "Too many sats");
        require!(price.0 > 0, "Price must be positive");
        let maker_script = btc::address_to_script(&self.network, &refund_address).unwrap_or_else(|e| env::panic_str(e));

        let id = self.next_id;
        self.next_id += 1;
        let path = format!("trueque/{}/{}", self.salt, id);
        self.offers.insert(
            id,
            Offer {
                maker: env::predecessor_account_id(),
                sats,
                price: price.0,
                bond: bond.as_yoctonear(),
                maker_address: refund_address,
                maker_script,
                path: path.clone(),
                pubkey_xy: None,
                status: Status::Deriving,
                created_ms: env::block_timestamp_ms(),
                taker: None,
                taker_address: None,
                settlements: vec![],
            },
        );

        let args = json!({"path": path, "predecessor": env::current_account_id(), "domain_id": DOMAIN_ID});
        Promise::new(self.mpc.clone())
            .function_call("derived_public_key", args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_DERIVE)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_DERIVE_CB).on_derived_key(id))
    }

    #[private]
    pub fn on_derived_key(&mut self, id: u64, #[callback_result] key: Result<String, PromiseError>) -> Option<OfferView> {
        let network = self.network.clone();
        let offer = self.offers.get_mut(&id).expect("No offer");
        let parsed = key.ok().and_then(|k| {
            let b58 = k.strip_prefix("secp256k1:")?;
            let bytes = bs58::decode(b58).into_vec().ok()?;
            (bytes.len() == 64).then_some(bytes)
        });
        match parsed {
            Some(xy) => {
                offer.pubkey_xy = Some(xy);
                offer.status = Status::Open;
                let address = btc::p2wpkh_address(&network, &offer.pubkey());
                event(
                    "offer_created",
                    json!({"id": id, "maker": offer.maker, "sats": offer.sats, "price": U128(offer.price), "deposit_address": address}),
                );
                self.get_offer(id)
            }
            None => {
                offer.status = Status::Failed;
                let (maker, bond) = (offer.maker.clone(), offer.bond);
                Promise::new(maker).transfer(NearToken::from_yoctonear(bond)).detach();
                event("offer_failed", json!({"id": id}));
                None
            }
        }
    }

    /// Close an open offer. With `utxos` (the deposits at the offer address),
    /// the contract signs a refund to the maker's address; without, it simply
    /// closes. Only the maker can cancel, and only before it is taken.
    pub fn cancel_offer(&mut self, id: u64, utxos: Vec<Utxo>, fee_sats: u64) {
        let offer = self.offers.get_mut(&id).expect("No offer");
        require!(env::predecessor_account_id() == offer.maker, "Only the maker can cancel");
        require!(offer.status == Status::Open, "Only an open offer can be cancelled");
        offer.status = Status::Cancelled;
        let (maker, bond) = (offer.maker.clone(), offer.bond);
        Promise::new(maker).transfer(NearToken::from_yoctonear(bond)).detach();
        event("offer_cancelled", json!({"id": id}));
        if !utxos.is_empty() {
            self.push_refund(id, utxos, fee_sats);
        }
    }

    /// Sweep BTC still sitting at a closed offer's address (a late or extra
    /// deposit) back to the maker. Coins already spent by an earlier settlement
    /// of this offer can never be signed again.
    pub fn recover(&mut self, id: u64, utxos: Vec<Utxo>, fee_sats: u64) {
        let offer = self.offers.get(&id).expect("No offer");
        require!(env::predecessor_account_id() == offer.maker, "Only the maker can recover");
        require!(matches!(offer.status, Status::Settled | Status::Cancelled), "Offer is still active");
        require!(offer.settlements.iter().all(Settlement::complete), "A settlement is still being signed");
        require!(!utxos.is_empty(), "Nothing to recover");
        self.push_refund(id, utxos, fee_sats);
    }

    // ---------------------------------------------------------------- taker

    /// Buy the offer: attach its price in NEAR, name the Bitcoin address to be
    /// paid and the deposit UTXOs at the offer address (their exact values; the
    /// signatures commit to them). `fee_sats` is the Bitcoin miner fee, paid
    /// out of the sats received.
    #[payable]
    pub fn take_offer(&mut self, id: u64, btc_address: String, utxos: Vec<Utxo>, fee_sats: u64) {
        let network = self.network.clone();
        let taker = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let offer = self.offers.get_mut(&id).expect("No offer");
        require!(offer.status == Status::Open, "Offer is not open");
        require!(taker != offer.maker, "The maker cannot take their own offer");
        require!(paid >= offer.price, "Attach the full price");
        let taker_script = btc::address_to_script(&network, &btc_address).unwrap_or_else(|e| env::panic_str(e));

        let inputs = parse_utxos(&utxos, &offer.settlements);
        let total: u64 = inputs.iter().map(|i| i.value).sum();
        require!(total >= offer.sats, "The deposit does not cover the offer yet");

        let mut outputs = vec![Output { value: 0, script: taker_script }];
        let change = total - offer.sats;
        if change >= btc::DUST {
            outputs.push(Output { value: change, script: offer.maker_script.clone() });
        }
        check_fee(fee_sats, inputs.len(), &outputs, offer.sats);
        outputs[0].value = offer.sats - fee_sats;

        if paid > offer.price {
            Promise::new(taker.clone()).transfer(NearToken::from_yoctonear(paid - offer.price)).detach();
        }
        offer.status = Status::Taken;
        offer.taker = Some(taker.clone());
        offer.taker_address = Some(btc_address.clone());
        let s_idx = push_settlement(offer, Kind::Release, inputs, outputs);
        event("offer_taken", json!({"id": id, "taker": taker, "btc_address": btc_address}));
        self.sign_missing(id, s_idx);
    }

    // ---------------------------------------------------------------- signing

    /// Ask the MPC network again for any signature still missing on the latest
    /// settlement of an offer (for example after an MPC timeout). Anyone can call.
    pub fn retry_signatures(&mut self, id: u64) {
        let offer = self.offers.get(&id).expect("No offer");
        require!(!offer.settlements.is_empty(), "Nothing to sign");
        let s_idx = offer.settlements.len() - 1;
        require!(!offer.settlements[s_idx].complete(), "Already fully signed");
        self.sign_missing(id, s_idx as u32);
    }

    #[private]
    pub fn on_signature(
        &mut self,
        id: u64,
        settlement: u32,
        input: u32,
        #[callback_result] sig: Result<MpcSignature, PromiseError>,
    ) -> bool {
        let Ok(sig) = sig else {
            log!("MPC did not sign offer {} input {}: call retry_signatures", id, input);
            return false;
        };
        let offer = self.offers.get_mut(&id).expect("No offer");
        let xy = offer.pubkey_xy.clone().unwrap();
        let st = &mut offer.settlements[settlement as usize];
        let (Ok(big_r), Ok(s)) = (hex::decode(&sig.big_r.affine_point), hex::decode(&sig.s.scalar)) else {
            log!("Malformed MPC signature");
            return false;
        };
        if big_r.len() != 33 || s.len() != 32 {
            log!("Malformed MPC signature");
            return false;
        }
        let r: [u8; 32] = big_r[1..].try_into().unwrap();
        let s: [u8; 32] = s.as_slice().try_into().unwrap();
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&r);
        rs[32..].copy_from_slice(&s);
        // Never trust, verify: the signature must recover the offer's own key.
        let recovered = env::ecrecover(&st.sighashes[input as usize], &rs, sig.recovery_id, true);
        if recovered.map(|k| k.to_vec()) != Some(xy) {
            log!("MPC signature does not match the offer key");
            return false;
        }
        st.sigs[input as usize] = Some(btc::der_sig(&r, &s));
        if st.complete() {
            self.finalize(id, settlement as usize);
        }
        true
    }

    // ---------------------------------------------------------------- views

    pub fn get_offer(&self, id: u64) -> Option<OfferView> {
        self.offers.get(&id).map(|o| self.view(id, o))
    }

    /// Offers newest first. `status` filters, for example "Open".
    pub fn list_offers(&self, status: Option<Status>, from_id: Option<u64>, limit: Option<u64>) -> Vec<OfferView> {
        let limit = limit.unwrap_or(50).min(100) as usize;
        let start = from_id.map(|f| f.saturating_add(1)).unwrap_or(self.next_id).min(self.next_id);
        (0..start)
            .rev()
            .filter_map(|id| self.offers.get(&id).map(|o| (id, o)))
            .filter(|(_, o)| status.map_or(true, |s| o.status == s))
            .take(limit)
            .map(|(id, o)| self.view(id, o))
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            mpc_contract: self.mpc.clone(),
            network: self.network.clone(),
            fee_bps: self.fee_bps,
            offer_bond: U128(OFFER_BOND.as_yoctonear()),
            offers: self.next_id,
            trades: self.trades,
            volume_sats: self.volume_sats,
            volume_near: U128(self.volume_near),
        }
    }

    // ---------------------------------------------------------------- owner

    pub fn set_fee_bps(&mut self, fee_bps: u16) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        self.fee_bps = fee_bps;
    }
}

impl Trueque {
    fn push_refund(&mut self, id: u64, utxos: Vec<Utxo>, fee_sats: u64) {
        let offer = self.offers.get_mut(&id).unwrap();
        let inputs = parse_utxos(&utxos, &offer.settlements);
        let total: u64 = inputs.iter().map(|i| i.value).sum();
        let mut outputs = vec![Output { value: 0, script: offer.maker_script.clone() }];
        check_fee(fee_sats, inputs.len(), &outputs, total);
        outputs[0].value = total - fee_sats;
        let s_idx = push_settlement(offer, Kind::Refund, inputs, outputs);
        event("refund_requested", json!({"id": id, "settlement": s_idx}));
        self.sign_missing(id, s_idx);
    }

    fn sign_missing(&self, id: u64, s_idx: u32) {
        let offer = self.offers.get(&id).unwrap();
        let st = &offer.settlements[s_idx as usize];
        for (i, sig) in st.sigs.iter().enumerate() {
            if sig.is_some() {
                continue;
            }
            let args = json!({"request": {
                "path": offer.path,
                "payload_v2": {"Ecdsa": hex::encode(&st.sighashes[i])},
                "domain_id": DOMAIN_ID,
            }});
            Promise::new(self.mpc.clone())
                .function_call("sign", args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_SIGN)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_SIGN_CB).on_signature(id, s_idx, i as u32))
                .detach();
        }
    }

    fn finalize(&mut self, id: u64, s_idx: usize) {
        let fee_bps = self.fee_bps as u128;
        let offer = self.offers.get_mut(&id).unwrap();
        let st = &offer.settlements[s_idx];
        let txid = btc::txid_hex(&st.btc_inputs(), &st.btc_outputs());
        let kind = st.kind;
        match kind {
            Kind::Release if offer.status == Status::Taken => {
                offer.status = Status::Settled;
                let fee = offer.price * fee_bps / 10_000;
                let to_maker = offer.price - fee + offer.bond;
                Promise::new(offer.maker.clone()).transfer(NearToken::from_yoctonear(to_maker)).detach();
                if fee > 0 {
                    Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(fee)).detach();
                }
                let (sats, price) = (offer.sats, offer.price);
                self.trades += 1;
                self.volume_sats += sats;
                self.volume_near += price;
                event("offer_settled", json!({"id": id, "btc_txid": txid, "sats": sats, "price": U128(price)}));
            }
            _ => event("refund_signed", json!({"id": id, "btc_txid": txid})),
        }
    }

    fn view(&self, id: u64, o: &Offer) -> OfferView {
        let pubkey = o.pubkey_xy.as_ref().map(|_| o.pubkey());
        OfferView {
            id,
            maker: o.maker.clone(),
            sats: o.sats,
            price: U128(o.price),
            maker_address: o.maker_address.clone(),
            deposit_address: pubkey.map(|pk| btc::p2wpkh_address(&self.network, &pk)),
            derivation_path: o.path.clone(),
            status: o.status,
            created_ms: o.created_ms,
            taker: o.taker.clone(),
            taker_address: o.taker_address.clone(),
            settlements: o
                .settlements
                .iter()
                .map(|st| {
                    let (ins, outs) = (st.btc_inputs(), st.btc_outputs());
                    let total_in: u64 = ins.iter().map(|i| i.value).sum();
                    let total_out: u64 = outs.iter().map(|o| o.value).sum();
                    let raw_tx = if st.complete() {
                        let sigs: Vec<Vec<u8>> = st.sigs.iter().map(|s| s.clone().unwrap()).collect();
                        Some(hex::encode(btc::signed_tx(&ins, &outs, &sigs, &pubkey.unwrap())))
                    } else {
                        None
                    };
                    SettlementView {
                        kind: st.kind,
                        inputs: ins
                            .iter()
                            .map(|i| Utxo { txid: btc::display_txid(&i.txid), vout: i.vout, value: i.value })
                            .collect(),
                        outputs: outs
                            .iter()
                            .map(|out| OutputView {
                                address: btc::script_to_address(&self.network, &out.script),
                                value: out.value,
                            })
                            .collect(),
                        fee_sats: total_in - total_out,
                        signed: st.sigs.iter().filter(|s| s.is_some()).count(),
                        total: st.sigs.len(),
                        txid: btc::txid_hex(&ins, &outs),
                        raw_tx,
                    }
                })
                .collect(),
        }
    }
}

fn parse_utxos(utxos: &[Utxo], previous: &[Settlement]) -> Vec<Input> {
    require!(!utxos.is_empty(), "List the deposit UTXOs");
    require!(utxos.len() <= MAX_INPUTS, "At most 4 deposit UTXOs");
    let mut inputs: Vec<Input> = Vec::with_capacity(utxos.len());
    for u in utxos {
        let txid = btc::parse_txid(&u.txid).unwrap_or_else(|e| env::panic_str(e));
        require!(u.value > 0, "Zero value UTXO");
        require!(!inputs.iter().any(|i| i.txid == txid && i.vout == u.vout), "Duplicate UTXO");
        let spent = previous.iter().flat_map(|s| s.inputs.iter()).any(|(t, v, _)| t.as_slice() == txid && *v == u.vout);
        require!(!spent, "UTXO already used by this offer");
        inputs.push(Input { txid, vout: u.vout, value: u.value });
    }
    inputs
}

/// The fee must pay at least 1 sat/vB, stay under a quarter of the amount and
/// leave a non dust payment.
fn check_fee(fee_sats: u64, n_in: usize, outputs: &[Output], amount: u64) {
    require!(fee_sats >= btc::vsize(n_in, outputs), "Fee below 1 sat/vB");
    require!(fee_sats <= amount / 4, "Fee above 25% of the amount");
    require!(amount - fee_sats >= btc::DUST, "Payment would be dust");
}

fn push_settlement(offer: &mut Offer, kind: Kind, inputs: Vec<Input>, outputs: Vec<Output>) -> u32 {
    let pk = offer.pubkey();
    let pkh = btc::hash160(&pk);
    let sighashes = (0..inputs.len()).map(|i| btc::sighash_p2wpkh(&inputs, &outputs, i, &pkh).to_vec()).collect();
    offer.settlements.push(Settlement {
        kind,
        sigs: vec![None; inputs.len()],
        inputs: inputs.into_iter().map(|i| (i.txid.to_vec(), i.vout, i.value)).collect(),
        outputs: outputs.into_iter().map(|o| (o.value, o.script)).collect(),
        sighashes,
    });
    (offer.settlements.len() - 1) as u32
}

#[cfg(test)]
mod tests;

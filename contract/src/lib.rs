//! Trueque: peer to peer native Bitcoin for NEAR.
//!
//! A maker sells BTC for USDC or NEAR. Every offer gets its own Bitcoin
//! deposit address, derived by NEAR Chain Signatures for this contract: no
//! person holds that key, only the MPC network, and it only signs what this
//! contract asks for.
//!
//! Lifecycle:
//! 1. `create_offer`: the contract asks the MPC contract for the derived key of
//!    the offer path and publishes the P2WPKH deposit address.
//! 2. The maker sends the BTC to that address.
//! 3. `take_offer` (NEAR) or `ft_transfer_call` (token): a taker pays the price
//!    and hands in the raw deposit transaction with an SPV proof. The contract
//!    parses the transaction itself (txid, amount, escrow output) and asks a
//!    Bitcoin light client on NEAR to confirm the transaction sits in a block
//!    with enough confirmations. If it does not, the payment is returned.
//! 4. The contract builds the Bitcoin transaction that pays the taker, computes
//!    the BIP143 sighash of every input and asks MPC to sign them. Each
//!    signature is checked with `ecrecover`. When all are in, the maker is paid
//!    and anyone can broadcast the signed transaction.
//! 5. If MPC has not delivered every signature an hour after the last request,
//!    `reclaim_payment` returns the taker's payment and reopens the offer.
//!
//! Once taken, an offer can only produce a transaction that pays the taker;
//! before that, only one that refunds the maker.

mod btc;

use btc::{Input, Output};
use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

const DOMAIN_ID: u32 = 0; // secp256k1 signing domain of the MPC contract
const MIN_SATS: u64 = 1_000;
const MAX_INPUTS: usize = 2;
const MAX_FEE_BPS: u16 = 500;
/// A taker can reclaim the payment if MPC has not signed this long after the
/// last request. MPC sign requests expire within minutes, so no signature can
/// appear after this point.
const RECLAIM_AFTER_MS: u64 = 60 * 60 * 1000;
/// Anti spam bond, returned to the maker when the offer closes.
const OFFER_BOND: NearToken = NearToken::from_millinear(20);
const GAS_DERIVE: Gas = Gas::from_tgas(10);
const GAS_DERIVE_CB: Gas = Gas::from_tgas(10);
const GAS_SIGN: Gas = Gas::from_tgas(15);
const GAS_SIGN_CB: Gas = Gas::from_tgas(35);
const GAS_VERIFY: Gas = Gas::from_tgas(15);
const GAS_VERIFIED_CB_BASE: Gas = Gas::from_tgas(25);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FT_CB: Gas = Gas::from_tgas(5);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Offers,
    Tokens,
    OfferToken,
    Owed,
    TokenVolume,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    /// Waiting for the MPC contract to return the derived key.
    Deriving,
    /// Deposit address published; can be taken or cancelled.
    Open,
    /// A taker paid; the Bitcoin light client is checking the deposit.
    Verifying,
    /// Deposit verified; waiting for the MPC signatures.
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
    /// Block timestamp (ms) of the last MPC sign request.
    requested_ms: u64,
    /// Abandoned by `reclaim_payment`; never signed again.
    voided: bool,
    /// Confirmations proven by the Bitcoin light client (0 if unverified).
    verified_confirmations: u64,
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

/// A purchase whose deposit proof is with the light client.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct PendingTake {
    taker: AccountId,
    btc_address: String,
    fee_sats: u64,
    inputs: Vec<(Vec<u8>, u32, u64)>,
    paid: u128,
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
    pending: Option<PendingTake>,
    settlements: Vec<Settlement>,
}

impl Offer {
    fn pubkey(&self) -> [u8; 33] {
        let xy: [u8; 64] = self.pubkey_xy.as_ref().expect("No key yet").as_slice().try_into().unwrap();
        btc::compress(&xy)
    }
    fn escrow_script(&self) -> Vec<u8> {
        let mut s = vec![0x00, 0x14];
        s.extend_from_slice(&btc::hash160(&self.pubkey()));
        s
    }
    fn live_settlements(&self) -> impl Iterator<Item = &Settlement> {
        self.settlements.iter().filter(|s| !s.voided)
    }
}

#[near(serializers = [json])]
pub struct Utxo {
    /// Display order txid hex.
    pub txid: String,
    pub vout: u32,
    pub value: u64,
}

/// A deposit at the offer address, proven to be in the Bitcoin chain.
/// Hashes are display order hex, as block explorers show them.
#[near(serializers = [json])]
pub struct DepositProof {
    /// The whole deposit transaction. Amount and recipient are read from it.
    pub raw_tx: String,
    /// Output of `raw_tx` that pays the offer address.
    pub vout: u32,
    pub block_hash: String,
    pub tx_index: u64,
    pub merkle_proof: Vec<String>,
    pub coinbase_tx_id: String,
    pub coinbase_merkle_proof: Vec<String>,
}

/// `verify_transaction_inclusion_v2` arguments of the Near-One light client.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct LightClientProof {
    tx_id: [u8; 32],
    tx_block_blockhash: [u8; 32],
    tx_index: u64,
    merkle_proof: Vec<[u8; 32]>,
    coinbase_tx_id: [u8; 32],
    coinbase_merkle_proof: Vec<[u8; 32]>,
    confirmations: u64,
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
    pub requested_ms: u64,
    pub voided: bool,
    pub verified_confirmations: u64,
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
    /// NEP-141 token the price is in; `None` means NEAR.
    pub token: Option<AccountId>,
    /// While `Verifying`: who is buying.
    pub pending_taker: Option<AccountId>,
    pub settlements: Vec<SettlementView>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub mpc_contract: AccountId,
    pub network: String,
    pub light_client: Option<AccountId>,
    pub min_confirmations: u64,
    pub fee_bps: u16,
    pub offer_bond: U128,
    pub reclaim_after_ms: u64,
    pub offers: u64,
    pub trades: u64,
    pub volume_sats: u64,
    pub volume_near: U128,
    pub tokens: Vec<AccountId>,
    pub token_volume: Vec<(AccountId, U128)>,
}

/// Arguments of a token purchase, sent as the `msg` of `ft_transfer_call`.
#[near(serializers = [json])]
pub struct TakeMsg {
    pub id: u64,
    pub btc_address: String,
    pub deposits: Vec<DepositProof>,
    pub fee_sats: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Trueque {
    owner: AccountId,
    mpc: AccountId,
    network: String,
    /// Bitcoin light client that proves deposits (`None`: trust the taker's
    /// own check, only for networks without one, such as signet).
    light_client: Option<AccountId>,
    min_confirmations: u64,
    /// Mixed into every derivation path so a redeploy never reuses addresses.
    salt: String,
    fee_bps: u16,
    offers: IterableMap<u64, Offer>,
    next_id: u64,
    trades: u64,
    volume_sats: u64,
    volume_near: u128,
    /// Stablecoins (NEP-141) offers can be priced in.
    tokens: IterableSet<AccountId>,
    offer_token: LookupMap<u64, AccountId>,
    /// Token payouts that failed (for example an unregistered receiver), keyed
    /// "account:token", claimable with `withdraw_owed`.
    owed: LookupMap<String, u128>,
    token_volume: IterableMap<AccountId, u128>,
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    log!("EVENT_JSON:{}", json!({"standard": "trueque", "version": "2.0.0", "event": name, "data": [data]}));
}

#[near]
impl Trueque {
    #[init]
    pub fn new(
        mpc_contract: AccountId,
        network: String,
        fee_bps: u16,
        light_client: Option<AccountId>,
        min_confirmations: Option<u64>,
    ) -> Self {
        require!(network == "mainnet" || network == "testnet" || network == "signet", "Unknown network");
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        Self {
            owner: env::predecessor_account_id(),
            mpc: mpc_contract,
            network,
            light_client,
            min_confirmations: min_confirmations.unwrap_or(1).max(1),
            salt: hex::encode(&env::random_seed()[..4]),
            fee_bps,
            offers: IterableMap::new(Key::Offers),
            next_id: 0,
            trades: 0,
            volume_sats: 0,
            volume_near: 0,
            tokens: IterableSet::new(Key::Tokens),
            offer_token: LookupMap::new(Key::OfferToken),
            owed: LookupMap::new(Key::Owed),
            token_volume: IterableMap::new(Key::TokenVolume),
        }
    }

    // ---------------------------------------------------------------- maker

    /// Open an offer to sell `sats` for `price`, in yoctoNEAR or, with `token`,
    /// in base units of that NEP-141 stablecoin. `refund_address` is where the
    /// maker gets the BTC back (refund or change). Attach the bond.
    #[payable]
    pub fn create_offer(&mut self, sats: u64, price: U128, refund_address: String, token: Option<AccountId>) -> Promise {
        let bond = env::attached_deposit();
        require!(bond >= OFFER_BOND, "Attach the 0.02 NEAR offer bond");
        require!(sats >= MIN_SATS, "Offer at least 1000 sats");
        require!(sats <= 2_100_000_000_000_000, "Too many sats");
        require!(price.0 > 0, "Price must be positive");
        let maker_script = btc::address_to_script(&self.network, &refund_address).unwrap_or_else(|e| env::panic_str(e));

        let id = self.next_id;
        self.next_id += 1;
        if let Some(t) = token {
            require!(self.tokens.contains(&t), "Token not accepted");
            self.offer_token.insert(id, t);
        }
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
                pending: None,
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
    /// closes. Only the maker can cancel, and only while nobody is buying.
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
        require!(offer.live_settlements().all(Settlement::complete), "A settlement is still being signed");
        require!(!utxos.is_empty(), "Nothing to recover");
        self.push_refund(id, utxos, fee_sats);
    }

    // ---------------------------------------------------------------- taker

    /// Buy a NEAR priced offer: attach the price, name the Bitcoin address to
    /// be paid and prove the deposit. `fee_sats` is the Bitcoin miner fee, paid
    /// out of the sats received. If the light client rejects the proof, the
    /// NEAR comes back.
    #[payable]
    pub fn take_offer(&mut self, id: u64, btc_address: String, deposits: Vec<DepositProof>, fee_sats: u64) -> PromiseOrValue<U128> {
        require!(self.offer_token.get(&id).is_none(), "This offer is priced in a token: pay with ft_transfer_call");
        let paid = env::attached_deposit().as_yoctonear();
        let price = self.offers.get(&id).expect("No offer").price;
        require!(paid >= price, "Attach the full price");
        self.begin_take(id, env::predecessor_account_id(), btc_address, deposits, fee_sats, paid)
    }

    /// NEP-141 receiver: buying a token priced offer. `msg` is a `TakeMsg`.
    /// The returned (or promised) amount is what the token sends back: the
    /// overpayment on success, everything if the deposit proof fails.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let take: TakeMsg = near_sdk::serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("Invalid msg"));
        require!(self.offer_token.get(&take.id) == Some(&token), "This offer is not priced in this token");
        let price = self.offers.get(&take.id).expect("No offer").price;
        require!(amount.0 >= price, "Send the full price");
        self.begin_take(take.id, sender_id, take.btc_address, take.deposits, take.fee_sats, amount.0)
    }

    /// Light client verdicts on every deposit of a pending purchase.
    #[private]
    pub fn on_deposits_verified(&mut self, id: u64) -> U128 {
        let n = env::promise_results_count();
        let mut ok = n > 0;
        for i in 0..n {
            // The light client answers a JSON bool, or panics (no proof, not
            // enough confirmations): anything else counts as rejected.
            let verified = match env::promise_result_checked(i, 16) {
                Ok(bytes) => near_sdk::serde_json::from_slice::<bool>(&bytes).unwrap_or(false),
                Err(_) => false,
            };
            ok &= verified;
        }
        self.settle_pending(id, ok)
    }

    /// Get the payment back if MPC has not signed the payout an hour after the
    /// last request. Anyone can call it; the money always goes to the taker.
    /// The offer reopens with its deposit untouched.
    pub fn reclaim_payment(&mut self, id: u64) {
        let now = env::block_timestamp_ms();
        let offer = self.offers.get_mut(&id).expect("No offer");
        require!(offer.status == Status::Taken, "Offer is not waiting for signatures");
        let st = offer.settlements.last_mut().expect("No settlement");
        require!(st.kind == Kind::Release && !st.voided && !st.complete(), "Nothing to reclaim");
        require!(now >= st.requested_ms + RECLAIM_AFTER_MS, "MPC may still answer: wait an hour after the last request");
        st.voided = true;
        let taker = offer.taker.take().expect("No taker");
        offer.taker_address = None;
        offer.status = Status::Open;
        let price = offer.price;
        self.pay(id, taker.clone(), price);
        event("payment_reclaimed", json!({"id": id, "taker": taker}));
    }

    /// Claim a token payout that could not be delivered (for example because
    /// the receiver was not registered with the token yet).
    pub fn withdraw_owed(&mut self, token: AccountId) -> Promise {
        let who = env::predecessor_account_id();
        let key = format!("{}:{}", who, token);
        let amount = self.owed.remove(&key).unwrap_or(0);
        require!(amount > 0, "Nothing owed");
        self.ft_payout(token, who, amount)
    }

    #[private]
    pub fn on_ft_payout(&mut self, token: AccountId, receiver: AccountId, amount: U128, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            let key = format!("{}:{}", receiver, token);
            let prev = self.owed.get(&key).copied().unwrap_or(0);
            self.owed.insert(key, prev + amount.0);
            event("payout_owed", json!({"receiver": receiver, "token": token, "amount": amount}));
        }
    }

    // ---------------------------------------------------------------- signing

    /// Ask the MPC network again for any signature still missing on the latest
    /// settlement of an offer (for example after an MPC timeout). Anyone can call.
    pub fn retry_signatures(&mut self, id: u64) {
        let offer = self.offers.get(&id).expect("No offer");
        let s_idx = offer.settlements.len().checked_sub(1).expect("Nothing to sign");
        let st = &offer.settlements[s_idx];
        require!(!st.voided, "This settlement was abandoned");
        require!(!st.complete(), "Already fully signed");
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
        if st.voided {
            log!("Settlement was abandoned; ignoring the signature");
            return false;
        }
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
            light_client: self.light_client.clone(),
            min_confirmations: self.min_confirmations,
            fee_bps: self.fee_bps,
            offer_bond: U128(OFFER_BOND.as_yoctonear()),
            reclaim_after_ms: RECLAIM_AFTER_MS,
            offers: self.next_id,
            trades: self.trades,
            volume_sats: self.volume_sats,
            volume_near: U128(self.volume_near),
            tokens: self.tokens.iter().cloned().collect(),
            token_volume: self.token_volume.iter().map(|(t, v)| (t.clone(), U128(*v))).collect(),
        }
    }

    pub fn get_owed(&self, account_id: AccountId, token: AccountId) -> U128 {
        U128(self.owed.get(&format!("{}:{}", account_id, token)).copied().unwrap_or(0))
    }

    // ---------------------------------------------------------------- owner

    pub fn set_fee_bps(&mut self, fee_bps: u16) {
        self.assert_owner();
        require!(fee_bps <= MAX_FEE_BPS, "Fee too high");
        self.fee_bps = fee_bps;
    }

    /// Accept a NEP-141 stablecoin for prices. The contract must be registered
    /// with the token (storage_deposit) to receive it.
    pub fn add_token(&mut self, token: AccountId) {
        self.assert_owner();
        self.tokens.insert(token);
    }

    pub fn set_min_confirmations(&mut self, min_confirmations: u64) {
        self.assert_owner();
        require!(min_confirmations >= 1, "At least one confirmation");
        self.min_confirmations = min_confirmations;
    }
}

impl Trueque {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "Owner only");
    }

    /// Validates a purchase and, with a light client, sends every deposit proof
    /// to it. Without one (signet), settles right away from the parsed deposits.
    fn begin_take(
        &mut self,
        id: u64,
        taker: AccountId,
        btc_address: String,
        deposits: Vec<DepositProof>,
        fee_sats: u64,
        paid: u128,
    ) -> PromiseOrValue<U128> {
        let network = self.network.clone();
        let confirmations = self.min_confirmations;
        let offer = self.offers.get_mut(&id).expect("No offer");
        require!(offer.status == Status::Open, "Offer is not open");
        require!(taker != offer.maker, "The maker cannot take their own offer");
        btc::address_to_script(&network, &btc_address).unwrap_or_else(|e| env::panic_str(e));
        require!(!deposits.is_empty(), "Prove at least one deposit");
        require!(deposits.len() <= MAX_INPUTS, "At most 2 deposits");

        // Read amount and recipient from the transactions themselves.
        let escrow = offer.escrow_script();
        let mut inputs: Vec<(Vec<u8>, u32, u64)> = vec![];
        let mut proofs = vec![];
        for d in &deposits {
            let raw = hex::decode(&d.raw_tx).unwrap_or_else(|_| env::panic_str("raw_tx must be hex"));
            let tx = btc::parse_tx(&raw).unwrap_or_else(|e| env::panic_str(e));
            let out = tx.outputs.get(d.vout as usize).unwrap_or_else(|| env::panic_str("No such output"));
            require!(out.script == escrow, "That output does not pay this offer's address");
            require!(!inputs.iter().any(|(t, v, _)| t.as_slice() == tx.txid && *v == d.vout), "Duplicate deposit");
            let spent = offer.live_settlements().flat_map(|s| s.inputs.iter()).any(|(t, v, _)| t.as_slice() == tx.txid && *v == d.vout);
            require!(!spent, "Deposit already used by this offer");
            inputs.push((tx.txid.to_vec(), d.vout, out.value));
            proofs.push(LightClientProof {
                tx_id: tx.txid,
                tx_block_blockhash: hash_arg(&d.block_hash),
                tx_index: d.tx_index,
                merkle_proof: d.merkle_proof.iter().map(|h| hash_arg(h)).collect(),
                coinbase_tx_id: hash_arg(&d.coinbase_tx_id),
                coinbase_merkle_proof: d.coinbase_merkle_proof.iter().map(|h| hash_arg(h)).collect(),
                confirmations,
            });
        }
        let total: u64 = inputs.iter().map(|i| i.2).sum();
        require!(total >= offer.sats, "The deposit does not cover the offer");
        // Fail early on fees, before anything is reserved.
        payout_outputs(offer, &network, &btc_address, inputs.len(), total, fee_sats);

        offer.status = Status::Verifying;
        offer.pending = Some(PendingTake { taker: taker.clone(), btc_address, fee_sats, inputs, paid });
        event("offer_verifying", json!({"id": id, "taker": taker}));

        let Some(lc) = self.light_client.clone() else {
            return PromiseOrValue::Value(self.settle_pending(id, true));
        };
        let mut joint: Option<Promise> = None;
        for p in proofs {
            let call = Promise::new(lc.clone()).function_call(
                "verify_transaction_inclusion_v2",
                borsh::to_vec(&p).unwrap(),
                NearToken::from_yoctonear(0),
                GAS_VERIFY,
            );
            joint = Some(match joint {
                None => call,
                Some(j) => j.and(call),
            });
        }
        let n = deposits.len() as u64;
        let cb_gas = Gas::from_gas(GAS_VERIFIED_CB_BASE.as_gas() + n * (GAS_SIGN.as_gas() + GAS_SIGN_CB.as_gas()));
        PromiseOrValue::Promise(
            joint.unwrap().then(Self::ext(env::current_account_id()).with_static_gas(cb_gas).on_deposits_verified(id)),
        )
    }

    /// Completes or rolls back a purchase. Returns the amount the payer gets
    /// back (for `ft_on_transfer`, the token's "unused" amount).
    fn settle_pending(&mut self, id: u64, verified: bool) -> U128 {
        let network = self.network.clone();
        let confirmations = if self.light_client.is_some() { self.min_confirmations } else { 0 };
        let token = self.offer_token.get(&id).cloned();
        let offer = self.offers.get_mut(&id).expect("No offer");
        let Some(p) = offer.pending.take() else {
            return U128(0);
        };
        let price = offer.price;
        if !verified {
            offer.status = Status::Open;
            event("take_rejected", json!({"id": id, "taker": p.taker, "reason": "deposit not proven"}));
            if token.is_none() {
                Promise::new(p.taker).transfer(NearToken::from_yoctonear(p.paid)).detach();
            }
            return U128(p.paid);
        }
        let total: u64 = p.inputs.iter().map(|i| i.2).sum();
        let outputs = payout_outputs(offer, &network, &p.btc_address, p.inputs.len(), total, p.fee_sats);
        let inputs = p.inputs.iter().map(|(t, v, value)| Input { txid: t.as_slice().try_into().unwrap(), vout: *v, value: *value }).collect();
        offer.status = Status::Taken;
        offer.taker = Some(p.taker.clone());
        offer.taker_address = Some(p.btc_address.clone());
        let s_idx = push_settlement(offer, Kind::Release, inputs, outputs, confirmations);
        event("offer_taken", json!({"id": id, "taker": p.taker, "btc_address": p.btc_address, "confirmations": confirmations}));
        self.sign_missing(id, s_idx);
        let over = p.paid - price;
        if token.is_none() && over > 0 {
            Promise::new(p.taker).transfer(NearToken::from_yoctonear(over)).detach();
        }
        U128(over)
    }

    /// Pays `amount` of the offer's currency to `to`.
    fn pay(&mut self, id: u64, to: AccountId, amount: u128) {
        match self.offer_token.get(&id).cloned() {
            None => Promise::new(to).transfer(NearToken::from_yoctonear(amount)).detach(),
            Some(token) => self.ft_payout(token, to, amount).detach(),
        }
    }

    fn ft_payout(&self, token: AccountId, receiver: AccountId, amount: u128) -> Promise {
        Promise::new(token.clone())
            .function_call(
                "ft_transfer",
                json!({"receiver_id": receiver, "amount": U128(amount), "memo": "Trueque payout"}).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FT_CB).on_ft_payout(token, receiver, U128(amount)))
    }

    fn push_refund(&mut self, id: u64, utxos: Vec<Utxo>, fee_sats: u64) {
        let offer = self.offers.get_mut(&id).unwrap();
        let inputs = parse_utxos(&utxos, offer);
        let total: u64 = inputs.iter().map(|i| i.value).sum();
        let mut outputs = vec![Output { value: 0, script: offer.maker_script.clone() }];
        check_fee(fee_sats, inputs.len(), &outputs, total);
        outputs[0].value = total - fee_sats;
        let s_idx = push_settlement(offer, Kind::Refund, inputs, outputs, 0);
        event("refund_requested", json!({"id": id, "settlement": s_idx}));
        self.sign_missing(id, s_idx);
    }

    fn sign_missing(&mut self, id: u64, s_idx: u32) {
        let now = env::block_timestamp_ms();
        let mpc = self.mpc.clone();
        let offer = self.offers.get_mut(&id).unwrap();
        let path = offer.path.clone();
        let st = &mut offer.settlements[s_idx as usize];
        st.requested_ms = now;
        for (i, sig) in st.sigs.iter().enumerate() {
            if sig.is_some() {
                continue;
            }
            let args = json!({"request": {
                "path": path,
                "payload_v2": {"Ecdsa": hex::encode(&st.sighashes[i])},
                "domain_id": DOMAIN_ID,
            }});
            Promise::new(mpc.clone())
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
                let (maker, sats, price, bond) = (offer.maker.clone(), offer.sats, offer.price, offer.bond);
                self.trades += 1;
                self.volume_sats += sats;
                match self.offer_token.get(&id).cloned() {
                    None => {
                        Promise::new(maker).transfer(NearToken::from_yoctonear(price - fee + bond)).detach();
                        if fee > 0 {
                            Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(fee)).detach();
                        }
                        self.volume_near += price;
                    }
                    Some(token) => {
                        Promise::new(maker.clone()).transfer(NearToken::from_yoctonear(bond)).detach();
                        self.ft_payout(token.clone(), maker, price - fee).detach();
                        // Protocol fees in tokens accrue to the owner, claimable with withdraw_owed.
                        if fee > 0 {
                            let key = format!("{}:{}", self.owner, token);
                            let prev = self.owed.get(&key).copied().unwrap_or(0);
                            self.owed.insert(key, prev + fee);
                        }
                        let prev = self.token_volume.get(&token).copied().unwrap_or(0);
                        self.token_volume.insert(token, prev + price);
                    }
                }
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
            token: self.offer_token.get(&id).cloned(),
            pending_taker: o.pending.as_ref().map(|p| p.taker.clone()),
            settlements: o
                .settlements
                .iter()
                .map(|st| {
                    let (ins, outs) = (st.btc_inputs(), st.btc_outputs());
                    let total_in: u64 = ins.iter().map(|i| i.value).sum();
                    let total_out: u64 = outs.iter().map(|o| o.value).sum();
                    let raw_tx = if st.complete() && !st.voided {
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
                        requested_ms: st.requested_ms,
                        voided: st.voided,
                        verified_confirmations: st.verified_confirmations,
                    }
                })
                .collect(),
        }
    }
}

/// Display order hex hash (as explorers show it) to internal byte order.
fn hash_arg(display_hex: &str) -> [u8; 32] {
    btc::parse_txid(display_hex).unwrap_or_else(|_| env::panic_str("Hashes must be 32 byte hex"))
}

/// The taker's payout (and the maker's change) for a deposit of `total` sats.
fn payout_outputs(offer: &Offer, network: &str, btc_address: &str, n_in: usize, total: u64, fee_sats: u64) -> Vec<Output> {
    let taker_script = btc::address_to_script(network, btc_address).unwrap_or_else(|e| env::panic_str(e));
    let mut outputs = vec![Output { value: 0, script: taker_script }];
    let change = total - offer.sats;
    if change >= btc::DUST {
        outputs.push(Output { value: change, script: offer.maker_script.clone() });
    }
    check_fee(fee_sats, n_in, &outputs, offer.sats);
    outputs[0].value = offer.sats - fee_sats;
    outputs
}

fn parse_utxos(utxos: &[Utxo], offer: &Offer) -> Vec<Input> {
    require!(!utxos.is_empty(), "List the deposit UTXOs");
    require!(utxos.len() <= 4, "At most 4 UTXOs");
    let mut inputs: Vec<Input> = Vec::with_capacity(utxos.len());
    for u in utxos {
        let txid = btc::parse_txid(&u.txid).unwrap_or_else(|e| env::panic_str(e));
        require!(u.value > 0, "Zero value UTXO");
        require!(!inputs.iter().any(|i| i.txid == txid && i.vout == u.vout), "Duplicate UTXO");
        let spent = offer.live_settlements().flat_map(|s| s.inputs.iter()).any(|(t, v, _)| t.as_slice() == txid && *v == u.vout);
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

fn push_settlement(offer: &mut Offer, kind: Kind, inputs: Vec<Input>, outputs: Vec<Output>, verified_confirmations: u64) -> u32 {
    let pk = offer.pubkey();
    let pkh = btc::hash160(&pk);
    let sighashes = (0..inputs.len()).map(|i| btc::sighash_p2wpkh(&inputs, &outputs, i, &pkh).to_vec()).collect();
    offer.settlements.push(Settlement {
        kind,
        sigs: vec![None; inputs.len()],
        inputs: inputs.into_iter().map(|i| (i.txid.to_vec(), i.vout, i.value)).collect(),
        outputs: outputs.into_iter().map(|o| (o.value, o.script)).collect(),
        sighashes,
        requested_ms: 0,
        voided: false,
        verified_confirmations,
    });
    (offer.settlements.len() - 1) as u32
}

#[cfg(test)]
mod tests;

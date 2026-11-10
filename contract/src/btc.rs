//! Minimal Bitcoin primitives for the escrow: BIP143 sighashes for P2WPKH
//! inputs, segwit serialization, DER signatures and bech32 addresses.
//!
//! Everything here is deterministic and pure, so the contract can build the
//! exact transaction it asks the MPC network to sign, and anyone can rebuild
//! it from contract state.

use near_sdk::env;

pub const DUST: u64 = 546;
const SEQUENCE: u32 = 0xffff_fffd; // final, but signals RBF
const VERSION: u32 = 2;
const SIGHASH_ALL: u8 = 0x01;

#[derive(Clone, Debug, PartialEq)]
pub struct Input {
    /// Previous txid in internal (little endian) byte order.
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub value: u64,
    pub script: Vec<u8>,
}

pub fn dsha256(data: &[u8]) -> [u8; 32] {
    env::sha256_array(&env::sha256_array(data))
}

pub fn hash160(data: &[u8]) -> [u8; 20] {
    env::ripemd160_array(&env::sha256_array(data))
}

fn varint(n: usize, out: &mut Vec<u8>) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        _ => {
            out.push(0xfe);
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
    }
}

fn write_output(o: &Output, out: &mut Vec<u8>) {
    out.extend_from_slice(&o.value.to_le_bytes());
    varint(o.script.len(), out);
    out.extend_from_slice(&o.script);
}

/// BIP143 signature hash for input `index`, spending a P2WPKH output of `pkh`.
pub fn sighash_p2wpkh(inputs: &[Input], outputs: &[Output], index: usize, pkh: &[u8; 20]) -> [u8; 32] {
    let mut prevouts = Vec::with_capacity(inputs.len() * 36);
    let mut sequences = Vec::with_capacity(inputs.len() * 4);
    for i in inputs {
        prevouts.extend_from_slice(&i.txid);
        prevouts.extend_from_slice(&i.vout.to_le_bytes());
        sequences.extend_from_slice(&SEQUENCE.to_le_bytes());
    }
    let mut outs = Vec::new();
    for o in outputs {
        write_output(o, &mut outs);
    }

    let input = &inputs[index];
    let mut pre = Vec::with_capacity(160);
    pre.extend_from_slice(&VERSION.to_le_bytes());
    pre.extend_from_slice(&dsha256(&prevouts));
    pre.extend_from_slice(&dsha256(&sequences));
    pre.extend_from_slice(&input.txid);
    pre.extend_from_slice(&input.vout.to_le_bytes());
    // scriptCode for P2WPKH: OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
    pre.extend_from_slice(&[0x19, 0x76, 0xa9, 0x14]);
    pre.extend_from_slice(pkh);
    pre.extend_from_slice(&[0x88, 0xac]);
    pre.extend_from_slice(&input.value.to_le_bytes());
    pre.extend_from_slice(&SEQUENCE.to_le_bytes());
    pre.extend_from_slice(&dsha256(&outs));
    pre.extend_from_slice(&0u32.to_le_bytes()); // locktime
    pre.extend_from_slice(&(SIGHASH_ALL as u32).to_le_bytes());
    dsha256(&pre)
}

fn serialize(inputs: &[Input], outputs: &[Output], witnesses: Option<(&[Vec<u8>], &[u8; 33])>) -> Vec<u8> {
    let mut tx = Vec::new();
    tx.extend_from_slice(&VERSION.to_le_bytes());
    if witnesses.is_some() {
        tx.extend_from_slice(&[0x00, 0x01]);
    }
    varint(inputs.len(), &mut tx);
    for i in inputs {
        tx.extend_from_slice(&i.txid);
        tx.extend_from_slice(&i.vout.to_le_bytes());
        tx.push(0x00); // empty scriptSig
        tx.extend_from_slice(&SEQUENCE.to_le_bytes());
    }
    varint(outputs.len(), &mut tx);
    for o in outputs {
        write_output(o, &mut tx);
    }
    if let Some((sigs, pubkey)) = witnesses {
        for sig in sigs {
            tx.push(0x02);
            varint(sig.len(), &mut tx);
            tx.extend_from_slice(sig);
            tx.push(0x21);
            tx.extend_from_slice(pubkey);
        }
    }
    tx.extend_from_slice(&0u32.to_le_bytes());
    tx
}

/// Fully signed segwit transaction, ready to broadcast.
pub fn signed_tx(inputs: &[Input], outputs: &[Output], sigs: &[Vec<u8>], pubkey: &[u8; 33]) -> Vec<u8> {
    serialize(inputs, outputs, Some((sigs, pubkey)))
}

/// Transaction id in display (big endian) hex.
pub fn txid_hex(inputs: &[Input], outputs: &[Output]) -> String {
    let mut h = dsha256(&serialize(inputs, outputs, None));
    h.reverse();
    hex::encode(h)
}

/// Virtual size of a transaction spending `n_in` P2WPKH inputs, for fee checks.
/// Signatures are assumed at their 72 byte maximum.
pub fn vsize(n_in: usize, outputs: &[Output]) -> u64 {
    let outs: usize = outputs.iter().map(|o| 8 + 1 + o.script.len()).sum();
    let base = 4 + 1 + n_in * 41 + 1 + outs + 4;
    let witness = 2 + n_in * (1 + 1 + 72 + 1 + 33);
    ((base * 4 + witness) as u64).div_ceil(4)
}

fn der_int(x: &[u8; 32]) -> Vec<u8> {
    let mut i = 0;
    while i < 31 && x[i] == 0 {
        i += 1;
    }
    let mut v = x[i..].to_vec();
    if v[0] & 0x80 != 0 {
        v.insert(0, 0);
    }
    v
}

/// DER encoded signature with the SIGHASH_ALL byte appended.
pub fn der_sig(r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
    let (r, s) = (der_int(r), der_int(s));
    let mut out = vec![0x30, (4 + r.len() + s.len()) as u8, 0x02, r.len() as u8];
    out.extend(r);
    out.push(0x02);
    out.push(s.len() as u8);
    out.extend(s);
    out.push(SIGHASH_ALL);
    out
}

/// Compress an uncompressed (x || y) secp256k1 public key.
pub fn compress(xy: &[u8; 64]) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = if xy[63] & 1 == 0 { 0x02 } else { 0x03 };
    out[1..].copy_from_slice(&xy[..32]);
    out
}

pub fn hrp_for(network: &str) -> &'static str {
    match network {
        "mainnet" => "bc",
        _ => "tb",
    }
}

/// P2WPKH address for a compressed public key.
pub fn p2wpkh_address(network: &str, pubkey: &[u8; 33]) -> String {
    let hrp = bech32::Hrp::parse(hrp_for(network)).expect("valid hrp");
    bech32::segwit::encode(hrp, bech32::segwit::VERSION_0, &hash160(pubkey)).expect("valid program")
}

/// scriptPubKey for a segwit address (v0 P2WPKH/P2WSH or v1 P2TR) on `network`.
pub fn address_to_script(network: &str, address: &str) -> Result<Vec<u8>, &'static str> {
    let (hrp, version, program) = bech32::segwit::decode(address).map_err(|_| "Not a valid segwit address")?;
    if hrp.to_lowercase() != hrp_for(network) {
        return Err("Address is for a different Bitcoin network");
    }
    let v = version.to_u8();
    match (v, program.len()) {
        (0, 20) | (0, 32) | (1, 32) => {}
        _ => return Err("Unsupported address type: use P2WPKH, P2WSH or P2TR"),
    }
    let mut script = vec![if v == 0 { 0x00 } else { 0x50 + v }, program.len() as u8];
    script.extend(program);
    Ok(script)
}

/// Human readable address for a segwit script.
pub fn script_to_address(network: &str, script: &[u8]) -> Option<String> {
    if script.len() < 4 || script[1] as usize != script.len() - 2 {
        return None;
    }
    let version = match script[0] {
        0x00 => 0u8,
        0x51..=0x60 => script[0] - 0x50,
        _ => return None,
    };
    let hrp = bech32::Hrp::parse(hrp_for(network)).ok()?;
    let fe = bech32::Fe32::try_from(version).ok()?;
    bech32::segwit::encode(hrp, fe, &script[2..]).ok()
}

/// Parse a display order txid into internal byte order.
pub fn parse_txid(display_hex: &str) -> Result<[u8; 32], &'static str> {
    let bytes = hex::decode(display_hex).map_err(|_| "txid must be hex")?;
    let mut txid: [u8; 32] = bytes.try_into().map_err(|_| "txid must be 32 bytes")?;
    txid.reverse();
    Ok(txid)
}

pub fn display_txid(internal: &[u8; 32]) -> String {
    let mut t = *internal;
    t.reverse();
    hex::encode(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn der_encoding_pads_high_bit() {
        let mut r = [0u8; 32];
        r[0] = 0x80;
        let mut s = [0u8; 32];
        s[31] = 1;
        let d = der_sig(&r, &s);
        assert_eq!(d[0], 0x30);
        assert_eq!(d[3], 33); // r padded with a zero byte
        assert_eq!(d[4], 0x00);
        assert_eq!(&d[d.len() - 4..], &[0x02, 0x01, 0x01, 0x01]); // s = 1, then SIGHASH_ALL
    }

    #[test]
    fn address_round_trip() {
        let addr = "tb1qxs8qnv50kswwe76nlmvq4rshpq6uxuyqkh9nqz";
        let script = address_to_script("signet", addr).unwrap();
        assert_eq!(script.len(), 22);
        assert_eq!(script_to_address("signet", &script).unwrap(), addr);
        assert!(address_to_script("mainnet", addr).is_err());
    }

    #[test]
    fn txid_round_trip() {
        let t = "95597ae9a3f0e8c2c4d1b7a6e5f40312233445566778899aabbccddeeff00112";
        assert_eq!(display_txid(&parse_txid(t).unwrap()), t);
    }
}

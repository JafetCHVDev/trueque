#!/usr/bin/env node
// Independent check of the contract's Bitcoin code: runs the Rust test that
// produces a signed release transaction, then verifies every input signature
// with bitcoinjs-lib's own BIP143 sighash. If the contract hashed anything
// differently (outputs, amounts, sequence, scriptCode), verification fails.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";

const out = execFileSync(
  "cargo",
  ["test", "--quiet", "verified_trade_settles_and_produces_a_signed_tx", "--", "--nocapture"],
  {
    cwd: fileURLToPath(new URL("../contract/", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, AWS_LC_SYS_PREBUILT_NASM: "1" },
  },
);
const line = out.split("\n").find((l) => l.startsWith("VECTOR "));
if (!line) throw new Error("Vector not found in test output");
const { raw, pubkey, value } = JSON.parse(line.slice(7));

const tx = bitcoin.Transaction.fromHex(raw);
const pk = Buffer.from(pubkey, "hex");
const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pk, network: bitcoin.networks.testnet });
const scriptCode = bitcoin.payments.p2pkh({ hash: p2wpkh.hash }).output;

tx.ins.forEach((input, i) => {
  const [der, witnessKey] = input.witness;
  if (!Buffer.from(witnessKey).equals(pk)) throw new Error(`input ${i}: wrong witness key`);
  const { signature, hashType } = bitcoin.script.signature.decode(der);
  const hash = tx.hashForWitnessV0(i, scriptCode, BigInt(value), hashType);
  if (!ecc.verify(hash, pk, signature, true)) throw new Error(`input ${i}: signature does not verify`);
});

console.log(`OK: ${tx.ins.length} input(s) verified by bitcoinjs, txid ${tx.getId()}, vsize ${tx.virtualSize()}`);

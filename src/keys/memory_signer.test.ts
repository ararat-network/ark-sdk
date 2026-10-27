import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";

import { fromBase64, fromHex, toBase64, utf8Encode } from "../codec/bytes.js";
import { SignDocSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { fixture, fixtureKey, signupVectors } from "../testing/fixtures.js";
import { MemorySigner } from "./memory_signer.js";
import { verifyMessage } from "./secp256k1.js";
import { SECP256K1_PUBLIC_KEY_URL, SignerError } from "./signer.js";

test("signDirect reproduces a fixture's signature over its sign document", async () => {
  const f = fixture("bank_send_taxed");
  const key = fixtureKey(f.signer!.key);
  const signer = MemorySigner.fromPrivateKey(fromHex(key.private_key_hex));
  const [account] = await signer.accounts();
  assert.equal(account?.address, f.signer!.address);
  assert.equal(account?.publicKey.typeUrl, SECP256K1_PUBLIC_KEY_URL);
  const signDoc = fromBinary(SignDocSchema, fromBase64(f.sign_mode_direct!.sign_doc));
  const { signature } = await signer.signDirect(signer.address, signDoc);
  assert.equal(toBase64(signature), f.signature);
  await assert.rejects(signer.signDirect("ark1other", signDoc), SignerError);
});

test("signArbitrary reproduces the signup vectors", async () => {
  const { keys, vectors } = signupVectors();
  const member = keys.find((k) => k.name === "member")!;
  const signer = MemorySigner.fromPrivateKey(fromHex(member.private_key_hex));
  const ok = vectors.find((v) => v.name === "challenge_ok")!;
  const { signature, publicKey } = await signer.signArbitrary(signer.address, utf8Encode(ok.data));
  assert.equal(toBase64(signature), ok.signature);
  assert.equal(publicKey.typeUrl, SECP256K1_PUBLIC_KEY_URL);
});

test("signAmino signs the sorted JSON bytes", async () => {
  const signer = MemorySigner.random();
  const doc = { account_number: "1", chain_id: "localark", fee: { amount: [], gas: "1" }, memo: "", msgs: [], sequence: "0" };
  const { signature, signDoc } = await signer.signAmino(signer.address, doc);
  assert.equal(signDoc, doc);
  const bytes = utf8Encode('{"account_number":"1","chain_id":"localark","fee":{"amount":[],"gas":"1"},"memo":"","msgs":[],"sequence":"0"}');
  assert.ok(verifyMessage(signature, bytes, signer.publicKey));
});

test("fromMnemonic derives the keyring address", () => {
  const signer = MemorySigner.fromMnemonic("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  assert.equal(signer.address, "ark1amdttz2937a3dytmxmkany53pp6ma6dyrj9wuv");
});

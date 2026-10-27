import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBase64, fromHex, toBase64, utf8Decode, utf8Encode } from "../codec/bytes.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { signMessage } from "../keys/secp256k1.js";
import { signupVectors } from "../testing/fixtures.js";
import { DocumentError, documentBytes, parseDocument, validateDocument, type SignupDocument } from "./document.js";
import { checkSubmission, signDocument, submissionFromJson, submissionToJson, verifySignature, type StatelessRefusal } from "./sign.js";
import { adr036SignBytes } from "./signbytes.js";

const { keys, vectors } = signupVectors();
const keyFor = (publicKey: string) => keys.find((k) => k.public_key === publicKey);
const STATELESS = new Set<string>(["signer_invalid", "key_mismatch", "signature_invalid", "data_invalid"]);

test("every vector's sign bytes are reproduced from signer and data", () => {
  assert.equal(vectors.length, 16);
  for (const v of vectors) {
    assert.equal(utf8Decode(adr036SignBytes(v.signer, utf8Encode(v.data))), v.sign_bytes, v.name);
  }
});

test("every valid signature is reproduced with the named key", () => {
  for (const v of vectors) {
    const key = keyFor(v.public_key);
    assert.ok(key, `${v.name}: the public key is one of the test keys`);
    const signature = signMessage(adr036SignBytes(v.signer, utf8Encode(v.data)), fromHex(key.private_key_hex));
    if (v.signature_valid) {
      assert.equal(toBase64(signature), v.signature, v.name);
    } else {
      assert.notEqual(toBase64(signature), v.signature, v.name);
    }
    const submission = submissionFromJson({ data: v.data, signer: v.signer, public_key: v.public_key, signature: v.signature });
    assert.equal(verifySignature(submission), v.signature_valid, `${v.name}: rule 3`);
  }
});

test("the stateless rules return the vectors' refusals in order", () => {
  for (const v of vectors) {
    const got = checkSubmission(submissionFromJson({ data: v.data, signer: v.signer, public_key: v.public_key, signature: v.signature }), v.prefix);
    const want: StatelessRefusal | undefined = STATELESS.has(v.expect) ? (v.expect as StatelessRefusal) : undefined;
    assert.equal(got, want, `${v.name}: expect ${v.expect}`);
  }
});

test("signDocument through a signer reproduces the ok vectors", async () => {
  for (const name of ["challenge_ok", "challenge_localnet_ok", "vouch_ok"]) {
    const v = vectors.find((x) => x.name === name)!;
    const key = keyFor(v.public_key)!;
    const signer = MemorySigner.fromPrivateKey(fromHex(key.private_key_hex));
    const doc = parseDocument(utf8Encode(v.data));
    assert.deepEqual(doc, v.challenge);
    const submission = await signDocument(signer, signer.address, doc);
    const json = submissionToJson(submission);
    assert.deepEqual(json, { data: v.data, signer: v.signer, public_key: v.public_key, signature: v.signature }, name);
    assert.equal(checkSubmission(submission), undefined);
    const fromBytes = await signDocument(signer, signer.address, utf8Encode(v.data));
    assert.equal(toBase64(fromBytes.signature), v.signature);
  }
});

const good: SignupDocument = {
  admission: "adm_0001",
  chain_id: "ark-1",
  domain: "ark-signup/v1",
  expires: "1761400600",
  issued: "1761400000",
  nonce: "201d7a011b4bdf066236967eb24b4d7a478aab24e4993ea2a169f422f7d82ce2",
  origin: "https://members.ararat.network",
};

test("the document grammar refuses what §4 forbids", () => {
  assert.doesNotThrow(() => validateDocument(good));
  assert.equal(utf8Decode(documentBytes(good)), vectors[0]!.data);
  const cases: [string, (d: SignupDocument) => void][] = [
    ["empty admission", (d) => (d.admission = "")],
    ["admission with a space", (d) => (d.admission = "adm 1")],
    ["admission too long", (d) => (d.admission = "a".repeat(129))],
    ["quote in a value", (d) => (d.chain_id = 'ark"1')],
    ["ampersand in a value", (d) => (d.admission = "a&b")],
    ["angle bracket in a value", (d) => (d.admission = "<adm>")],
    ["non-ASCII", (d) => (d.admission = "adm\u00e9")],
    ["unknown domain", (d) => (d.domain = "ark-signup/v2")],
    ["expires not seconds", (d) => (d.expires = "2026-10-27")],
    ["expires before issued", (d) => (d.expires = "1761399999")],
    ["nonce uppercase", (d) => (d.nonce = d.nonce.toUpperCase())],
    ["nonce short", (d) => (d.nonce = d.nonce.slice(1))],
    ["origin with a path", (d) => (d.origin = "https://members.ararat.network/")],
    ["origin uppercase", (d) => (d.origin = "https://Members.ararat.network")],
    ["origin without a scheme", (d) => (d.origin = "members.ararat.network")],
  ];
  for (const [name, mutate] of cases) {
    const d = { ...good };
    mutate(d);
    assert.throws(() => validateDocument(d), DocumentError, name);
  }
  assert.doesNotThrow(() => validateDocument({ ...good, origin: "http://localhost:8080", chain_id: "localark" }));
});

test("parseDocument requires the canonical encoding", () => {
  assert.throws(() => parseDocument(utf8Encode("not json")), DocumentError);
  assert.throws(() => parseDocument(utf8Encode('{"hello":"world"}')), DocumentError);
  assert.throws(() => parseDocument(utf8Encode(JSON.stringify(good, null, 1))), /canonical/);
  const extra = { ...good, extra: "x" };
  assert.throws(() => parseDocument(utf8Encode(JSON.stringify(extra))), /exactly/);
  assert.deepEqual(parseDocument(documentBytes(good)), good);
});

test("the vector keys sign with the key their address names", () => {
  for (const k of keys) {
    const signer = MemorySigner.fromPrivateKey(fromHex(k.private_key_hex));
    assert.equal(signer.address, k.address);
    assert.equal(toBase64(signer.publicKey), k.public_key);
  }
  assert.equal(fromBase64(keys[0]!.public_key).length, 33);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { fromHex, utf8Encode } from "../codec/bytes.js";
import { publicKeyToAddress } from "../keys/address.js";
import { signupVectors } from "../testing/fixtures.js";
import { DocumentError, type SignupDocument, validateDocument } from "./document.js";
import { checkSubmission, submissionFromJson } from "./sign.js";

test("rule 2 refuses a 33-byte key that is not a point as a key mismatch, before any signature is checked", () => {
  const ok = signupVectors().vectors.find((v) => v.name === "challenge_ok")!;
  // 0x05 is no compressed-point prefix, so the bytes name no point, though they hash to an address like any other.
  const notAPoint = fromHex(`05${"11".repeat(32)}`);
  const submission = { ...submissionFromJson(ok), publicKey: notAPoint, signer: publicKeyToAddress(notAPoint) };
  assert.equal(checkSubmission(submission), "key_mismatch");
});

const good: SignupDocument = {
  admission: "adm-7f3c",
  chain_id: "ark-1",
  domain: "ark-signup/v1",
  expires: "1800000600",
  issued: "1800000000",
  nonce: "0".repeat(64),
  origin: "https://members.ararat.network",
};

test("an origin names a port only when it is not the scheme's default, and seconds fit a uint64", () => {
  assert.doesNotThrow(() => validateDocument({ ...good, origin: "https://members.ararat.network:8443" }));
  assert.doesNotThrow(() => validateDocument({ ...good, origin: "http://localhost:8080", chain_id: "localark" }));
  const cases: [string, Partial<SignupDocument>][] = [
    ["https on its default port", { origin: "https://members.ararat.network:443" }],
    ["http on its default port", { origin: "http://localhost:80", chain_id: "localark" }],
    ["a port past 65535", { origin: "https://members.ararat.network:70000" }],
    ["issued past a uint64", { issued: "18446744073709551616", expires: "18446744073709551617" }],
    ["expires past a uint64", { expires: "99999999999999999999" }],
  ];
  for (const [name, change] of cases) assert.throws(() => validateDocument({ ...good, ...change }), DocumentError, name);
  assert.ok(utf8Encode(good.origin).length < 128);
});

// The index names every export, so what the codecs share between themselves
// stays out of the public surface unless it is listed on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as options from "./codec/options.js";
import * as sdk from "./index.js";

const exported: Record<string, unknown> = sdk;

test("the codecs' own plumbing is not part of the public surface", () => {
  const plumbing = [
    ...Object.keys(options),
    "stripTrailing",
    "anyJson",
    "errorMessage",
    "decimalParts",
    "scaleDecimal",
    "fixedPointText",
    // The gateway's route builder and the pieces of the sorted-JSON serialiser: the whole-document functions are the surface.
    "routeFor",
    "compareUtf8",
    "goJsonString",
    "goJsonNumber",
  ];
  assert.ok(plumbing.length >= 19);
  for (const name of plumbing) assert.ok(!(name in exported), `${name} is internal`);
});

test("the names the app's signer imports are exported", () => {
  // What ark-app's signer takes from the package: bytes, the chain's sorted JSON, address decoding, and secp256k1.
  const needed = [
    "fromHex",
    "toBase64",
    "fromBase64",
    "utf8Encode",
    "utf8Decode",
    "marshalGoJsonBytes",
    "ADDRESS_LENGTH",
    "decodeAddress",
    "publicKeyToAddress",
    "SIGNATURE_LENGTH",
    "isCompressedPublicKey",
    "isLowS",
    "publicKeyFromPrivate",
    "signMessage",
    "verifyMessage",
  ];
  for (const name of needed) assert.ok(name in exported, name);
});

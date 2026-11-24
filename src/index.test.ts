// The index names every export, so what the codecs share between themselves
// stays out of the public surface unless it is listed on purpose.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import * as options from "./codec/options.js";
import { TxResponseSchema } from "./gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { TxBodySchema, TxSchema } from "./gen/cosmos/tx/v1beta1/tx_pb.js";
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

// Compile-time: the main entry defaults the registry for every name the core entry requires one for. A name the
// index forgot to take from the defaulting layer would be the core's, and one of these calls would not type-check.
void (async () => {
  const any = create(AnySchema);
  const tx = create(TxSchema);
  const body = create(TxBodySchema);
  const fee = sdk.makeFee({ amount: [], gasLimit: 1n });
  sdk.unpackAny(any);
  sdk.makeAminoSignDoc({ body, fee, chainId: "c", accountNumber: 0n, sequence: 0n });
  sdk.aminoEncode(TxBodySchema, body);
  sdk.aminoEncodeAny(any);
  sdk.toProtoJson(TxSchema, tx);
  sdk.fromProtoJson(TxSchema, {});
  sdk.decodeAccount(any);
  sdk.decodeMsgResponses("");
  sdk.decodeMessage(any);
  sdk.decodeTxMessages(tx);
  sdk.decodeTx(new Uint8Array());
  sdk.decodeEvent({ type: "t", attributes: [] });
  sdk.decodeEvents([]);
  sdk.foundTx(create(TxResponseSchema), undefined);
  const signer = sdk.MemorySigner.random();
  await sdk.signTx({ signer, address: signer.address, chainId: "c", accountNumber: 0n, sequence: 0n, messages: [], fee });
  new sdk.GatewayClient("http://node");
  new sdk.QueryClient("http://node");
  sdk.QueryClient.forNetwork(sdk.Network.fromRegistry({} as sdk.RegistryFiles));
});

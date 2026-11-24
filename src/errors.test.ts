// Every error the package exports is an ArkSdkError, and the refusals that
// used to be a bare Error carry a class a caller can catch.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AnySchema } from "@bufbuild/protobuf/wkt";

import { UnknownTypeError } from "./codec/any.js";
import { fromProtoJson, GatewayClient, QueryClient } from "./defaults.js";
import { ArkSdkError, errorMessage } from "./errors.js";
import { Query as DisbursementQuery } from "./gen/ark/disbursement/v1/query_pb.js";
import * as sdk from "./index.js";
import { SignerError } from "./keys/signer.js";
import { routeFor } from "./query/gateway.js";
import { Network, RegistryError } from "./registry/network.js";
import { registryFiles } from "./testing/fixtures.js";
import { json, stubFetch } from "./testing/node.js";
import { packMessages } from "./tx/body.js";

test("every error class the package exports extends ArkSdkError", () => {
  const classes = Object.entries(sdk).filter(([, value]) => typeof value === "function" && value.prototype instanceof Error);
  assert.ok(classes.length >= 28, `error classes exported: ${classes.length}`);
  for (const [name, value] of classes) {
    assert.ok(value === ArkSdkError || (value as { prototype: unknown }).prototype instanceof ArkSdkError, `${name} extends ArkSdkError`);
  }
});

test("an SDK error is still an Error and keeps its own name", () => {
  const base = new ArkSdkError("m");
  assert.ok(base instanceof Error);
  assert.equal(base.name, "ArkSdkError");
  const signer = new SignerError("m");
  assert.ok(signer instanceof ArkSdkError);
  assert.equal(signer.name, "SignerError");
  assert.equal(signer.message, "m");
});

test("a request that cannot be built, a client with no endpoint, and an empty answer are SDK errors", async () => {
  assert.throws(() => routeFor(DisbursementQuery.method.member, {}), ArkSdkError);
  assert.throws(() => new GatewayClient([]), ArkSdkError);
  // Mainnet's registry entry lists no REST endpoint yet.
  assert.throws(() => QueryClient.forNetwork(Network.fromRegistry(registryFiles("ark"))), RegistryError);
  const empty = new QueryClient("http://node", { fetch: stubFetch(() => json({ account: null })).fetch });
  await assert.rejects(empty.auth.decodedAccount("ark1x"), (err: unknown) => err instanceof ArkSdkError && /no account at ark1x/.test(err.message));
});

test("a message read without its type is refused as an unknown type, with the reason", () => {
  const held = fromProtoJson(AnySchema, { "@type": "/ark.future.v1.MsgNew", amount: "5" }, { unknownAny: "keep" });
  assert.throws(
    () => packMessages([held]),
    (err: unknown) => err instanceof UnknownTypeError && err.typeUrl === "/ark.future.v1.MsgNew" && /holds no bytes/.test(err.message),
  );
  assert.equal(new UnknownTypeError("/x.Y").message, "unknown type /x.Y", "the message is the type's alone unless one is given");
});

test("errorMessage reads an Error's message and anything else as text", () => {
  assert.equal(errorMessage(new TypeError("fetch failed")), "fetch failed");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(undefined), "undefined");
});

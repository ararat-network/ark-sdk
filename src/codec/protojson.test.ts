// The dialect's corners the fixtures do not reach: map fields, custom enum
// names read back, unknown Any types kept raw or as their JSON, and unknown
// members ignored.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, createRegistry } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import { PricesResponseSchema } from "../gen/ark/pricefeed/v1/pricefeed_pb.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { CommissionRatesSchema } from "../gen/cosmos/staking/v1beta1/staking_pb.js";
import { TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { AccessConfigSchema, AccessType } from "../gen/cosmwasm/wasm/v1/types_pb.js";
import { aminoEncodeAny } from "./aminojson.js";
import { UnknownTypeError, unknownAnyJson, unpackAny, unpackAnyAs } from "./any.js";
import { utf8Encode } from "./bytes.js";
import { LegacyDec } from "./dec.js";
import { fromProtoJson, ProtoJsonError, toProtoJson } from "./protojson.js";

test("map fields render as objects and read back", () => {
  const message = create(PricesResponseSchema, { prices: { ausd: utf8Encode("1.5"), anoah: utf8Encode("2") } });
  const json = toProtoJson(PricesResponseSchema, message);
  // The unset timestamp is non-nullable, so it renders as Go's zero time.
  assert.deepEqual(json, { prices: { ausd: "MS41", anoah: "Mg==" }, timestamp: "0001-01-01T00:00:00Z", version: "" });
  const back = fromProtoJson(PricesResponseSchema, json);
  assert.deepEqual(back.prices, message.prices);
  assert.deepEqual(toProtoJson(PricesResponseSchema, create(PricesResponseSchema)), { prices: {}, timestamp: "0001-01-01T00:00:00Z", version: "" });
});

test("wasmd's AccessType reads back from its custom name, its proto name, or its number", () => {
  for (const value of ["Everybody", "ACCESS_TYPE_EVERYBODY", 3]) {
    assert.equal(fromProtoJson(AccessConfigSchema, { permission: value, addresses: [] }).permission, AccessType.EVERYBODY, String(value));
  }
  assert.throws(() => fromProtoJson(AccessConfigSchema, { permission: "Somebody" }), ProtoJsonError);
  assert.deepEqual(toProtoJson(AccessConfigSchema, create(AccessConfigSchema, { permission: AccessType.NOBODY })), { permission: "Nobody", addresses: [] });
});

test("unknown members are ignored by default and refused on request; unknown Any types throw or stay raw", () => {
  assert.equal(fromProtoJson(AccessConfigSchema, { permission: "Nobody", later_field: 1 }).permission, AccessType.NOBODY);
  assert.throws(() => fromProtoJson(AccessConfigSchema, { later_field: 1 }, { ignoreUnknownFields: false }), ProtoJsonError);
  const any = create(AnySchema, { typeUrl: "/ark.future.v1.Msg", value: new Uint8Array([8, 1]) });
  assert.throws(() => toProtoJson(AnySchema, any), UnknownTypeError);
  assert.deepEqual(toProtoJson(AnySchema, any, { unknownAny: "raw" }), { "@type": "/ark.future.v1.Msg", value: "CAE=" });
  assert.throws(() => fromProtoJson(AnySchema, { "@type": "/ark.future.v1.Msg" }), UnknownTypeError);
});

test("an unknown Any read with keep holds its type URL, no bytes, and the JSON it arrived as", () => {
  const future = { "@type": "/ark.future.v1.MsgNew", amount: "5", nested: { deep: [1, 2] } };
  const send = { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: "ark1a", to_address: "ark1b", amount: [{ denom: "ausd", amount: "1" }] };
  const body = fromProtoJson(TxBodySchema, { messages: [send, future], memo: "m" }, { unknownAny: "keep" });
  const [known, unknown] = body.messages;
  assert.ok(known && unknown);
  assert.equal(unknownAnyJson(known), undefined, "a known type carries its bytes and holds no JSON");
  assert.ok(known.value.length > 0);
  assert.equal(unknown.typeUrl, "/ark.future.v1.MsgNew");
  assert.equal(unknown.value.length, 0);
  assert.deepEqual(unknownAnyJson(unknown), future);

  // It renders as the JSON it arrived as, in either mode, so what a node sent can be shown or sent back.
  const rendered = toProtoJson(TxBodySchema, body) as { messages: unknown[] };
  assert.deepEqual(rendered.messages[1], future);
  assert.deepEqual((toProtoJson(TxBodySchema, body, { unknownAny: "raw" }) as { messages: unknown[] }).messages[1], future);
  // A copy does not carry the JSON: only the type URL is left, and it reads as raw.
  const copy = create(AnySchema, { typeUrl: unknown.typeUrl, value: unknown.value });
  assert.equal(unknownAnyJson(copy), undefined);
  assert.deepEqual(toProtoJson(AnySchema, copy, { unknownAny: "raw" }), { "@type": "/ark.future.v1.MsgNew", value: "" });

  // Nested inside a known Any, the outer message is held as bytes, so the inner keeps its type URL alone.
  const exec = { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "ark1g", msgs: [future] };
  const outer = fromProtoJson(AnySchema, exec, { unknownAny: "keep" });
  assert.equal(unknownAnyJson(outer), undefined);
  assert.deepEqual(toProtoJson(AnySchema, outer, { unknownAny: "raw" }), {
    "@type": "/cosmos.authz.v1beta1.MsgExec",
    grantee: "ark1g",
    msgs: [{ "@type": "/ark.future.v1.MsgNew", value: "" }],
  });

  assert.throws(() => fromProtoJson(TxBodySchema, { messages: [future] }), UnknownTypeError, "reading strictly is still the default");
});

test("an Any held as JSON is never decoded from its empty bytes, even by a registry that knows the type", () => {
  // Read by a registry that lacks MsgSend, then handed to code that uses the full one.
  const send = { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: "ark1a", to_address: "ark1b", amount: [] };
  const held = fromProtoJson(AnySchema, send, { registry: createRegistry(), unknownAny: "keep" });
  assert.deepEqual(unknownAnyJson(held), send);
  assert.equal(unpackAny(held), undefined, "empty bytes would decode as an empty MsgSend");
  assert.throws(() => unpackAnyAs(held, MsgSendSchema), UnknownTypeError);
  assert.throws(() => aminoEncodeAny(held), UnknownTypeError);
  assert.deepEqual(toProtoJson(AnySchema, held), send, "the JSON it arrived as, not an empty message's");
});

test('a non-nullable Dec that never reached the wire renders as gogo\'s "0", a set one at 18 places', () => {
  assert.deepEqual(toProtoJson(CommissionRatesSchema, create(CommissionRatesSchema)), { rate: "0", max_rate: "0", max_change_rate: "0" });
  assert.deepEqual(toProtoJson(CommissionRatesSchema, create(CommissionRatesSchema, { rate: LegacyDec.fromString("0.1").toWire() })), {
    rate: "0.100000000000000000",
    max_rate: "0",
    max_change_rate: "0",
  });
});

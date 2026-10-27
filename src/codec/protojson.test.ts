// The dialect's corners the fixtures do not reach: map fields, custom enum
// names read back, unknown Any types kept raw, and unknown members ignored.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import { PricesResponseSchema } from "../gen/ark/pricefeed/v1/pricefeed_pb.js";
import { CommissionRatesSchema } from "../gen/cosmos/staking/v1beta1/staking_pb.js";
import { AccessConfigSchema, AccessType } from "../gen/cosmwasm/wasm/v1/types_pb.js";
import { UnknownTypeError } from "./any.js";
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

test('a non-nullable Dec that never reached the wire renders as gogo\'s "0", a set one at 18 places', () => {
  assert.deepEqual(toProtoJson(CommissionRatesSchema, create(CommissionRatesSchema)), { rate: "0", max_rate: "0", max_change_rate: "0" });
  assert.deepEqual(toProtoJson(CommissionRatesSchema, create(CommissionRatesSchema, { rate: LegacyDec.fromString("0.1").toWire() })), {
    rate: "0.100000000000000000",
    max_rate: "0",
    max_change_rate: "0",
  });
});

// The dialect's corners the fixtures do not reach: map fields, custom enum
// names read back, unknown Any types kept raw or as their JSON, and unknown
// members ignored.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, createRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AnySchema, DurationSchema } from "@bufbuild/protobuf/wkt";
import { aminoEncodeAny, decodeMessage, fromProtoJson, toProtoJson, unpackAny } from "../defaults.js";
import { ArkSdkError } from "../errors.js";
import { PricesResponseSchema } from "../gen/ark/pricefeed/v1/pricefeed_pb.js";
import { BaseAccountSchema } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { TxResponseSchema } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { ProposalSchema, ProposalStatus } from "../gen/cosmos/gov/v1/gov_pb.js";
import { CommissionRatesSchema } from "../gen/cosmos/staking/v1beta1/staking_pb.js";
import { TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { AcceptedMessagesFilterSchema } from "../gen/cosmwasm/wasm/v1/authz_pb.js";
import { QueryCodeInfoResponseSchema } from "../gen/cosmwasm/wasm/v1/query_pb.js";
import { AccessConfigSchema, AccessType, ModelSchema } from "../gen/cosmwasm/wasm/v1/types_pb.js";
import { UnknownTypeError, unknownAnyJson, unpackAnyAs } from "./any.js";
import { fromHex, utf8Decode, utf8Encode } from "./bytes.js";
import { CoinError } from "./coins.js";
import { LegacyDec } from "./dec.js";
import { isJsonObject } from "./json.js";
import { ProtoJsonError, unknownEnumNames } from "./protojson.js";

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

  assert.throws(() => fromProtoJson(TxBodySchema, { messages: [future] }), UnknownTypeError, "reading strictly is still the default");
});

test("a known Any that holds an unknown one is kept whole, at any depth, never as bytes around a hollow message", () => {
  const future = { "@type": "/ark.future.v1.MsgNew", sender: "ark1x", amount: "5" };
  const send = { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: "ark1a", to_address: "ark1b", amount: [{ denom: "ausd", amount: "1" }] };
  const exec = { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "ark1g", msgs: [send, future] };
  const outer = fromProtoJson(AnySchema, exec, { unknownAny: "keep" });
  assert.equal(outer.typeUrl, "/cosmos.authz.v1beta1.MsgExec");
  assert.equal(outer.value.length, 0, "bytes here would name the inner type and carry none of its content");
  assert.deepEqual(unknownAnyJson(outer), exec);
  assert.deepEqual(toProtoJson(AnySchema, outer), exec, "the node's JSON, the inner message's members included");
  // Compared with === here and below: an unpacked Any carries its schema, which prints as over a million lines, and a failed assert.equal diffs both sides.
  assert.ok(unpackAny(outer) === undefined);
  const decoded = decodeMessage(outer);
  assert.equal(decoded.known, false);
  assert.deepEqual(decoded.json, exec);

  // Two levels down: a proposal whose message is an exec around the unknown one.
  const proposal = { "@type": "/cosmos.gov.v1.MsgSubmitProposal", messages: [exec], proposer: "ark1p" };
  assert.deepEqual(unknownAnyJson(fromProtoJson(AnySchema, proposal, { unknownAny: "keep" })), proposal);

  // An exec around known messages only still carries its bytes, and so does a sibling of a kept one.
  const whole = { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "ark1g", msgs: [send] };
  const body = fromProtoJson(TxBodySchema, { messages: [whole, exec] }, { unknownAny: "keep" });
  assert.equal(unknownAnyJson(body.messages[0]!), undefined);
  assert.ok(body.messages[0]!.value.length > 0);
  assert.deepEqual(unknownAnyJson(body.messages[1]!), exec);
});

test("an Any held as JSON is never decoded from its empty bytes, even by a registry that knows the type", () => {
  // Read by a registry that lacks MsgSend, then handed to code that uses the full one.
  const send = { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: "ark1a", to_address: "ark1b", amount: [] };
  const held = fromProtoJson(AnySchema, send, { registry: createRegistry(), unknownAny: "keep" });
  assert.deepEqual(unknownAnyJson(held), send);
  assert.ok(unpackAny(held) === undefined, "empty bytes would decode as an empty MsgSend");
  assert.throws(() => unpackAnyAs(held, MsgSendSchema), UnknownTypeError);
  assert.throws(() => aminoEncodeAny(held), UnknownTypeError);
  assert.deepEqual(toProtoJson(AnySchema, held), send, "the JSON it arrived as, not an empty message's");
  const decoded = decodeMessage(held);
  assert.equal(decoded.known, false, "the decoder names it unknown though its registry knows the type");
  assert.equal(decoded.message, undefined);
  assert.deepEqual(decoded.json, send);
});

test("an Int or a Dec renders and reads as the number the chain holds, not as its text's decimal digits", () => {
  // A bank send whose amount text is "0100": the chain executes it for 64, and its JSON says 64.
  const bytes = fromHex("0a0861726b3166726f6d120661726b31746f1a0c0a0461757364120430313030");
  const sent = fromBinary(MsgSendSchema, bytes);
  const chainJson = { from_address: "ark1from", to_address: "ark1to", amount: [{ denom: "ausd", amount: "64" }] };
  assert.deepEqual(toProtoJson(MsgSendSchema, sent), chainJson);
  const any = create(AnySchema, { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: bytes });
  assert.deepEqual(decodeMessage(any).json, { "@type": "/cosmos.bank.v1beta1.MsgSend", ...chainJson });
  // The amino document carries a string Int's text as it is, as the chain's encoder does, so the two still sign the same bytes.
  assert.deepEqual(aminoEncodeAny(any), {
    type: "cosmos-sdk/MsgSend",
    value: { from_address: "ark1from", to_address: "ark1to", amount: [{ denom: "ausd", amount: "0100" }] },
  });

  // JSON is read the same way: the chain takes the base from the text there too, and a message built from it holds the integer.
  const read = fromProtoJson(MsgSendSchema, { from_address: "ark1from", to_address: "ark1to", amount: [{ denom: "ausd", amount: "0100" }] });
  assert.equal(read.amount[0]?.amount, "64");
  assert.throws(() => fromProtoJson(MsgSendSchema, { amount: [{ denom: "ausd", amount: "08" }] }), CoinError);
  assert.throws(() => toProtoJson(MsgSendSchema, create(MsgSendSchema, { amount: [{ denom: "ausd", amount: "08" }] })), CoinError, "text the chain refuses");

  // A Dec's scaled integer likewise: Go reads this wire text as 2251799813685248.
  const rates = create(CommissionRatesSchema, { rate: "0100000000000000000", maxRate: "0x10" });
  assert.deepEqual(toProtoJson(CommissionRatesSchema, rates), { rate: "0.002251799813685248", max_rate: "0.000000000000000016", max_change_rate: "0" });
});

test('a non-nullable Dec that never reached the wire renders as gogo\'s "0", a set one at 18 places', () => {
  assert.deepEqual(toProtoJson(CommissionRatesSchema, create(CommissionRatesSchema)), { rate: "0", max_rate: "0", max_change_rate: "0" });
  assert.deepEqual(toProtoJson(CommissionRatesSchema, create(CommissionRatesSchema, { rate: LegacyDec.fromString("0.1").toWire() })), {
    rate: "0.100000000000000000",
    max_rate: "0",
    max_change_rate: "0",
  });
});

test("an enum name the schema lacks is refused by default and kept on request, the field at zero and the name beside it", () => {
  const proposal = { id: "2", status: "PROPOSAL_STATUS_VETOED_BY_COUNCIL", title: "t" };
  assert.throws(() => fromProtoJson(ProposalSchema, proposal), ProtoJsonError, "a message built from JSON must not carry another value than was written");
  const read = fromProtoJson(ProposalSchema, proposal, { unknownEnum: "keep" });
  assert.equal(read.id, 2n);
  assert.equal(read.status, ProposalStatus.UNSPECIFIED);
  assert.deepEqual(unknownEnumNames(read), { status: "PROPOSAL_STATUS_VETOED_BY_COUNCIL" });
  assert.equal(unknownEnumNames(fromProtoJson(ProposalSchema, { id: "1", status: "PROPOSAL_STATUS_PASSED" }, { unknownEnum: "keep" })), undefined);
  assert.equal(fromProtoJson(ProposalSchema, { status: 9 }).status, 9, "a number is the value, known by name or not");

  // Inside an Any the bytes would carry the zero value, so the Any is kept as the node's JSON, as one of an unknown type is.
  const vote = { "@type": "/cosmos.gov.v1.MsgVote", proposal_id: "7", voter: "ark1v", option: "VOTE_OPTION_DEFER", metadata: "" };
  assert.throws(() => fromProtoJson(AnySchema, vote, { unknownAny: "keep" }), ProtoJsonError);
  const held = fromProtoJson(AnySchema, vote, { unknownAny: "keep", unknownEnum: "keep" });
  assert.equal(held.value.length, 0);
  assert.deepEqual(unknownAnyJson(held), vote);
  assert.equal(decodeMessage(held).known, false);
  // The same vote with an option the schema knows carries its bytes.
  const known = fromProtoJson(AnySchema, { ...vote, option: "VOTE_OPTION_YES" }, { unknownAny: "keep", unknownEnum: "keep" });
  assert.ok(known.value.length > 0);
});

test("a scalar that is not what its field holds is refused by name, with the SDK's error and never the runtime's", () => {
  const info = (member: Record<string, unknown>) => () => fromProtoJson(BaseAccountSchema, { address: "ark1x", ...member });
  for (const [what, member] of [
    ["text for an integer", { account_number: "tall" }],
    ["an empty string for an integer", { account_number: "" }],
    ["a fraction for an integer", { account_number: 1.5 }],
    ["a hex literal for an integer", { account_number: "0x10" }],
    ["a negative for an unsigned integer", { sequence: "-1" }],
    ["more than 64 bits", { sequence: "18446744073709551616" }],
    ["a boolean for an integer", { sequence: true }],
  ] as const) {
    assert.throws(
      info(member),
      (err: unknown) => err instanceof ProtoJsonError && /cosmos\.auth\.v1beta1\.BaseAccount\.(account_number|sequence)/.test(err.message),
      what,
    );
  }
  assert.equal(fromProtoJson(BaseAccountSchema, { account_number: "7", sequence: 3 }).accountNumber, 7n);
  // 32 bits, and base64.
  assert.throws(() => fromProtoJson(TxResponseSchema, { code: "abc" }), ProtoJsonError);
  assert.throws(() => fromProtoJson(TxResponseSchema, { code: 4294967296 }), ProtoJsonError);
  assert.equal(fromProtoJson(TxResponseSchema, { code: "13" }).code, 13);
  assert.throws(
    () => fromProtoJson(AnySchema, { "@type": "/cosmos.crypto.secp256k1.PubKey", key: "AAAAA" }),
    (err: unknown) => err instanceof ProtoJsonError && /PubKey\.key/.test(err.message),
  );
  assert.throws(() => fromHex("zz"), ArkSdkError);
});

test("bytes cast to HexBytes are uppercase hex in the chain's JSON, and a list of inline JSON is a list of what each holds", () => {
  // What the gateway's own marshaller writes for wasmd's Model and its code checksum.
  const model = create(ModelSchema, { key: fromHex("01abff"), value: fromHex("0102") });
  assert.deepEqual(toProtoJson(ModelSchema, model), { key: "01ABFF", value: "AQI=" });
  const read = fromProtoJson(ModelSchema, { key: "636F6E666967", value: "AQI=" });
  assert.equal(utf8Decode(read.key), "config", "read as base64 this key was nine other bytes");
  assert.deepEqual(fromProtoJson(ModelSchema, { key: "01abff", value: "" }).key, fromHex("01abff"), "either case reads");
  assert.throws(
    () => fromProtoJson(ModelSchema, { key: "xyz" }),
    (err: unknown) => err instanceof ProtoJsonError && /Model\.key/.test(err.message),
  );
  const checksum = "DEADBEEF".repeat(8);
  assert.equal(fromProtoJson(QueryCodeInfoResponseSchema, { checksum }).checksum.length, 32, "a code checksum is 32 bytes");
  assert.equal((toProtoJson(QueryCodeInfoResponseSchema, fromProtoJson(QueryCodeInfoResponseSchema, { checksum })) as { checksum: string }).checksum, checksum);

  // A contract authorization's filter: each accepted message is JSON, and the chain's view shows it as JSON.
  const filter = create(AcceptedMessagesFilterSchema, { messages: [utf8Encode('{"transfer":{}}'), utf8Encode('{"b":1,"a":2}')] });
  const view = toProtoJson(AcceptedMessagesFilterSchema, filter);
  assert.deepEqual(view, { messages: [{ transfer: {} }, { b: 1, a: 2 }] });
  assert.deepEqual(
    fromProtoJson(AcceptedMessagesFilterSchema, view).messages.map(utf8Decode),
    ['{"transfer":{}}', '{"b":1,"a":2}'],
    "and it reads back to the same bytes",
  );

  // wasmd names every access type: one it does not list is "Unspecified", never a bare number.
  assert.deepEqual(toProtoJson(AccessConfigSchema, create(AccessConfigSchema, { permission: 5 as AccessType })), { permission: "Unspecified", addresses: [] });
});

test('a message that renders as one value sits under "value" in an Any, and null is not a JSON object', () => {
  // A Duration renders as text, so inside an Any it has no members to lay beside "@type".
  const registry = createRegistry(DurationSchema);
  const any = create(AnySchema, {
    typeUrl: "/google.protobuf.Duration",
    value: toBinary(DurationSchema, create(DurationSchema, { seconds: 1n, nanos: 500_000_000 })),
  });
  assert.deepEqual(toProtoJson(AnySchema, any, { registry }), { "@type": "/google.protobuf.Duration", value: "1.500s" });
  assert.deepEqual(fromProtoJson(AnySchema, { "@type": "/google.protobuf.Duration", value: "1.500s" }, { registry }).value, any.value);
  for (const notAnObject of [null, [], "text", 1, true]) assert.equal(isJsonObject(notAnObject), false);
  assert.equal(isJsonObject({}), true);
});

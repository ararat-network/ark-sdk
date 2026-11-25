// Amino vectors the fixtures do not reach, generated with the chain's own
// x/tx aminojson encoder over the api module's messages decoded from these
// bytes: a oneof under its camel-cased name with each member and with none
// set, a multisig key's threshold_string encoding with key_field members, a
// renamed field, and empty dont_omitempty lists, null unless legacy_coins.
// Each vector is read back to the bytes it was made from, and the decoder's
// rules and refusals follow, one case each.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, createFileRegistry, createRegistry, type DescMessage, fromBinary, type MessageInitShape, setExtension, toBinary } from "@bufbuild/protobuf";
import {
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldOptionsSchema,
  FileDescriptorSetSchema,
  MessageOptionsSchema,
  timestampFromDate,
} from "@bufbuild/protobuf/wkt";
import { aminoDecode, aminoDecodeAny, aminoEncode, aminoEncodeAny, decodeAminoSignDoc, makeAminoSignDoc, toProtoJson } from "../defaults.js";
import { encoding as aminoEncoding, name as aminoName, dont_omitempty as dontOmitempty } from "../gen/amino/amino_pb.js";
import { MsgSetRecognitionPolicySchema } from "../gen/ark/reserve/v1/tx_pb.js";
import { BaseAccountSchema } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import { GenericAuthorizationSchema } from "../gen/cosmos/authz/v1beta1/authz_pb.js";
import { MsgGrantSchema } from "../gen/cosmos/authz/v1beta1/tx_pb.js";
import { MsgMultiSendSchema, MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { PubKeySchema } from "../gen/cosmos/crypto/secp256k1/keys_pb.js";
import { MsgDepositSchema } from "../gen/cosmos/gov/v1/tx_pb.js";
import { TallyParamsSchema, VoteOption } from "../gen/cosmos/gov/v1beta1/gov_pb.js";
import { MsgVoteSchema } from "../gen/cosmos/gov/v1beta1/tx_pb.js";
import { GenesisStateSchema as StakingGenesisStateSchema } from "../gen/cosmos/staking/v1beta1/genesis_pb.js";
import { ParamsSchema as StakingParamsSchema } from "../gen/cosmos/staking/v1beta1/staking_pb.js";
import { FeeSchema, TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MsgExecuteContractSchema, MsgStoreCodeSchema } from "../gen/cosmwasm/wasm/v1/tx_pb.js";
import { type AminoSignDoc, aminoSignDocBytes } from "./aminojson.js";
import { packAny, UnknownTypeError } from "./any.js";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.js";
import { DecError } from "./dec.js";
import { materialise } from "./gogo.js";
import { type JsonObject, type JsonValue, marshalGoJson } from "./json.js";
import { registry } from "./registry.js";

const granter = "ark102p6s52n97e7zcmxc49ufwx04lntre5ktqkkzp";
const grantee = "ark1lw7jrngdgm88ruz8v7k6s70gssu6vryufel8nq";
const val = "arkvaloper107sn6n6ylxxl6md3wtwy9n4u0j5a3azeu70grj";

const vectors: { name: string; schema: DescMessage; bytes: string; amino: string; oneofLast?: true }[] = [
  {
    name: "a StakeAuthorization allow list: the oneof under Validators with its type name",
    schema: MsgGrantSchema,
    bytes:
      "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASKmFyazFsdzdqcm5nZGdtODhydXo4djdrNnM3MGdzc3U2dnJ5dWZlbDhucRqGAQqDAQoqL2Nvc21vcy5zdGFraW5nLnYxYmV0YTEuU3Rha2VBdXRob3JpemF0aW9uElUKHAoFYW5vYWgSEzUwMDAwMDAwMDAwMDAwMDAwMDAgARIzCjFhcmt2YWxvcGVyMTA3c242bjZ5bHh4bDZtZDN3dHd5OW40dTBqNWEzYXpldTcwZ3Jq",
    amino: `{"type":"cosmos-sdk/MsgGrant","value":{"grant":{"authorization":{"type":"cosmos-sdk/StakeAuthorization","value":{"Validators":{"type":"cosmos-sdk/StakeAuthorization/AllowList","value":{"allow_list":{"address":["${val}"]}}},"authorization_type":1,"max_tokens":{"amount":"5000000000000000000","denom":"anoah"}}}},"grantee":"${grantee}","granter":"${granter}"}}`,
    oneofLast: true,
  },
  {
    name: "a StakeAuthorization deny list without a max",
    schema: MsgGrantSchema,
    bytes:
      "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASKmFyazFsdzdqcm5nZGdtODhydXo4djdrNnM3MGdzc3U2dnJ5dWZlbDhucRpnCmUKKi9jb3Ntb3Muc3Rha2luZy52MWJldGExLlN0YWtlQXV0aG9yaXphdGlvbhI3IAIaMwoxYXJrdmFsb3BlcjEwN3NuNm42eWx4eGw2bWQzd3R3eTluNHUwajVhM2F6ZXU3MGdyag==",
    amino: `{"type":"cosmos-sdk/MsgGrant","value":{"grant":{"authorization":{"type":"cosmos-sdk/StakeAuthorization","value":{"Validators":{"type":"cosmos-sdk/StakeAuthorization/DenyList","value":{"deny_list":{"address":["${val}"]}}},"authorization_type":2}}},"grantee":"${grantee}","granter":"${granter}"}}`,
    oneofLast: true,
  },
  {
    name: "a StakeAuthorization with the oneof unset writes Validators once as null",
    schema: MsgGrantSchema,
    bytes:
      "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASKmFyazFsdzdqcm5nZGdtODhydXo4djdrNnM3MGdzc3U2dnJ5dWZlbDhucRoyCjAKKi9jb3Ntb3Muc3Rha2luZy52MWJldGExLlN0YWtlQXV0aG9yaXphdGlvbhICIAM=",
    amino: `{"type":"cosmos-sdk/MsgGrant","value":{"grant":{"authorization":{"type":"cosmos-sdk/StakeAuthorization","value":{"Validators":null,"authorization_type":3}}},"grantee":"${grantee}","granter":"${granter}"}}`,
  },
  {
    name: "a multisig public key: threshold_string over key_field members, under the renamed public_key",
    schema: BaseAccountSchema,
    bytes:
      "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASwAEKKS9jb3Ntb3MuY3J5cHRvLm11bHRpc2lnLkxlZ2FjeUFtaW5vUHViS2V5EpIBCAISRgofL2Nvc21vcy5jcnlwdG8uc2VjcDI1NmsxLlB1YktleRIjCiEDvyKzVZ+zfk1DHHRlAR9voAKoqIi3gVD3hBCXRU3U8nQSRgofL2Nvc21vcy5jcnlwdG8uc2VjcDI1NmsxLlB1YktleRIjCiEC0Ev833nS2JL9DfflT+Uxlc/t1fOJNqEBMp6StWYpjGoYByAD",
    amino: `{"type":"cosmos-sdk/BaseAccount","value":{"account_number":"7","address":"${granter}","public_key":{"type":"tendermint/PubKeyMultisigThreshold","value":{"pubkeys":[{"type":"tendermint/PubKeySecp256k1","value":"A78is1Wfs35NQxx0ZQEfb6ACqKiIt4FQ94QQl0VN1PJ0"},{"type":"tendermint/PubKeySecp256k1","value":"AtBL/N950tiS/Q335U/lMZXP7dXziTahATKekrVmKYxq"}],"threshold":"2"}},"sequence":"3"}}`,
  },
  {
    name: "an empty multisig key writes an empty pubkeys list",
    schema: BaseAccountSchema,
    bytes: "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASLwopL2Nvc21vcy5jcnlwdG8ubXVsdGlzaWcuTGVnYWN5QW1pbm9QdWJLZXkSAggB",
    amino: `{"type":"cosmos-sdk/BaseAccount","value":{"address":"${granter}","public_key":{"type":"tendermint/PubKeyMultisigThreshold","value":{"pubkeys":[],"threshold":"1"}}}}`,
  },
  {
    name: "an empty MsgMultiSend writes its dont_omitempty lists as null, the chain's nil slice",
    schema: MsgMultiSendSchema,
    bytes: "",
    amino: `{"type":"cosmos-sdk/MsgMultiSend","value":{"inputs":null,"outputs":null}}`,
  },
  {
    name: "an input without coins writes [] under legacy_coins beside a null outputs list",
    schema: MsgMultiSendSchema,
    bytes: "CiwKKmFyazEwMnA2czUybjk3ZTd6Y214YzQ5dWZ3eDA0bG50cmU1a3Rxa2t6cA==",
    amino: `{"type":"cosmos-sdk/MsgMultiSend","value":{"inputs":[{"address":"${granter}","coins":[]}],"outputs":null}}`,
  },
  {
    name: "a MsgSend without an amount writes [] under legacy_coins",
    schema: MsgSendSchema,
    bytes: "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASKmFyazFsdzdqcm5nZGdtODhydXo4djdrNnM3MGdzc3U2dnJ5dWZlbDhucQ==",
    amino: `{"type":"cosmos-sdk/MsgSend","value":{"amount":[],"from_address":"${granter}","to_address":"${grantee}"}}`,
  },
  {
    name: "a gov v1 MsgDeposit without an amount writes null",
    schema: MsgDepositSchema,
    bytes: "CAESKmFyazEwMnA2czUybjk3ZTd6Y214YzQ5dWZ3eDA0bG50cmU1a3Rxa2t6cA==",
    amino: `{"type":"cosmos-sdk/v1/MsgDeposit","value":{"amount":null,"depositor":"${granter}","proposal_id":"1"}}`,
  },
  {
    name: "a MsgSetRecognitionPolicy clearing every entry writes null",
    schema: MsgSetRecognitionPolicySchema,
    bytes: "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenA=",
    amino: `{"type":"ark/reserve/MsgSetRecognitionPolicy","value":{"authority":"${granter}","entries":null}}`,
  },
];

for (const v of vectors) {
  test(`amino: ${v.name}`, () => {
    const message = fromBinary(v.schema, fromBase64(v.bytes));
    assert.equal(marshalGoJson(aminoEncode(v.schema, message)), v.amino);
    const decoded = aminoDecode(v.schema, JSON.parse(v.amino) as JsonValue);
    assert.deepEqual(toProtoJson(v.schema, decoded), toProtoJson(v.schema, message), "read back to the message it was made from");
    // And to its bytes, but for the order of their fields, which amino JSON does not carry: the two vectors with a
    // oneof member set hold it after authorization_type, a later field, where bytes written here are in field order.
    if (!v.oneofLast) assert.equal(toBase64(toBinary(v.schema, decoded)), v.bytes);
  });
}

test("amino: the bytes of an Int are read as the chain reads them and written as the integer", () => {
  // The registry's one Int held as bytes. The chain's encoder unmarshals it, base taken from the text, and writes
  // the integer; a string Int goes out as its text, which the fixtures cover.
  const state = materialise(StakingGenesisStateSchema, create(StakingGenesisStateSchema));
  state.lastTotalPower = utf8Encode("0100");
  assert.equal((aminoEncode(StakingGenesisStateSchema, state) as JsonObject).last_total_power, "64");
});

test("amino: a contract message's JSON is signed member for member, a __proto__ key and a negative zero included", () => {
  // What the chain's encoder writes for each, run over wasmd's MsgExecuteContract: it reads the JSON and writes it back with sorted keys.
  const signed = (msg: string) => {
    const execute = create(MsgExecuteContractSchema, { sender: "ark1s", contract: "ark1c", msg: utf8Encode(msg) });
    return marshalGoJson((aminoEncode(MsgExecuteContractSchema, execute) as { value: { msg: JsonObject } }).value.msg);
  };
  assert.equal(signed('{"__proto__":{"x":1},"a":1}'), '{"__proto__":{"x":1},"a":1}', "the member is signed, not taken for the object's prototype");
  assert.equal(signed('{"b":{"__proto__":2},"a":1}'), '{"a":1,"b":{"__proto__":2}}');
  assert.equal(signed('{"x":-0}'), '{"x":-0}', "Go writes the sign of a negative zero");
  assert.equal(signed('{"z":1,"a":[3,{"d":1,"c":2}]}'), '{"a":[3,{"c":2,"d":1}],"z":1}');
});

test("amino: the document holds a string as the transaction's bytes carry it, half a surrogate pair as U+FFFD", () => {
  // The body's bytes are UTF-8, where the half becomes U+FFFD, and the chain writes that character as it is.
  const body = create(TxBodySchema, { memo: "gm \ud83d" });
  const doc = makeAminoSignDoc({ body, fee: create(FeeSchema, { gasLimit: 1n }), chainId: "localark", accountNumber: 1n, sequence: 0n });
  assert.equal(doc.memo, "gm \ufffd");
  const bytes = aminoSignDocBytes(doc);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('"memo":"gm \ufffd"'), "the character itself, three bytes, not a six-character escape");
  assert.ok(!text.includes("\\ufffd"));
});

test("amino: a message with no amino name is encoded bare, and one with a name under it", () => {
  const coin = create(CoinSchema, { denom: "ausd", amount: "5" });
  assert.deepEqual(aminoEncode(CoinSchema, coin), { denom: "ausd", amount: "5" }, "no wrapper for a type the chain gives no amino name");
  const send = create(MsgSendSchema, { fromAddress: "ark1a", toAddress: "ark1b", amount: [coin] });
  assert.deepEqual(aminoEncode(MsgSendSchema, send), {
    type: "cosmos-sdk/MsgSend",
    value: { from_address: "ark1a", to_address: "ark1b", amount: [{ denom: "ausd", amount: "5" }] },
  });
});

/** A decoder's rule: the JSON the encoder writes for a message, which must read back to that message's bytes. */
function rule<Desc extends DescMessage>(name: string, schema: Desc, init: MessageInitShape<Desc>, amino: string) {
  return { name, schema: schema as DescMessage, message: create(schema, init) as ReturnType<typeof create<DescMessage>>, amino };
}

const rules = [
  rule(
    "an omitted field is its default, and a 64-bit integer is read from text",
    MsgDepositSchema,
    { proposalId: 18446744073709551615n, depositor: granter, amount: [{ denom: "ausd", amount: "5" }] },
    `{"type":"cosmos-sdk/v1/MsgDeposit","value":{"amount":[{"amount":"5","denom":"ausd"}],"depositor":"${granter}","proposal_id":"18446744073709551615"}}`,
  ),
  rule(
    "an enum is read from its integer",
    MsgVoteSchema,
    { proposalId: 4n, voter: granter, option: VoteOption.NO_WITH_VETO },
    `{"type":"cosmos-sdk/MsgVote","value":{"option":4,"proposal_id":"4","voter":"${granter}"}}`,
  ),
  rule(
    "bytes are read from base64",
    MsgStoreCodeSchema,
    { sender: granter, wasmByteCode: new Uint8Array([0, 97, 115, 109, 255]) },
    `{"type":"wasm/MsgStoreCode","value":{"sender":"${granter}","wasm_byte_code":"AGFzbf8="}}`,
  ),
  rule(
    "a Timestamp is read from RFC 3339 with its fraction, and a nested Any from its amino name",
    MsgGrantSchema,
    {
      granter,
      grantee,
      grant: {
        authorization: packAny(GenericAuthorizationSchema, create(GenericAuthorizationSchema, { msg: "/cosmos.bank.v1beta1.MsgSend" })),
        expiration: { ...timestampFromDate(new Date("2027-01-02T03:04:05Z")), nanos: 500_000_000 },
      },
    },
    `{"type":"cosmos-sdk/MsgGrant","value":{"grant":{"authorization":{"type":"cosmos-sdk/GenericAuthorization","value":{"msg":"/cosmos.bank.v1beta1.MsgSend"}},"expiration":"2027-01-02T03:04:05.5Z"},"grantee":"${grantee}","granter":"${granter}"}}`,
  ),
  rule(
    "a Duration is read from its nanoseconds, and a Dec in a string field from decimal text to its scaled integer",
    StakingParamsSchema,
    { unbondingTime: { seconds: 1_814_400n, nanos: 5 }, maxValidators: 100, bondDenom: "anoah", minCommissionRate: "50000000000000000" },
    `{"type":"cosmos-sdk/x/staking/Params","value":{"bond_denom":"anoah","max_validators":100,"min_commission_rate":"0.050000000000000000","unbonding_time":"1814400000000005"}}`,
  ),
  rule(
    "a negative Duration keeps one sign in both its parts, and an absent Dec, written as 0 with no places, stays absent",
    StakingParamsSchema,
    { unbondingTime: { seconds: -1n, nanos: -500_000_000 } },
    `{"type":"cosmos-sdk/x/staking/Params","value":{"min_commission_rate":"0","unbonding_time":"-1500000000"}}`,
  ),
  rule(
    "a Dec in a bytes field is read to the bytes of its scaled integer, in a message with no amino name",
    TallyParamsSchema,
    { quorum: utf8Encode("334000000000000000"), threshold: utf8Encode("-500000000000000000") },
    `{"quorum":"0.334000000000000000","threshold":"-0.500000000000000000"}`,
  ),
];

for (const v of rules) {
  test(`amino decoder: ${v.name}`, () => {
    assert.equal(marshalGoJson(aminoEncode(v.schema, v.message)), v.amino, "the JSON is what the encoder writes");
    assert.equal(toBase64(toBinary(v.schema, aminoDecode(v.schema, JSON.parse(v.amino) as JsonValue))), toBase64(toBinary(v.schema, v.message)));
  });
}

test("amino decoder: an Int is read to its text, in a string field and as the bytes of one", () => {
  const coin = aminoDecode(CoinSchema, { denom: "ausd", amount: "0" });
  assert.equal(coin.amount, "0", 'a zero Int is the text "0", as the chain writes one, not an absent field');
  const state = materialise(StakingGenesisStateSchema, create(StakingGenesisStateSchema));
  state.lastTotalPower = utf8Encode("64");
  const decoded = aminoDecode(StakingGenesisStateSchema, aminoEncode(StakingGenesisStateSchema, state));
  assert.equal(utf8Decode(decoded.lastTotalPower), "64");
  assert.equal(toBase64(toBinary(StakingGenesisStateSchema, decoded)), toBase64(toBinary(StakingGenesisStateSchema, state)));
});

test("amino decoder: a contract message's JSON is read to equivalent bytes, compact and sorted, and nothing else differs", () => {
  const written = '{"b": 1, "a": {"z": [1, -0, 2.5e30], "y": null}, "<": " "}';
  const execute = create(MsgExecuteContractSchema, { sender: "ark1s", contract: "ark1c", msg: utf8Encode(written), funds: [{ denom: "ausd", amount: "7" }] });
  const amino = aminoEncode(MsgExecuteContractSchema, execute);
  const decoded = aminoDecode(MsgExecuteContractSchema, amino);
  // The bytes the sender wrote are not in the document; these are the same JSON as the encoder would write it.
  assert.equal(utf8Decode(decoded.msg), '{"\\u003c":"\\u2028","a":{"y":null,"z":[1,-0,2.5e+30]},"b":1}');
  assert.deepEqual(JSON.parse(utf8Decode(decoded.msg)), JSON.parse(written));
  assert.equal(marshalGoJson(aminoEncode(MsgExecuteContractSchema, decoded)), marshalGoJson(amino), "and it signs the same document");
  assert.equal(
    toBase64(toBinary(MsgExecuteContractSchema, { ...decoded, msg: execute.msg })),
    toBase64(toBinary(MsgExecuteContractSchema, execute)),
    "the payload is the one field that differs",
  );
  // A payload that is JSON's null is a value, not an absent field.
  const nothing = create(MsgExecuteContractSchema, { sender: "ark1s", contract: "ark1c", msg: utf8Encode("null") });
  assert.equal(utf8Decode(aminoDecode(MsgExecuteContractSchema, aminoEncode(MsgExecuteContractSchema, nothing)).msg), "null");
});

test("amino decoder: a packed message is found by its amino name, or by its type URL when it has none", () => {
  const send = packAny(MsgSendSchema, create(MsgSendSchema, { fromAddress: granter, toAddress: grantee, amount: [{ denom: "ausd", amount: "5" }] }));
  const named = aminoDecodeAny(aminoEncodeAny(send));
  assert.equal(named.typeUrl, "/cosmos.bank.v1beta1.MsgSend");
  assert.equal(toBase64(named.value), toBase64(send.value));

  // A Coin has no amino name: the encoder writes it under its type URL, and bare when it is not packed.
  const coin = create(CoinSchema, { denom: "ausd", amount: "5" });
  const bare = { denom: "ausd", amount: "5" };
  assert.deepEqual(aminoEncodeAny(packAny(CoinSchema, coin)), { type: "/cosmos.base.v1beta1.Coin", value: bare });
  const unnamed = aminoDecodeAny({ type: "/cosmos.base.v1beta1.Coin", value: bare });
  assert.equal(unnamed.typeUrl, "/cosmos.base.v1beta1.Coin");
  assert.equal(toBase64(unnamed.value), toBase64(toBinary(CoinSchema, coin)));
  assert.equal(toBase64(toBinary(CoinSchema, aminoDecode(CoinSchema, bare))), toBase64(toBinary(CoinSchema, coin)));

  // A key of no bytes is null under its name, and reads back as the empty key.
  const emptyKey = aminoDecodeAny({ type: "tendermint/PubKeySecp256k1", value: null });
  assert.equal(emptyKey.typeUrl, "/cosmos.crypto.secp256k1.PubKey");
  assert.equal(emptyKey.value.length, 0);
  assert.equal(toBase64(aminoDecode(PubKeySchema, { type: "tendermint/PubKeySecp256k1", value: "AQID" }).key), "AQID");
});

test("amino decoder: a sign document reads back to its body, fee, chain, account number, and sequence", () => {
  const body = create(TxBodySchema, {
    messages: [
      packAny(MsgSendSchema, create(MsgSendSchema, { fromAddress: granter, toAddress: grantee, amount: [{ denom: "ausd", amount: "5" }] })),
      packAny(MsgVoteSchema, create(MsgVoteSchema, { proposalId: 4n, voter: granter, option: VoteOption.YES })),
    ],
    memo: "gm <ark> \u{1F6A2}",
    timeoutHeight: 1234n,
    unordered: true,
    timeoutTimestamp: { seconds: 1_800_000_000n, nanos: 120_000_000 },
  });
  const fee = create(FeeSchema, { amount: [{ denom: "anoah", amount: "31500000000000000" }], gasLimit: 300_000n, payer: grantee, granter });
  const doc = makeAminoSignDoc({ body, fee, chainId: "arklocal-1", accountNumber: 12n, sequence: 18446744073709551615n });
  // As a signer meets it: parsed from the bytes it was asked to sign.
  const decoded = decodeAminoSignDoc(JSON.parse(utf8Decode(aminoSignDocBytes(doc))) as AminoSignDoc);
  assert.equal(toBase64(toBinary(TxBodySchema, decoded.body)), toBase64(toBinary(TxBodySchema, body)));
  assert.equal(toBase64(toBinary(FeeSchema, decoded.fee)), toBase64(toBinary(FeeSchema, fee)));
  assert.deepEqual([decoded.chainId, decoded.accountNumber, decoded.sequence], ["arklocal-1", 12n, 18446744073709551615n]);

  // The least a document holds: no messages, no fee coins, and the optional members left out.
  const least = decodeAminoSignDoc(makeAminoSignDoc({ body: create(TxBodySchema), fee: create(FeeSchema), chainId: "", accountNumber: 0n, sequence: 0n }));
  assert.equal(toBinary(TxBodySchema, least.body).length + toBinary(FeeSchema, least.fee).length, 0);
});

const STRING = { type: FieldDescriptorProto_Type.STRING, label: FieldDescriptorProto_Label.OPTIONAL };

/**
 * Types the chain's protos have no example of, beside every generated one: two messages under one amino name, a
 * repeated field under null_slice_as_empty, which shares legacy_coins' rule, and a map in a message with an amino name.
 */
function registryWithOddTypes() {
  const nullSlice = create(FieldOptionsSchema);
  setExtension(nullSlice, aminoEncoding, "null_slice_as_empty");
  setExtension(nullSlice, dontOmitempty, true);
  const twin = create(MessageOptionsSchema);
  setExtension(twin, aminoName, "odd/Twin");
  const mapped = create(MessageOptionsSchema);
  setExtension(mapped, aminoName, "odd/Mapped");
  const odd = createFileRegistry(
    create(FileDescriptorSetSchema, {
      file: [
        {
          name: "ark/odd/v1/odd.proto",
          package: "ark.odd.v1",
          syntax: "proto3",
          messageType: [
            {
              name: "Twin",
              options: twin,
              field: [{ ...STRING, name: "items", number: 1, jsonName: "items", label: FieldDescriptorProto_Label.REPEATED, options: nullSlice }],
            },
            { name: "OtherTwin", options: twin },
            {
              name: "Mapped",
              options: mapped,
              field: [
                {
                  name: "labels",
                  number: 1,
                  jsonName: "labels",
                  type: FieldDescriptorProto_Type.MESSAGE,
                  label: FieldDescriptorProto_Label.REPEATED,
                  typeName: ".ark.odd.v1.Mapped.LabelsEntry",
                },
              ],
              nestedType: [
                {
                  name: "LabelsEntry",
                  options: { mapEntry: true },
                  field: [
                    { ...STRING, name: "key", number: 1, jsonName: "key" },
                    { ...STRING, name: "value", number: 2, jsonName: "value" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  return createRegistry(registry, odd);
}

test("amino decoder: null_slice_as_empty reads [] as the empty list, as legacy_coins does", () => {
  const odd = registryWithOddTypes();
  const twin = odd.getMessage("ark.odd.v1.Twin")!;
  // Named apart from its twin, the type decodes by its schema: only a lookup by the shared name is refused.
  assert.deepEqual(aminoEncode(twin, create(twin), { registry: odd }), { type: "odd/Twin", value: { items: [] } });
  assert.equal(toBinary(twin, aminoDecode(twin, { type: "odd/Twin", value: { items: [] } }, { registry: odd })).length, 0);
  const filled = aminoDecode(twin, { type: "odd/Twin", value: { items: ["a", "b"] } }, { registry: odd });
  assert.deepEqual(aminoEncode(twin, filled, { registry: odd }), { type: "odd/Twin", value: { items: ["a", "b"] } });
});

test("amino decoder: what it refuses", () => {
  const odd = registryWithOddTypes();
  const send = { from_address: granter, to_address: grantee, amount: [] };
  const doc = makeAminoSignDoc({ body: create(TxBodySchema), fee: create(FeeSchema, { gasLimit: 1n }), chainId: "c", accountNumber: 1n, sequence: 2n });
  const allowList = { type: "cosmos-sdk/StakeAuthorization/AllowList", value: { allow_list: { address: [val] } } };
  const stake = (validators: JsonValue) => ({ type: "cosmos-sdk/StakeAuthorization", value: { Validators: validators, authorization_type: 1 } });
  const refusals: { name: string; decode: () => unknown; error: RegExp | typeof UnknownTypeError | typeof DecError }[] = [
    { name: "an amino name the registry does not know", decode: () => aminoDecodeAny({ type: "cosmos-sdk/MsgNever", value: {} }), error: UnknownTypeError },
    {
      name: "a name known only to another registry",
      decode: () => aminoDecodeAny({ type: "cosmos-sdk/MsgSend", value: send }, { registry: createRegistry() }),
      error: UnknownTypeError,
    },
    { name: "a type URL the registry does not know", decode: () => aminoDecodeAny({ type: "/ark.never.v1.Msg", value: {} }), error: UnknownTypeError },
    {
      name: "a type URL for a message the encoder writes under its amino name",
      decode: () => aminoDecodeAny({ type: "/cosmos.bank.v1beta1.MsgSend", value: send }),
      error: UnknownTypeError,
    },
    {
      name: "an amino name two registered types share",
      decode: () => aminoDecodeAny({ type: "odd/Twin", value: { items: [] } }, { registry: odd }),
      error: /odd\/Twin is shared by ark\.odd\.v1\.Twin and ark\.odd\.v1\.OtherTwin/,
    },
    {
      name: "a member that names no field",
      decode: () => aminoDecodeAny({ type: "cosmos-sdk/MsgSend", value: { ...send, note: "x" } }),
      error: /MsgSend: no field is named note/,
    },
    {
      name: "a field under its proto name where amino renames it",
      decode: () => aminoDecode(BaseAccountSchema, { type: "cosmos-sdk/BaseAccount", value: { pub_key: null } }),
      error: /no field is named pub_key/,
    },
    {
      name: "a member beside type and value",
      decode: () => aminoDecodeAny({ type: "cosmos-sdk/MsgSend", value: send, extra: 1 }),
      error: /no field is named extra/,
    },
    {
      name: "another type than the schema's",
      decode: () => aminoDecode(MsgSendSchema, { type: "cosmos-sdk/MsgMultiSend", value: send }),
      error: /expected the type cosmos-sdk\/MsgSend/,
    },
    { name: "a map", decode: () => aminoDecodeAny({ type: "odd/Mapped", value: { labels: { a: "b" } } }, { registry: odd }), error: /maps are not supported/ },
    {
      name: "a module account",
      decode: () => aminoDecodeAny({ type: "cosmos-sdk/ModuleAccount", value: { name: "mint" } }),
      error: /module_account encoding is not supported/,
    },
    {
      name: "a oneof under a type none of its members has",
      decode: () => aminoDecodeAny(stake({ ...allowList, type: "cosmos-sdk/StakeAuthorization/Never" })),
      error: /no member is written as/,
    },
    {
      name: "a oneof whose type and field are of two members",
      decode: () => aminoDecodeAny(stake({ ...allowList, value: { deny_list: { address: [val] } } })),
      error: /no member is written as/,
    },
    {
      name: "a 64-bit integer as a number",
      decode: () => aminoDecode(MsgVoteSchema, { type: "cosmos-sdk/MsgVote", value: { proposal_id: 4 } }),
      error: /expected an integer in decimal text/,
    },
    {
      name: "a 64-bit integer with a leading zero",
      decode: () => aminoDecode(MsgVoteSchema, { type: "cosmos-sdk/MsgVote", value: { proposal_id: "04" } }),
      error: /expected an integer in decimal text/,
    },
    {
      name: "a 64-bit integer out of range",
      decode: () => aminoDecode(MsgVoteSchema, { type: "cosmos-sdk/MsgVote", value: { proposal_id: "18446744073709551616" } }),
      error: /out of range/,
    },
    {
      name: "an enum by its name",
      decode: () => aminoDecode(MsgVoteSchema, { type: "cosmos-sdk/MsgVote", value: { option: "VOTE_OPTION_YES" } }),
      error: /expected an enum's number/,
    },
    {
      name: "bytes that are not base64",
      decode: () => aminoDecode(MsgStoreCodeSchema, { type: "wasm/MsgStoreCode", value: { wasm_byte_code: "!" } }),
      error: /not base64/,
    },
    { name: "a Dec with more places than it holds", decode: () => aminoDecode(TallyParamsSchema, { quorum: "0.0000000000000000001" }), error: DecError },
    {
      name: "a sign document member that names nothing",
      decode: () => decodeAminoSignDoc({ ...doc, extension_options: [] } as AminoSignDoc),
      error: /sign document: no field is named extension_options/,
    },
    {
      name: "a fee member that names nothing",
      decode: () => decodeAminoSignDoc({ ...doc, fee: { ...doc.fee, tip: "1" } } as AminoSignDoc),
      error: /fee: no field is named tip/,
    },
    {
      name: "a sign document without its messages",
      decode: () => decodeAminoSignDoc({ ...doc, msgs: undefined } as unknown as AminoSignDoc),
      error: /msgs is undefined/,
    },
    // What reads without complaint but is not what the encoder writes: the decoded form would sign other bytes.
    {
      name: "a Dec without its eighteen places",
      decode: () => aminoDecode(TallyParamsSchema, { quorum: "0.5" }),
      error: /not the amino JSON its decoded form encodes to/,
    },
    {
      name: "a string written at its zero value, where the encoder omits it",
      decode: () => aminoDecode(MsgVoteSchema, { type: "cosmos-sdk/MsgVote", value: { voter: "" } }),
      error: /not the amino JSON its decoded form encodes to/,
    },
    {
      name: "an empty array where the encoder writes null",
      decode: () => aminoDecodeAny({ type: "cosmos-sdk/MsgMultiSend", value: { inputs: [], outputs: null } }),
      error: /not the amino JSON its decoded form encodes to/,
    },
    {
      name: "a timestamp in another zone",
      decode: () => decodeAminoSignDoc({ ...doc, timeout_timestamp: "2027-01-02T03:04:05+08:00" }),
      error: /sign document: not the amino JSON/,
    },
    { name: "a member written at its zero value", decode: () => decodeAminoSignDoc({ ...doc, unordered: false }), error: /sign document: not the amino JSON/ },
    {
      name: "a zero timeout height written out",
      decode: () => decodeAminoSignDoc({ ...doc, timeout_height: "0" }),
      error: /sign document: not the amino JSON/,
    },
  ];
  for (const r of refusals) {
    if (r.error instanceof RegExp)
      assert.throws(r.decode, (err: unknown) => err instanceof Error && err.name === "AminoError" && (r.error as RegExp).test(err.message), r.name);
    else assert.throws(r.decode, r.error, r.name);
  }
});

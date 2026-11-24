// Amino vectors the fixtures do not reach, generated with the chain's own
// x/tx aminojson encoder over the api module's messages decoded from these
// bytes: a oneof under its camel-cased name with each member and with none
// set, a multisig key's threshold_string encoding with key_field members, a
// renamed field, and empty dont_omitempty lists, null unless legacy_coins.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, type DescMessage, fromBinary } from "@bufbuild/protobuf";
import { aminoEncode, makeAminoSignDoc } from "../defaults.js";
import { MsgSetRecognitionPolicySchema } from "../gen/ark/reserve/v1/tx_pb.js";
import { BaseAccountSchema } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import { MsgGrantSchema } from "../gen/cosmos/authz/v1beta1/tx_pb.js";
import { MsgMultiSendSchema, MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { MsgDepositSchema } from "../gen/cosmos/gov/v1/tx_pb.js";
import { GenesisStateSchema as StakingGenesisStateSchema } from "../gen/cosmos/staking/v1beta1/genesis_pb.js";
import { FeeSchema, TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MsgExecuteContractSchema } from "../gen/cosmwasm/wasm/v1/tx_pb.js";
import { aminoSignDocBytes } from "./aminojson.js";
import { fromBase64, utf8Encode } from "./bytes.js";
import { materialise } from "./gogo.js";
import { type JsonObject, marshalGoJson } from "./json.js";

const granter = "ark102p6s52n97e7zcmxc49ufwx04lntre5ktqkkzp";
const grantee = "ark1lw7jrngdgm88ruz8v7k6s70gssu6vryufel8nq";
const val = "arkvaloper107sn6n6ylxxl6md3wtwy9n4u0j5a3azeu70grj";

const vectors: { name: string; schema: DescMessage; bytes: string; amino: string }[] = [
  {
    name: "a StakeAuthorization allow list: the oneof under Validators with its type name",
    schema: MsgGrantSchema,
    bytes:
      "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASKmFyazFsdzdqcm5nZGdtODhydXo4djdrNnM3MGdzc3U2dnJ5dWZlbDhucRqGAQqDAQoqL2Nvc21vcy5zdGFraW5nLnYxYmV0YTEuU3Rha2VBdXRob3JpemF0aW9uElUKHAoFYW5vYWgSEzUwMDAwMDAwMDAwMDAwMDAwMDAgARIzCjFhcmt2YWxvcGVyMTA3c242bjZ5bHh4bDZtZDN3dHd5OW40dTBqNWEzYXpldTcwZ3Jq",
    amino: `{"type":"cosmos-sdk/MsgGrant","value":{"grant":{"authorization":{"type":"cosmos-sdk/StakeAuthorization","value":{"Validators":{"type":"cosmos-sdk/StakeAuthorization/AllowList","value":{"allow_list":{"address":["${val}"]}}},"authorization_type":1,"max_tokens":{"amount":"5000000000000000000","denom":"anoah"}}}},"grantee":"${grantee}","granter":"${granter}"}}`,
  },
  {
    name: "a StakeAuthorization deny list without a max",
    schema: MsgGrantSchema,
    bytes:
      "CiphcmsxMDJwNnM1Mm45N2U3emNteGM0OXVmd3gwNGxudHJlNWt0cWtrenASKmFyazFsdzdqcm5nZGdtODhydXo4djdrNnM3MGdzc3U2dnJ5dWZlbDhucRpnCmUKKi9jb3Ntb3Muc3Rha2luZy52MWJldGExLlN0YWtlQXV0aG9yaXphdGlvbhI3IAIaMwoxYXJrdmFsb3BlcjEwN3NuNm42eWx4eGw2bWQzd3R3eTluNHUwajVhM2F6ZXU3MGdyag==",
    amino: `{"type":"cosmos-sdk/MsgGrant","value":{"grant":{"authorization":{"type":"cosmos-sdk/StakeAuthorization","value":{"Validators":{"type":"cosmos-sdk/StakeAuthorization/DenyList","value":{"deny_list":{"address":["${val}"]}}},"authorization_type":2}}},"grantee":"${grantee}","granter":"${granter}"}}`,
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

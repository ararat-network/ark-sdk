// Amino vectors the fixtures do not reach, generated with the chain's own
// x/tx aminojson encoder over the api module's messages: a oneof under its
// camel-cased name with each member and with none set, a multisig key's
// threshold_string encoding with key_field members, and a renamed field.
import assert from "node:assert/strict";
import { test } from "node:test";

import { type DescMessage, fromBinary } from "@bufbuild/protobuf";

import { BaseAccountSchema } from "../gen/cosmos/auth/v1beta1/auth_pb.js";
import { MsgGrantSchema } from "../gen/cosmos/authz/v1beta1/tx_pb.js";
import { aminoEncode } from "./aminojson.js";
import { fromBase64 } from "./bytes.js";
import { marshalGoJson } from "./json.js";

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
];

for (const v of vectors) {
  test(`amino: ${v.name}`, () => {
    const message = fromBinary(v.schema, fromBase64(v.bytes));
    assert.equal(marshalGoJson(aminoEncode(v.schema, message)), v.amino);
  });
}

// Every transaction fixture, byte for byte: the chain's JSON view of the
// decoded transaction, the body and auth-info bytes rebuilt from that JSON,
// and the amino sign bytes a Ledger would sign.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import { AuthInfoSchema, TxBodySchema, TxRawSchema, TxSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { fixtures } from "../testing/fixtures.js";
import { expectedTxJson } from "../testing/gaps.js";
import { aminoSignDocBytes, makeAminoSignDoc } from "./aminojson.js";
import { fromBase64, toBase64, utf8Decode } from "./bytes.js";
import { materialise } from "./gogo.js";
import { fromProtoJson, toProtoJson } from "./protojson.js";

for (const f of fixtures()) {
  if (!f.tx_bytes) continue;
  test(`${f.name}: proto JSON view, bytes from JSON, amino sign bytes`, () => {
    const raw = fromBinary(TxRawSchema, fromBase64(f.tx_bytes!));
    assert.equal(toBase64(raw.bodyBytes), f.sign_mode_direct!.body_bytes);
    assert.equal(toBase64(raw.authInfoBytes), f.sign_mode_direct!.auth_info_bytes);
    const body = fromBinary(TxBodySchema, raw.bodyBytes);
    const authInfo = fromBinary(AuthInfoSchema, raw.authInfoBytes);
    const tx = create(TxSchema, { body, authInfo, signatures: raw.signatures });

    assert.deepEqual(toProtoJson(TxSchema, tx), expectedTxJson(f.name, f.tx));

    const rebuilt = fromProtoJson(TxSchema, f.tx as never);
    assert.equal(toBase64(toBinary(TxBodySchema, materialise(TxBodySchema, rebuilt.body!))), f.sign_mode_direct!.body_bytes, "body bytes from JSON");
    assert.equal(toBase64(toBinary(AuthInfoSchema, materialise(AuthInfoSchema, rebuilt.authInfo!))), f.sign_mode_direct!.auth_info_bytes, "auth info bytes from JSON");

    const doc = makeAminoSignDoc({
      body,
      fee: authInfo.fee!,
      chainId: f.chain_id,
      accountNumber: BigInt(f.signer!.account_number),
      sequence: BigInt(f.signer!.sequence),
    });
    assert.equal(utf8Decode(aminoSignDocBytes(doc)), f.sign_mode_amino!.sign_bytes);
  });
}

// Every transaction fixture, byte for byte: the chain's JSON view of the
// decoded transaction, the body and auth-info bytes rebuilt from that JSON,
// the amino sign bytes a Ledger would sign, and the transaction read back
// from those sign bytes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { decodeAminoSignDoc, fromProtoJson, makeAminoSignDoc, toProtoJson } from "../defaults.js";
import { AuthInfoSchema, FeeSchema, TxBodySchema, TxRawSchema, TxSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { amounts, txFixtures } from "../testing/fixtures.js";
import { expectedTxJson } from "../testing/gaps.js";
import { type AminoSignDoc, aminoSignDocBytes } from "./aminojson.js";
import { fromBase64, toBase64, utf8Decode } from "./bytes.js";
import { materialise } from "./gogo.js";

for (const f of txFixtures()) {
  test(`${f.name}: proto JSON view, bytes from JSON, amino sign bytes`, () => {
    const raw = fromBinary(TxRawSchema, fromBase64(f.tx_bytes));
    assert.equal(toBase64(raw.bodyBytes), f.sign_mode_direct.body_bytes);
    assert.equal(toBase64(raw.authInfoBytes), f.sign_mode_direct.auth_info_bytes);
    const body = fromBinary(TxBodySchema, raw.bodyBytes);
    const authInfo = fromBinary(AuthInfoSchema, raw.authInfoBytes);
    const tx = create(TxSchema, { body, authInfo, signatures: raw.signatures });

    assert.deepEqual(toProtoJson(TxSchema, tx), expectedTxJson(f.name, f.tx));

    const rebuilt = fromProtoJson(TxSchema, f.tx);
    assert.equal(toBase64(toBinary(TxBodySchema, materialise(TxBodySchema, rebuilt.body!))), f.sign_mode_direct.body_bytes, "body bytes from JSON");
    assert.equal(
      toBase64(toBinary(AuthInfoSchema, materialise(AuthInfoSchema, rebuilt.authInfo!))),
      f.sign_mode_direct.auth_info_bytes,
      "auth info bytes from JSON",
    );

    const doc = makeAminoSignDoc({
      body,
      fee: authInfo.fee!,
      chainId: f.chain_id,
      accountNumber: BigInt(f.signer.account_number),
      sequence: BigInt(f.signer.sequence),
    });
    assert.equal(utf8Decode(aminoSignDocBytes(doc)), f.sign_mode_amino.sign_bytes);
  });

  test(`${f.name}: the amino sign bytes decode to the transaction they were made from`, () => {
    const decoded = decodeAminoSignDoc(JSON.parse(f.sign_mode_amino.sign_bytes) as AminoSignDoc);

    // The encoder, which the test above pins, is the check: what was decoded encodes to the bytes it was decoded from.
    assert.equal(utf8Decode(aminoSignDocBytes(makeAminoSignDoc(decoded))), f.sign_mode_amino.sign_bytes, "sign bytes from the decoded document");

    // And it is the transaction the direct document signs, byte for byte. No fixture is excepted: the six that carry a
    // contract's message hold it as the compact, sorted JSON the decoder writes back.
    assert.equal(toBase64(toBinary(TxBodySchema, decoded.body)), f.sign_mode_direct.body_bytes, "body bytes from the amino document");
    const fee = fromBinary(AuthInfoSchema, fromBase64(f.sign_mode_direct.auth_info_bytes)).fee!;
    assert.equal(toBase64(toBinary(FeeSchema, decoded.fee)), toBase64(toBinary(FeeSchema, fee)), "fee from the amino document");
    assert.deepEqual(amounts(decoded.fee.amount), amounts(f.fee.declared), "the fee the fixture declares");
    assert.equal(decoded.fee.gasLimit.toString(), f.fee.gas_limit);
    assert.deepEqual(
      { chainId: decoded.chainId, accountNumber: decoded.accountNumber.toString(), sequence: decoded.sequence.toString() },
      { chainId: f.chain_id, accountNumber: f.signer.account_number, sequence: f.signer.sequence },
    );
  });
}

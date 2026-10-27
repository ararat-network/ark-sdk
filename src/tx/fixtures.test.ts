// Every signed fixture rebuilt by the builder from its messages and declared
// fee: body and auth-info bytes, the direct sign document, the deterministic
// signature, the raw bytes, and the hash; and its declared fee recomputed
// from the tax, gas price, gas limit, and pads it records.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary } from "@bufbuild/protobuf";

import { fromHex, toBase64 } from "../codec/bytes.js";
import { fromProtoJson } from "../codec/protojson.js";
import { GasPriceSchema } from "../gen/ark/treasury/v1/treasury_pb.js";
import { SignDocSchema, TxBodySchema, TxSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { fixtureKey, fixtures } from "../testing/fixtures.js";
import { makeFee } from "./body.js";
import { signTx } from "./builder.js";
import { quoteFee } from "./fee.js";
import { directSignBytes } from "./signdoc.js";

/** Fixtures whose declaration was overridden on purpose, so the quote does not reproduce it. */
const overriddenDeclaration = new Set(["refused_fee_short_of_tax"]);

for (const f of fixtures()) {
  if (!f.signer || !f.fee || !f.tx) continue;
  test(`${f.name}: the builder reproduces the signed transaction`, async () => {
    const key = fixtureKey(f.signer!.key);
    const signer = MemorySigner.fromPrivateKey(fromHex(key.private_key_hex));
    assert.equal(signer.address, f.signer!.address);

    const body = fromProtoJson(TxBodySchema, (f.tx as { body: never }).body);
    const fee = makeFee({ amount: f.fee!.declared, gasLimit: BigInt(f.fee!.gas_limit) });
    const signed = await signTx({
      signer,
      address: signer.address,
      chainId: f.chain_id,
      accountNumber: BigInt(f.signer!.account_number),
      sequence: BigInt(f.signer!.sequence),
      messages: body.messages,
      memo: body.memo,
      fee,
    });
    assert.equal(toBase64(signed.bodyBytes), f.sign_mode_direct!.body_bytes, "body bytes");
    assert.equal(toBase64(signed.authInfoBytes), f.sign_mode_direct!.auth_info_bytes, "auth info bytes");
    assert.equal(toBase64(directSignBytes(signed.signDoc!)), f.sign_mode_direct!.sign_doc, "sign doc");
    assert.equal(toBase64(signed.signature), f.signature, "signature");
    assert.equal(toBase64(signed.txBytes), f.tx_bytes, "tx bytes");
    assert.equal(signed.hash, f.tx_hash, "hash");
    assert.deepEqual(fromBinary(TxSchema, signed.txBytes).signatures.map(toBase64), [f.signature]);
    assert.equal(fromBinary(SignDocSchema, directSignBytes(signed.signDoc!)).chainId, f.chain_id);
  });

  test(`${f.name}: the fee contract recomputes the declared fee`, () => {
    const quote = quoteFee({
      tax: f.fee!.tax.map((c) => ({ ...c, $typeName: "cosmos.base.v1beta1.Coin" as const })),
      gasPrice: fromProtoJson(GasPriceSchema, f.fee!.gas_price as never),
      gasLimit: BigInt(f.fee!.gas_limit),
      headroom: { stable: f.fee!.pad_stable, noah: f.fee!.pad_noah },
    });
    assert.equal(quote.required.denom, f.fee!.required.denom);
    assert.equal(quote.required.amount, f.fee!.required.amount, "required gas leg");
    assert.equal(quote.derivedHeight, BigInt(f.fee!.gas_price.derived_height));
    if (overriddenDeclaration.has(f.name)) {
      assert.notDeepEqual(
        quote.declared.map((c) => c.amount + c.denom),
        f.fee!.declared.map((c) => c.amount + c.denom),
        "the override differs from the quote",
      );
      return;
    }
    assert.deepEqual(
      quote.declared.map((c) => c.amount + c.denom),
      f.fee!.declared.map((c) => c.amount + c.denom),
      "declared legs",
    );
  });
}

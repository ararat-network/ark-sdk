import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import { aminoSignDocBytes } from "../codec/aminojson.js";
import { fromHex } from "../codec/bytes.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { SignMode } from "../gen/cosmos/tx/signing/v1beta1/signing_pb.js";
import { AuthInfoSchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { verifyMessage } from "../keys/secp256k1.js";
import { MULTISIG_PUBLIC_KEY_URL, type Signer } from "../keys/signer.js";
import { fixtureKey } from "../testing/fixtures.js";
import { makeFee, typed } from "./body.js";
import { MultisigNeedsAmino, SignerAlteredDocument, signTx, simulationTxBytes } from "./builder.js";

const trader = fixtureKey("trader");
const signer = MemorySigner.fromPrivateKey(fromHex(trader.private_key_hex));
const send = typed(MsgSendSchema, create(MsgSendSchema, { fromAddress: signer.address, toAddress: signer.address, amount: [{ denom: "anoah", amount: "1" }] }));
const base = {
  signer,
  address: signer.address,
  chainId: "localark",
  accountNumber: 3n,
  sequence: 9n,
  messages: [send],
  fee: makeFee({ amount: [{ denom: "anoah", amount: "42" }], gasLimit: 200000n }),
};

test("amino mode signs the amino document and marks the signer info", async () => {
  const signed = await signTx({ ...base, mode: "amino" });
  assert.equal(signed.mode, "amino");
  assert.ok(signed.aminoSignDoc);
  assert.equal(signed.aminoSignDoc.chain_id, "localark");
  assert.equal(signed.aminoSignDoc.msgs[0]?.type, "cosmos-sdk/MsgSend");
  assert.ok(verifyMessage(signed.signature, aminoSignDocBytes(signed.aminoSignDoc), signer.publicKey));
  const authInfo = fromBinary(AuthInfoSchema, signed.authInfoBytes);
  const mode = authInfo.signerInfos[0]?.modeInfo?.sum;
  assert.equal(mode?.case, "single");
  assert.equal(mode?.case === "single" ? mode.value.mode : undefined, SignMode.LEGACY_AMINO_JSON);
});

test("a multisig key is refused in direct mode and not yet signed in amino", async () => {
  const multisig: Signer = {
    accounts: async () => [{ address: signer.address, publicKey: create(AnySchema, { typeUrl: MULTISIG_PUBLIC_KEY_URL, value: new Uint8Array() }) }],
    signDirect: () => Promise.reject(new Error("unreachable")),
    signAmino: () => Promise.reject(new Error("unreachable")),
    signArbitrary: () => Promise.reject(new Error("unreachable")),
  };
  await assert.rejects(signTx({ ...base, signer: multisig }), MultisigNeedsAmino);
  await assert.rejects(signTx({ ...base, signer: multisig, mode: "amino" }), /multisig signing/);
});

test("a signer that alters the document stops the build", async () => {
  const altering: Signer = {
    accounts: () => signer.accounts(),
    signDirect: async (address, doc) => {
      const signed = await signer.signDirect(address, doc);
      return { ...signed, signDoc: { ...doc, chainId: "other" } };
    },
    signAmino: async (address, doc) => {
      const signed = await signer.signAmino(address, doc);
      return { ...signed, signDoc: { ...doc, memo: "changed" } };
    },
    signArbitrary: () => Promise.reject(new Error("unreachable")),
  };
  await assert.rejects(signTx({ ...base, signer: altering }), SignerAlteredDocument);
  await assert.rejects(signTx({ ...base, signer: altering, mode: "amino" }), SignerAlteredDocument);
  await assert.rejects(signTx({ ...base, address: "ark1nobody" }), /no account/);
});

test("a simulation transaction carries the body, signer info, and an empty signature", async () => {
  const [account] = await signer.accounts();
  const bytes = simulationTxBytes({ messages: [send], publicKey: account!.publicKey, sequence: 9n });
  const raw = fromBinary(TxRawSchema, bytes);
  assert.deepEqual(raw.signatures, [new Uint8Array()]);
  const authInfo = fromBinary(AuthInfoSchema, raw.authInfoBytes);
  assert.equal(authInfo.signerInfos[0]?.sequence, 9n);
  assert.equal(authInfo.fee?.gasLimit, 0n);
});

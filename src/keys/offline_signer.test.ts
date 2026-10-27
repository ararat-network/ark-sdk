import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBinary, toBinary } from "@bufbuild/protobuf";

import { adr036SignBytes } from "../adr036/signbytes.js";
import { type AminoSignDoc, aminoSignDocBytes } from "../codec/aminojson.js";
import { fromBase64, fromHex, toBase64, utf8Encode } from "../codec/bytes.js";
import { SignDocSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { fixture, fixtureKey, signupVectors } from "../testing/fixtures.js";
import { MemorySigner } from "./memory_signer.js";
import { fromOfflineSigner, type OfflineDirectSignDoc, type OfflineSignerLike, type OfflineStdSignature } from "./offline_signer.js";
import { publicKeyFromPrivate, signMessage } from "./secp256k1.js";
import { SECP256K1_PUBLIC_KEY_URL, SignerError } from "./signer.js";

/** A wallet shaped like Keplr over a known key, signing the bytes the chain expects. */
function wallet(
  privateKeyHex: string,
  address: string,
): OfflineSignerLike & {
  signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<OfflineStdSignature>;
  /** What signArbitrary was handed, in order. */
  received: (string | Uint8Array)[];
} {
  const priv = fromHex(privateKeyHex);
  const received: (string | Uint8Array)[] = [];
  const pub = publicKeyFromPrivate(priv);
  const std = (bytes: Uint8Array): OfflineStdSignature => ({
    pub_key: { type: "tendermint/PubKeySecp256k1", value: toBase64(pub) },
    signature: toBase64(signMessage(bytes, priv)),
  });
  return {
    getAccounts: async () => [
      { address, algo: "secp256k1", pubkey: pub },
      { address: "ark1ethereum", algo: "ethsecp256k1", pubkey: new Uint8Array(33) },
    ],
    signDirect: async (_address: string, doc: OfflineDirectSignDoc) => {
      const bytes = toBinary(SignDocSchema, {
        $typeName: "cosmos.tx.v1beta1.SignDoc",
        bodyBytes: doc.bodyBytes,
        authInfoBytes: doc.authInfoBytes,
        chainId: doc.chainId,
        accountNumber: BigInt(String(doc.accountNumber)),
      });
      return { signed: { ...doc, accountNumber: String(doc.accountNumber) }, signature: std(bytes) };
    },
    signAmino: async (_address: string, doc: AminoSignDoc) => ({ signed: doc, signature: std(aminoSignDocBytes(doc)) }),
    signArbitrary: async (_chainId: string, signer: string, data: string | Uint8Array) => {
      received.push(data);
      return std(adr036SignBytes(signer, typeof data === "string" ? utf8Encode(data) : data));
    },
    received,
  };
}

test("an OfflineSigner signs direct, amino, and ADR-036 through the Signer interface", async () => {
  const f = fixture("bank_send_taxed");
  const key = fixtureKey(f.signer!.key);
  const w = wallet(key.private_key_hex, key.address);
  const signer = fromOfflineSigner(w, { chainId: f.chain_id, arbitrary: w });

  const accounts = await signer.accounts();
  assert.equal(accounts.length, 1, "the non-secp256k1 account is left out");
  assert.equal(accounts[0]?.address, key.address);
  assert.equal(accounts[0]?.publicKey.typeUrl, SECP256K1_PUBLIC_KEY_URL);

  const signDoc = fromBinary(SignDocSchema, fromBase64(f.sign_mode_direct!.sign_doc));
  const direct = await signer.signDirect(key.address, signDoc);
  assert.equal(toBase64(direct.signature), f.signature, "the fixture's signature through the wallet");
  assert.equal(direct.signDoc.accountNumber, signDoc.accountNumber, "a string account number comes back as bigint");

  const doc = JSON.parse(f.sign_mode_amino!.sign_bytes) as AminoSignDoc;
  const amino = await signer.signAmino(key.address, doc);
  assert.equal(toBase64(amino.signature), toBase64(signMessage(aminoSignDocBytes(doc), fromHex(key.private_key_hex))));

  const member = signupVectors().keys.find((k) => k.name === "member")!;
  const v = signupVectors().vectors.find((x) => x.name === "challenge_ok")!;
  const mw = wallet(member.private_key_hex, member.address);
  const memberSigner = fromOfflineSigner(mw, { chainId: "ark-1", arbitrary: mw });
  const arbitrary = await memberSigner.signArbitrary(member.address, utf8Encode(v.data));
  assert.equal(toBase64(arbitrary.signature), v.signature);
  assert.equal(arbitrary.publicKey.typeUrl, SECP256K1_PUBLIC_KEY_URL);
  assert.deepEqual(await MemorySigner.fromPrivateKey(fromHex(member.private_key_hex)).accounts(), await memberSigner.accounts());
});

test("ADR-036 data reaches the wallet as text when it is UTF-8, so Keplr shows it, and as bytes otherwise", async () => {
  const member = signupVectors().keys.find((k) => k.name === "member")!;
  const v = signupVectors().vectors.find((x) => x.name === "challenge_ok")!;
  const w = wallet(member.private_key_hex, member.address);
  const signer = fromOfflineSigner(w, { chainId: "ark-1", arbitrary: w });

  const document = await signer.signArbitrary(member.address, utf8Encode(v.data));
  assert.equal(w.received[0], v.data, "the document goes as the text itself");
  assert.equal(toBase64(document.signature), v.signature, "and the signature is still the vector's");

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
  await signer.signArbitrary(member.address, bom);
  assert.equal(w.received[1], "\ufeff{}", "a leading byte-order mark is kept, not stripped");

  const raw = new Uint8Array([0xff, 0xfe, 0x01]);
  const opaque = await signer.signArbitrary(member.address, raw);
  assert.deepEqual(w.received[2], raw, "bytes that are not UTF-8 go as bytes");
  assert.equal(toBase64(opaque.signature), toBase64(signMessage(adr036SignBytes(member.address, raw), fromHex(member.private_key_hex))));
});

test("a wallet that returns a sign document without an account number is refused with the reason", async () => {
  const f = fixture("bank_send_taxed");
  const key = fixtureKey(f.signer!.key);
  const w = wallet(key.private_key_hex, key.address);
  const dropping: OfflineSignerLike = {
    getAccounts: w.getAccounts,
    signDirect: async (address, doc) => {
      const { signed, signature } = await w.signDirect!(address, doc);
      return { signed: { ...signed, accountNumber: null }, signature };
    },
  };
  const signDoc = fromBinary(SignDocSchema, fromBase64(f.sign_mode_direct!.sign_doc));
  await assert.rejects(
    fromOfflineSigner(dropping).signDirect(key.address, signDoc),
    (err: unknown) => err instanceof SignerError && /account number/.test(err.message),
  );
});

test("a wallet without a mode or without signArbitrary is refused with the reason", async () => {
  const key = fixtureKey("trader");
  const w = wallet(key.private_key_hex, key.address);
  const aminoOnly: OfflineSignerLike = { getAccounts: w.getAccounts, signAmino: w.signAmino };
  const signer = fromOfflineSigner(aminoOnly);
  const signDoc = fromBinary(SignDocSchema, fromBase64(fixture("bank_send_taxed").sign_mode_direct!.sign_doc));
  await assert.rejects(signer.signDirect(key.address, signDoc), (err: unknown) => err instanceof SignerError && /amino only/.test(err.message));
  await assert.rejects(signer.signArbitrary(key.address, new Uint8Array()), (err: unknown) => err instanceof SignerError && /signArbitrary/.test(err.message));
  const directOnly = fromOfflineSigner({ getAccounts: w.getAccounts, signDirect: w.signDirect });
  await assert.rejects(
    directOnly.signAmino(key.address, { account_number: "0", chain_id: "x", fee: { amount: [], gas: "0" }, memo: "", msgs: [], sequence: "0" }),
    SignerError,
  );
});

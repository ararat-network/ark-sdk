// Producing and checking the ADR-036 proof the signup protocol submits: the
// signer signs the sign bytes for the document, and the platform stores the
// four values of §6. The stateless rules 1 to 4 of §7 are checked here too,
// so an app can refuse a wallet's output before sending it; the platform's
// verifier runs every rule.
import type { Any } from "@bufbuild/protobuf/wkt";

import { unpackAnyAs } from "../codec/any.js";
import { fromBase64, toBase64, utf8Decode } from "../codec/bytes.js";
import { PubKeySchema } from "../gen/cosmos/crypto/secp256k1/keys_pb.js";
import { ADDRESS_LENGTH, decodeAddress, publicKeyToAddress } from "../keys/address.js";
import { PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH, isLowS, verifyMessage } from "../keys/secp256k1.js";
import { SECP256K1_PUBLIC_KEY_URL, SignerError, type Signer } from "../keys/signer.js";
import { documentBytes, parseDocument, type SignupDocument } from "./document.js";
import { adr036SignBytes } from "./signbytes.js";

/** The four values of §6. */
export interface Submission {
  /** The document bytes, verbatim. */
  data: Uint8Array;
  signer: string;
  /** 33 bytes, compressed secp256k1. */
  publicKey: Uint8Array;
  /** 64 bytes, r || s, low S. */
  signature: Uint8Array;
}

/** The submission as the platform's API carries it: data as text, bytes in standard base64. */
export interface SubmissionJson {
  data: string;
  signer: string;
  public_key: string;
  signature: string;
}

export function submissionToJson(s: Submission): SubmissionJson {
  return { data: utf8Decode(s.data), signer: s.signer, public_key: toBase64(s.publicKey), signature: toBase64(s.signature) };
}

export function submissionFromJson(j: SubmissionJson): Submission {
  return { data: new TextEncoder().encode(j.data), signer: j.signer, publicKey: fromBase64(j.public_key), signature: fromBase64(j.signature) };
}

/** The compressed key inside a packed secp256k1 public key. */
export function secp256k1KeyBytes(publicKey: Any): Uint8Array {
  if (publicKey.typeUrl !== SECP256K1_PUBLIC_KEY_URL) throw new SignerError(`ADR-036 needs a simple secp256k1 key, not ${publicKey.typeUrl}`);
  return unpackAnyAs(publicKey, PubKeySchema).key;
}

/** Signs a challenge or vouch document with the signer's key for `address`. */
export async function signDocument(signer: Signer, address: string, document: SignupDocument | Uint8Array): Promise<Submission> {
  const data = document instanceof Uint8Array ? document : documentBytes(document);
  const { signature, publicKey } = await signer.signArbitrary(address, data);
  return { data, signer: address, publicKey: secp256k1KeyBytes(publicKey), signature };
}

/** Rule 3 alone: 64 bytes, low S, verifying over the sign bytes for signer and data. */
export function verifySignature(s: Submission): boolean {
  if (s.signature.length !== SIGNATURE_LENGTH || !isLowS(s.signature)) return false;
  return verifyMessage(s.signature, adr036SignBytes(s.signer, s.data), s.publicKey);
}

export type StatelessRefusal = "signer_invalid" | "key_mismatch" | "signature_invalid" | "data_invalid";

/** Rules 1 to 4 of §7 in order; undefined when all hold. The platform applies the stateful rules after. */
export function checkSubmission(s: Submission, prefix = "ark"): StatelessRefusal | undefined {
  try {
    decodeAddress(s.signer, { prefix, lengths: [ADDRESS_LENGTH] });
  } catch {
    return "signer_invalid";
  }
  if (s.publicKey.length !== PUBLIC_KEY_LENGTH) return "key_mismatch";
  let derived: string;
  try {
    derived = publicKeyToAddress(s.publicKey, prefix);
  } catch {
    return "key_mismatch";
  }
  if (derived !== s.signer) return "key_mismatch";
  if (!verifySignature(s)) return "signature_invalid";
  try {
    parseDocument(s.data);
  } catch {
    return "data_invalid";
  }
  return undefined;
}

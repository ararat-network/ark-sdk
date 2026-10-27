// secp256k1 as the chain uses it: compressed 33-byte public keys, SHA-256 of
// the sign bytes, RFC 6979 deterministic ECDSA with low S, 64-byte r || s
// signatures. Deterministic signing is what lets the fixtures pin signature
// bytes rather than merely valid signatures.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const PRIVATE_KEY_LENGTH = 32;
export const PUBLIC_KEY_LENGTH = 33;
export const SIGNATURE_LENGTH = 64;

/** The curve order, for the low-S check. */
const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

export class KeyError extends Error {
  override readonly name: string = "KeyError";
}

/** The compressed public key of a private scalar. */
export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== PRIVATE_KEY_LENGTH) throw new KeyError(`private key must be ${PRIVATE_KEY_LENGTH} bytes`);
  return secp256k1.getPublicKey(privateKey, true);
}

/** Whether `publicKey` is a valid compressed point. */
export function isCompressedPublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) return false;
  try {
    secp256k1.Point.fromBytes(publicKey);
    return true;
  } catch {
    return false;
  }
}

/** Signs a 32-byte digest: RFC 6979, low S, r || s. */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new KeyError(`digest must be 32 bytes, got ${digest.length}`);
  return secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: "compact" });
}

/** Signs SHA-256 of `message`, which is how every chain signature is made. */
export function signMessage(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return signDigest(sha256(message), privateKey);
}

/** Verifies a 64-byte signature over SHA-256 of `message`; a high-S signature is refused. */
export function verifyMessage(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_LENGTH || !isCompressedPublicKey(publicKey)) return false;
  try {
    return secp256k1.verify(signature, sha256(message), publicKey, { prehash: false, lowS: true, format: "compact" });
  } catch {
    return false;
  }
}

/** Whether a 64-byte signature's S is in the lower half of the curve order. */
export function isLowS(signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_LENGTH) return false;
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(signature[i] as number);
  return s <= CURVE_ORDER >> 1n;
}

/** A fresh random private key, for development signers and tests. */
export function randomPrivateKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

// Ark addresses: Bech32 with the network's prefix over RIPEMD-160 of SHA-256 of
// a compressed secp256k1 key. Canonical means lowercase, which the signup
// protocol and the chain both require.
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";

export const ADDRESS_LENGTH = 20;
export const CONTRACT_ADDRESS_LENGTH = 32;
export const DEFAULT_PREFIX = "ark";

export class AddressError extends Error {
  override readonly name: string = "AddressError";
}

/** The 20-byte account address of a compressed secp256k1 public key. */
export function addressBytes(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 33) throw new AddressError(`public key must be 33 bytes, got ${publicKey.length}`);
  return ripemd160(sha256(publicKey));
}

/** Bech32-encodes address bytes under a prefix. */
export function encodeAddress(bytes: Uint8Array, prefix = DEFAULT_PREFIX): string {
  return bech32.encode(prefix, bech32.toWords(bytes), 90);
}

/** The Bech32 account address of a compressed secp256k1 public key. */
export function publicKeyToAddress(publicKey: Uint8Array, prefix = DEFAULT_PREFIX): string {
  return encodeAddress(addressBytes(publicKey), prefix);
}

export interface DecodedAddress {
  prefix: string;
  bytes: Uint8Array;
}

export interface AddressDecodeOptions {
  /** The prefix the address must carry; any prefix when omitted. */
  prefix?: string;
  /** The payload lengths accepted; 20 and 32 bytes (accounts and contracts) by default. */
  lengths?: readonly number[];
}

/** Decodes a canonical Bech32 address, refusing uppercase, a wrong prefix, or a wrong length. */
export function decodeAddress(address: string, options: AddressDecodeOptions = {}): DecodedAddress {
  if (address !== address.toLowerCase()) throw new AddressError(`address is not lowercase: ${address}`);
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(address as `${string}1${string}`, 90);
  } catch (err) {
    throw new AddressError(`invalid bech32 address ${address}: ${(err as Error).message}`);
  }
  if (options.prefix !== undefined && decoded.prefix !== options.prefix) {
    throw new AddressError(`address ${address} has prefix ${decoded.prefix}, expected ${options.prefix}`);
  }
  const bytes = bech32.fromWords(decoded.words);
  const lengths = options.lengths ?? [ADDRESS_LENGTH, CONTRACT_ADDRESS_LENGTH];
  if (!lengths.includes(bytes.length)) {
    throw new AddressError(`address ${address} has a ${bytes.length}-byte payload, expected ${lengths.join(" or ")}`);
  }
  return { prefix: decoded.prefix, bytes };
}

/** Whether `address` is a canonical account address under `prefix`: lowercase, 20 bytes. */
export function isAccountAddress(address: string, prefix = DEFAULT_PREFIX): boolean {
  try {
    decodeAddress(address, { prefix, lengths: [ADDRESS_LENGTH] });
    return true;
  } catch {
    return false;
  }
}

/** The validator operator prefix of an account prefix. */
export function validatorPrefix(prefix = DEFAULT_PREFIX): string {
  return `${prefix}valoper`;
}

/** Re-encodes an account address as the validator operator address of the same key. */
export function toValidatorAddress(address: string, prefix = DEFAULT_PREFIX): string {
  const { bytes } = decodeAddress(address, { prefix, lengths: [ADDRESS_LENGTH] });
  return encodeAddress(bytes, validatorPrefix(prefix));
}

/** Re-encodes a validator operator address as the account address of the same key. */
export function fromValidatorAddress(address: string, prefix = DEFAULT_PREFIX): string {
  const { bytes } = decodeAddress(address, { prefix: validatorPrefix(prefix), lengths: [ADDRESS_LENGTH] });
  return encodeAddress(bytes, prefix);
}

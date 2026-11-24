// Byte helpers shared across the SDK; standard base64 with padding, as the
// chain's JSON uses, and lowercase hex.
import { base64, hex } from "@scure/base";

export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function fromBase64(s: string): Uint8Array {
  return base64.decode(s);
}

export function toHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

export function fromHex(s: string): Uint8Array {
  return hex.decode(s.toLowerCase());
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Removes every trailing occurrence of one character, without a regular expression. */
export function stripTrailing(s: string, char: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === char) end--;
  return s.slice(0, end);
}

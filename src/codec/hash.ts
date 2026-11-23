// The transaction hash: SHA-256 of the raw bytes, upper hex, as a node
// reports it.
import { sha256 } from "@noble/hashes/sha2.js";

import { toHex } from "./bytes.js";

/** SHA-256 of the raw transaction, uppercase hex, as a node reports it. */
export function txHash(txBytes: Uint8Array): string {
  return toHex(sha256(txBytes)).toUpperCase();
}

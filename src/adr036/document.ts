// The signup challenge and the vouch document (SIGNUP_PROTOCOL.md §4): one
// shape, seven string members in byte order of their names, no whitespace,
// and no character JSON or HTML would escape, so every encoder produces the
// same bytes and the bytes are what is signed and compared.
import { utf8Decode, utf8Encode } from "../codec/bytes.js";

export const SIGNUP_DOMAIN = "ark-signup/v1";
export const VOUCH_DOMAIN = "ark-vouch/v1";
export type Domain = typeof SIGNUP_DOMAIN | typeof VOUCH_DOMAIN;

export interface SignupDocument {
  /** The admission ID, opaque to the signer. */
  admission: string;
  chain_id: string;
  domain: Domain | string;
  /** First second the document is no longer valid, Unix seconds. */
  expires: string;
  /** The second the platform issued it, Unix seconds. */
  issued: string;
  /** 32 random bytes as 64 lowercase hex characters. */
  nonce: string;
  /** The platform's origin: lowercase scheme and host, a port if not the default, no path. */
  origin: string;
}

const MEMBERS = ["admission", "chain_id", "domain", "expires", "issued", "nonce", "origin"] as const;

export class DocumentError extends Error {
  override readonly name: string = "DocumentError";
}

/** Printable ASCII without the characters JSON or HTML encoders escape. */
const SAFE_VALUE = /^[\x20-\x7e]*$/;
const FORBIDDEN = /["\\<>&]/;
const ADMISSION = /^[\x21-\x7e]{1,128}$/;
const UNIX_SECONDS = /^(0|[1-9]\d{0,19})$/;
const NONCE = /^[0-9a-f]{64}$/;
const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9]\d{0,4})?$/;

/** Throws unless the document meets the §4 grammar. */
export function validateDocument(doc: SignupDocument): void {
  for (const member of MEMBERS) {
    const value = doc[member];
    if (typeof value !== "string") throw new DocumentError(`${member} must be a string`);
    if (!SAFE_VALUE.test(value) || FORBIDDEN.test(value)) throw new DocumentError(`${member} contains a character outside the document's alphabet`);
  }
  if (!ADMISSION.test(doc.admission)) throw new DocumentError("admission must be 1 to 128 printable ASCII characters without whitespace");
  if (doc.chain_id === "" || /\s/.test(doc.chain_id)) throw new DocumentError("chain_id must be a chain ID");
  if (doc.domain !== SIGNUP_DOMAIN && doc.domain !== VOUCH_DOMAIN) throw new DocumentError(`domain must be ${SIGNUP_DOMAIN} or ${VOUCH_DOMAIN}`);
  if (!UNIX_SECONDS.test(doc.expires) || !UNIX_SECONDS.test(doc.issued)) throw new DocumentError("issued and expires must be Unix seconds as decimal strings");
  if (BigInt(doc.issued) >= BigInt(doc.expires)) throw new DocumentError("expires must be after issued");
  if (!NONCE.test(doc.nonce)) throw new DocumentError("nonce must be 64 lowercase hex characters");
  if (!ORIGIN.test(doc.origin)) throw new DocumentError("origin must be a lowercase scheme and host with an optional port and no path");
}

/** The canonical bytes: members in name order, no whitespace, nothing escaped. */
export function documentBytes(doc: SignupDocument): Uint8Array {
  validateDocument(doc);
  return utf8Encode("{" + MEMBERS.map((m) => `"${m}":"${doc[m]}"`).join(",") + "}");
}

/** Parses document bytes, refusing anything that does not re-encode to the same bytes (rule 4). */
export function parseDocument(data: Uint8Array): SignupDocument {
  let text: string;
  let parsed: unknown;
  try {
    text = utf8Decode(data);
    parsed = JSON.parse(text);
  } catch {
    throw new DocumentError("data is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DocumentError("data is not a document");
  const keys = Object.keys(parsed);
  if (keys.length !== MEMBERS.length || !MEMBERS.every((m) => keys.includes(m))) throw new DocumentError("data does not have exactly the document's members");
  const doc = parsed as SignupDocument;
  validateDocument(doc);
  if (utf8Decode(documentBytes(doc)) !== text) throw new DocumentError("data is not in canonical encoding");
  return doc;
}

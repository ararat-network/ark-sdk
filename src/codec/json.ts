// JSON the way Go's encoding/json writes it: compact, object keys in byte
// order, and `<`, `>`, `&`, U+2028, U+2029 escaped. Amino sign bytes and the
// ADR-036 sign document are compared byte for byte with the chain's, so the
// serialiser has to match Go, not JSON.stringify.

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Compares two strings by their UTF-8 bytes, which is code point order. */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/** Returns a copy with every object's keys sorted, recursively. */
export function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: JsonObject = {};
    for (const key of Object.keys(value).sort(compareUtf8)) {
      out[key] = sortKeys(value[key] as JsonValue);
    }
    return out;
  }
  return value;
}

/** Serialises as Go's json.Marshal would: compact, keys sorted, Go escaping. */
export function marshalGoJson(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return goJsonString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return goJsonNumber(value);
  }
  if (Array.isArray(value)) return `[${value.map(marshalGoJson).join(",")}]`;
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys.map((k) => `${goJsonString(k)}:${marshalGoJson(value[k] as JsonValue)}`).join(",")}}`;
}

/** Serialises to UTF-8 bytes. */
export function marshalGoJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(marshalGoJson(value));
}

/** Quotes a string with Go's escaping rules (HTML-safe, Go 1.22 short escapes). */
export function goJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f && c !== 0x22 && c !== 0x5c && c !== 0x3c && c !== 0x3e && c !== 0x26) {
      out += s[i];
      continue;
    }
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x3c:
      case 0x3e:
      case 0x26:
      case 0x2028:
      case 0x2029:
        out += `\\u${c.toString(16).padStart(4, "0")}`;
        break;
      default:
        if (c < 0x20) {
          out += `\\u${c.toString(16).padStart(4, "0")}`;
        } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const d = s.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) {
            out += s.slice(i, i + 2);
            i++;
          } else {
            out += "\\ufffd";
          }
        } else if (c >= 0xd800 && c <= 0xdfff) {
          out += "\\ufffd";
        } else {
          out += s[i];
        }
    }
  }
  return `${out}"`;
}

/**
 * Formats a number as Go's float64 marshalling does, which is JavaScript's own
 * formatting: shortest round-trip digits, an exponent below 1e-6 and from
 * 1e21, and no leading zero in a negative exponent, since encoding/json
 * rewrites strconv's e-07 as e-7.
 */
export function goJsonNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`json: unsupported value ${n}`);
  return String(n);
}

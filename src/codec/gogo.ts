// What gogoproto writes that protobuf-es would not: a field marked
// nullable = false is a value in Go, so the chain always serialises it, even
// empty. A message built here must do the same for its bytes, and so its sign
// document and hash, to match the chain's. The pass fills unset non-nullable
// message fields with empty messages and unset non-nullable Dec and Int
// fields with zero, recursively, leaving everything else alone. A
// non-nullable Timestamp is Go's zero time, year 1, not the epoch. The same
// pass refuses an Int or a Dec whose text is not what the chain writes, since
// the chain would read it as another number than its digits say.
import { type DescField, type DescMessage, type MessageShape, ScalarType } from "@bufbuild/protobuf";
import { type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";

import { utf8Decode, utf8Encode } from "./bytes.js";
import { CoinError } from "./coins.js";
import { DecError } from "./dec.js";
import { CANONICAL_INTEGER_TEXT } from "./fixed.js";
import { fieldOptions, MATH_INT } from "./options.js";
import { GO_ZERO_TIME_SECONDS } from "./wkt.js";

/** Returns the message with gogoproto's non-nullable fields present, as the chain would encode it. */
export function materialise<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): MessageShape<Desc> {
  const r = reflect(schema, message);
  materialiseReflect(r);
  return r.message as MessageShape<Desc>;
}

/**
 * Refuses an Int's or a Dec's text that the chain would not have written. The chain reads such text with the base
 * taken from it, so "0100" would be signed here as one hundred and executed there as sixty-four.
 */
function refuseUnwrittenText(f: DescField, value: unknown, dec: boolean): void {
  const text = value instanceof Uint8Array ? utf8Decode(value) : String(value);
  if (CANONICAL_INTEGER_TEXT.test(text)) return;
  const what = `${f.parent.typeName}.${f.name}: ${JSON.stringify(text)} is not an integer in decimal digits with no leading zero`;
  throw dec ? new DecError(`${what}; a Dec field holds its scaled integer, as LegacyDec.toWire gives it`) : new CoinError(what);
}

function materialiseReflect(r: ReflectMessage): void {
  if (r.desc.typeName === "google.protobuf.Any") return;
  for (const f of r.fields) {
    const o = fieldOptions(f);
    switch (f.fieldKind) {
      case "message":
        if (r.isSet(f)) {
          materialiseReflect(r.get(f));
        } else if (!o.nullable && !f.oneof) {
          const empty = reflect(f.message);
          const seconds = f.message.fields.find((t) => t.name === "seconds");
          if (f.message.typeName === "google.protobuf.Timestamp" && seconds) empty.set(seconds, GO_ZERO_TIME_SECONDS);
          materialiseReflect(empty);
          r.set(f, empty);
        }
        break;
      case "list":
        if (f.listKind === "message") for (const item of r.get(f)) materialiseReflect(item as ReflectMessage);
        break;
      case "map":
        if (f.mapKind === "message") for (const [, item] of r.get(f)) materialiseReflect(item as ReflectMessage);
        break;
      case "scalar":
        if (!r.isSet(f) && !o.nullable && (o.isLegacyDec || o.isMathInt) && !f.oneof) {
          r.set(f, f.scalar === ScalarType.BYTES ? utf8Encode("0") : "0");
        } else if (r.isSet(f) && (o.isLegacyDec || o.customtype === MATH_INT)) {
          refuseUnwrittenText(f, r.get(f), o.isLegacyDec);
        }
        break;
    }
  }
}

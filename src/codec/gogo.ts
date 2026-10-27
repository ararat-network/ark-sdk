// What gogoproto writes that protobuf-es would not: a field marked
// nullable = false is a value in Go, so the chain always serialises it, even
// empty. A message built here must do the same for its bytes, and so its sign
// document and hash, to match the chain's. The pass fills unset non-nullable
// message fields with empty messages and unset non-nullable Dec and Int
// fields with zero, recursively, leaving everything else alone. A
// non-nullable Timestamp is Go's zero time, year 1, not the epoch.
import { ScalarType, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";

import { utf8Encode } from "./bytes.js";
import { fieldOptions } from "./options.js";
import { GO_ZERO_TIME_SECONDS } from "./wkt.js";

/** Returns the message with gogoproto's non-nullable fields present, as the chain would encode it. */
export function materialise<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): MessageShape<Desc> {
  const r = reflect(schema, message);
  materialiseReflect(r);
  return r.message as MessageShape<Desc>;
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
          if (f.message.typeName === "google.protobuf.Timestamp") {
            empty.set(f.message.fields.find((t) => t.name === "seconds")!, GO_ZERO_TIME_SECONDS);
          }
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
        }
        break;
    }
  }
}

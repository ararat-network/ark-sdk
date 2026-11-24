// Proto JSON as the chain writes it: gogoproto's jsonpb with EmitDefaults and
// OrigName, the form the gRPC gateway returns and the decoding fixtures pin.
// It differs from proto3 JSON where Go's types show through: an unset
// pointer field is null, a non-nullable one is always present, Decs read as
// decimals, and a wasm message's JSON is inlined. The reverse direction reads
// the same dialect back into generated messages.
import {
  create,
  type DescEnum,
  type DescField,
  type DescMessage,
  fromBinary,
  type MessageShape,
  type Registry,
  ScalarType,
  toBinary,
} from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMap, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { type Any, AnySchema, type Duration, DurationSchema, type Timestamp, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { ArkSdkError, errorMessage } from "../errors.js";
import { anyFromUnknownJson, typeNameOf, typeUrlOf, UnknownTypeError, unknownAnyJson, type WithRegistry } from "./any.js";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.js";
import { intFromWire } from "./coins.js";
import { LegacyDec } from "./dec.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { fieldOptions } from "./options.js";
import { durationFromText, durationToProtoJson, GO_ZERO_TIME_SECONDS, timestampFromText, timestampToProtoJson } from "./wkt.js";

export class ProtoJsonError extends ArkSdkError {
  override readonly name: string = "ProtoJsonError";
}

export interface ToProtoJsonOptions extends WithRegistry {
  /** What to do with an Any whose type the registry lacks: fail, or emit {"@type", "value": base64}. */
  unknownAny?: "throw" | "raw";
}

export interface FromProtoJsonOptions extends WithRegistry {
  /** Skip members no field matches; the default, so a newer chain's extra fields do not break a reader. */
  ignoreUnknownFields?: boolean;
  /**
   * What to do with an Any whose type the registry lacks. `throw`, the default, fails: JSON has no bytes for it, and a
   * message built from JSON must not carry a hollow one. `keep` is for reading what a node returned: the Any keeps its
   * type URL, an empty value, and the JSON it arrived as, which `unknownAnyJson` returns. A known Any that holds one,
   * at any depth, is kept the same way, whole: its bytes would carry the inner message's type with none of its content.
   */
  unknownAny?: "throw" | "keep";
  /**
   * What to do with an enum value given by a name the schema lacks, as a newer chain sends. `throw`, the default,
   * fails: a message built from JSON must not carry another value than was written. `keep` is for reading what a node
   * returned: the field is left at its zero value, the name it arrived as is held beside the message for
   * `unknownEnumNames`, and an Any around it is kept as its JSON, since its bytes would carry the zero value.
   */
  unknownEnum?: "throw" | "keep";
}

// The enum names a message was read with that its schema lacks, by field name: the JSON each such field arrived as.
// Held beside the message, by identity, as the JSON of an unknown Any is.
const heldEnumNames = new WeakMap<object, Record<string, JsonValue>>();

/**
 * The enum names a message read from a node carried that the schema does not know, by the field's proto name: for
 * each, the JSON the field arrived as. The fields themselves hold the zero value. Undefined for a message that
 * carried none.
 */
export function unknownEnumNames(message: object): Readonly<Record<string, JsonValue>> | undefined {
  return heldEnumNames.get(message);
}

interface WriteContext {
  registry: Registry;
  unknownAny: "throw" | "raw";
}

interface ReadContext {
  registry: Registry;
  ignoreUnknownFields: boolean;
  unknownAny: "throw" | "keep";
  unknownEnum: "throw" | "keep";
  /**
   * How many things this read has kept as JSON so far, an unknown Any or an enum name: what tells an Any being read
   * that something inside it could not be turned into bytes.
   */
  kept: number;
}

const WKT_TIMESTAMP = "google.protobuf.Timestamp";
const WKT_DURATION = "google.protobuf.Duration";
const WKT_ANY = "google.protobuf.Any";

/** Renders a message in the chain's JSON dialect. */
export function toProtoJson<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, options: ToProtoJsonOptions): JsonValue {
  const ctx: WriteContext = { registry: options.registry, unknownAny: options.unknownAny ?? "throw" };
  return messageToJson(reflect(schema, message), ctx);
}

/** Reads a message from the chain's JSON dialect. */
export function fromProtoJson<Desc extends DescMessage>(schema: Desc, json: JsonValue, options: FromProtoJsonOptions): MessageShape<Desc> {
  const ctx: ReadContext = {
    registry: options.registry,
    ignoreUnknownFields: options.ignoreUnknownFields ?? true,
    unknownAny: options.unknownAny ?? "throw",
    unknownEnum: options.unknownEnum ?? "throw",
    kept: 0,
  };
  return messageFromJson(schema, json, ctx).message as MessageShape<Desc>;
}

function messageToJson(r: ReflectMessage, ctx: WriteContext): JsonValue {
  switch (r.desc.typeName) {
    case WKT_TIMESTAMP:
      return timestampToProtoJson(r.message as Timestamp);
    case WKT_DURATION:
      return durationToProtoJson(r.message as Duration);
    case WKT_ANY:
      return anyToJson(r.message as Any, ctx);
  }
  const out: JsonObject = {};
  for (const f of r.fields) {
    if (f.oneof && r.oneofCase(f.oneof) !== f) continue;
    out[f.name] = fieldToJson(r, f, ctx);
  }
  return out;
}

function anyToJson(any: Any, ctx: WriteContext): JsonValue {
  if (any.typeUrl === "") return {};
  // An Any read without its type has no bytes; the JSON it arrived as is its only rendering.
  const held = unknownAnyJson(any);
  if (held) return held;
  const schema = ctx.registry.getMessage(typeNameOf(any.typeUrl));
  if (!schema) {
    if (ctx.unknownAny === "raw") return { "@type": any.typeUrl, value: toBase64(any.value) };
    throw new UnknownTypeError(any.typeUrl);
  }
  return anyJson(any.typeUrl, messageToJson(reflect(schema, fromBinary(schema, any.value)), ctx));
}

/**
 * A message's JSON as an Any carries it: its members beside "@type", or under "value" for a message that renders as
 * a scalar. Shared with the decoder, which already holds the decoded message; not re-exported from the index.
 */
export function anyJson(typeUrl: string, value: JsonValue): JsonObject {
  return isJsonObject(value) ? { "@type": typeUrl, ...value } : { "@type": typeUrl, value };
}

function fieldToJson(r: ReflectMessage, f: DescField, ctx: WriteContext): JsonValue {
  switch (f.fieldKind) {
    case "list":
      return listToJson(r.get(f), f, ctx);
    case "map":
      return mapToJson(r.get(f), f, ctx);
    case "message":
      if (!r.isSet(f)) {
        if (fieldOptions(f).nullable) return null;
        // A non-nullable Timestamp is Go's zero time, year 1, as gogo renders it.
        if (f.message.typeName === WKT_TIMESTAMP) return timestampToProtoJson(create(TimestampSchema, { seconds: GO_ZERO_TIME_SECONDS }));
        return messageToJson(reflect(f.message), ctx);
      }
      return messageToJson(r.get(f), ctx);
    case "enum":
      return enumToJson(f.enum, r.get(f));
    case "scalar":
      return scalarFieldToJson(r, f);
  }
}

function listToJson(list: ReflectList, f: DescField & { fieldKind: "list" }, ctx: WriteContext): JsonValue {
  const out: JsonValue[] = [];
  for (const item of list) {
    switch (f.listKind) {
      case "message":
        out.push(messageToJson(item as ReflectMessage, ctx));
        break;
      case "enum":
        out.push(enumToJson(f.enum, item as number));
        break;
      case "scalar":
        out.push(scalarToJson(f.scalar, item, f.longAsString));
    }
  }
  return out;
}

function mapToJson(map: ReflectMap, f: DescField & { fieldKind: "map" }, ctx: WriteContext): JsonValue {
  const out: JsonObject = {};
  for (const [key, value] of map) {
    const k = typeof key === "boolean" || typeof key === "bigint" || typeof key === "number" ? String(key) : (key as string);
    switch (f.mapKind) {
      case "message":
        out[k] = messageToJson(value as ReflectMessage, ctx);
        break;
      case "enum":
        out[k] = enumToJson(f.enum, value as number);
        break;
      case "scalar":
        out[k] = scalarToJson(f.scalar, value, false);
    }
  }
  return out;
}

/**
 * Enums whose Go type renders custom names through jsonpb rather than the
 * proto value names. wasmd's AccessType is the one the chain carries.
 */
const CUSTOM_ENUM_NAMES: Record<string, Record<number, string>> = {
  "cosmwasm.wasm.v1.AccessType": { 0: "Unspecified", 1: "Nobody", 2: "Unspecified", 3: "Everybody", 4: "AnyOfAddresses" },
};

function enumToJson(e: DescEnum, n: number): JsonValue {
  const custom = CUSTOM_ENUM_NAMES[e.typeName]?.[n];
  if (custom !== undefined) return custom;
  return e.values.find((v) => v.number === n)?.name ?? n;
}

function scalarFieldToJson(r: ReflectMessage, f: DescField & { fieldKind: "scalar" }): JsonValue {
  const o = fieldOptions(f);
  const set = r.isSet(f);
  const v = r.get(f);
  // A Dec or Int travels as decimal text, in a string field or as the bytes of one.
  if (o.isLegacyDec) {
    // gogo writes a Dec that never reached the wire as "0", not at 18 places.
    if (!set) return o.nullable ? null : "0";
    return LegacyDec.fromWire(numericText(v)).toString();
  }
  if (o.customtype !== undefined && o.isMathInt) {
    if (!set) return o.nullable ? null : "0";
    // The integer the chain reads from the text, which is not always the text's decimal value: "0100" is 64.
    return intFromWire(numericText(v)).toString();
  }
  if (o.isInlineJson) {
    if (!set) return null;
    try {
      return JSON.parse(utf8Decode(v as Uint8Array)) as JsonValue;
    } catch (err) {
      throw new ProtoJsonError(`${f.parent.typeName}.${f.name}: its bytes are not JSON: ${errorMessage(err)}`, { cause: err });
    }
  }
  return scalarToJson(f.scalar, v, f.longAsString);
}

function numericText(v: unknown): string {
  return v instanceof Uint8Array ? utf8Decode(v) : (v as string);
}

function scalarToJson(type: ScalarType, v: unknown, longAsString: boolean): JsonValue {
  switch (type) {
    case ScalarType.STRING:
      return v as string;
    case ScalarType.BOOL:
      return v as boolean;
    case ScalarType.BYTES:
      return toBase64(v as Uint8Array);
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return longAsString ? (v as string) : (v as bigint).toString();
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE: {
      const n = v as number;
      if (Number.isNaN(n)) return "NaN";
      if (n === Number.POSITIVE_INFINITY) return "Infinity";
      if (n === Number.NEGATIVE_INFINITY) return "-Infinity";
      return n;
    }
    default:
      return v as number;
  }
}

const fieldIndex = new WeakMap<DescMessage, Map<string, DescField>>();

function fieldByJsonKey(desc: DescMessage, key: string): DescField | undefined {
  let index = fieldIndex.get(desc);
  if (!index) {
    index = new Map();
    for (const f of desc.fields) {
      index.set(f.name, f);
      index.set(f.jsonName, f);
    }
    fieldIndex.set(desc, index);
  }
  return index.get(key);
}

function messageFromJson(desc: DescMessage, json: JsonValue, ctx: ReadContext): ReflectMessage {
  switch (desc.typeName) {
    case WKT_TIMESTAMP:
      if (typeof json !== "string") throw new ProtoJsonError(`${desc.typeName}: expected a string`);
      return reflect(TimestampSchema, timestampFromText(json));
    case WKT_DURATION:
      if (typeof json !== "string") throw new ProtoJsonError(`${desc.typeName}: expected a string`);
      return reflect(DurationSchema, durationFromText(json));
    case WKT_ANY:
      return reflect(AnySchema, anyFromJson(json, ctx));
  }
  if (!isJsonObject(json)) throw new ProtoJsonError(`${desc.typeName}: expected an object`);
  const r = reflect(desc);
  for (const [key, value] of Object.entries(json)) {
    const f = fieldByJsonKey(desc, key);
    if (!f) {
      if (ctx.ignoreUnknownFields) continue;
      throw new ProtoJsonError(`${desc.typeName}: unknown field ${key}`);
    }
    if (value === null) continue;
    setFieldFromJson(r, f, value, ctx);
  }
  return r;
}

function anyFromJson(json: JsonValue, ctx: ReadContext): Any {
  if (!isJsonObject(json)) throw new ProtoJsonError("Any: expected an object");
  const { "@type": typeUrl, ...rest } = json;
  if (typeof typeUrl !== "string") {
    if (Object.keys(json).length === 0) return create(AnySchema);
    throw new ProtoJsonError("Any: missing @type");
  }
  const schema = ctx.registry.getMessage(typeNameOf(typeUrl));
  if (!schema) {
    if (ctx.unknownAny !== "keep") throw new UnknownTypeError(typeUrl);
    ctx.kept++;
    return anyFromUnknownJson(typeUrl, json);
  }
  const wkt = schema.typeName === WKT_TIMESTAMP || schema.typeName === WKT_DURATION || schema.typeName === WKT_ANY;
  const keptBefore = ctx.kept;
  const inner = messageFromJson(schema, wkt ? (rest.value as JsonValue) : rest, ctx);
  // A message that holds a kept Any cannot be turned into bytes either: the inner one has none, and bytes written
  // around it would name its type with no content. It is kept the same way, whole, and the count already tells the
  // Any around this one.
  if (ctx.kept > keptBefore) return anyFromUnknownJson(typeUrl, json);
  return create(AnySchema, { typeUrl: typeUrlOf(schema), value: toBinary(schema, inner.message) });
}

function setFieldFromJson(r: ReflectMessage, f: DescField, json: JsonValue, ctx: ReadContext): void {
  switch (f.fieldKind) {
    case "list": {
      if (!Array.isArray(json)) throw new ProtoJsonError(`${f.parent.typeName}.${f.name}: expected an array`);
      const list = r.get(f);
      for (const item of json) {
        if (item === null) throw new ProtoJsonError(`${f.parent.typeName}.${f.name}: list item must not be null`);
        switch (f.listKind) {
          case "message":
            list.add(messageFromJson(f.message, item, ctx));
            break;
          case "enum":
            list.add(enumFromJson(r, f, f.enum, item, json, ctx) ?? 0);
            break;
          case "scalar":
            list.add(scalarFromJson(f.scalar, item, f.longAsString, f));
        }
      }
      return;
    }
    case "map": {
      if (!isJsonObject(json)) throw new ProtoJsonError(`${f.parent.typeName}.${f.name}: expected an object`);
      const map = r.get(f);
      for (const [k, item] of Object.entries(json)) {
        const key = mapKeyFromJson(f.mapKey, k);
        switch (f.mapKind) {
          case "message":
            map.set(key, messageFromJson(f.message, item, ctx));
            break;
          case "enum":
            map.set(key, enumFromJson(r, f, f.enum, item, json, ctx) ?? 0);
            break;
          case "scalar":
            map.set(key, scalarFromJson(f.scalar, item, false, f));
        }
      }
      return;
    }
    case "message":
      r.set(f, messageFromJson(f.message, json, ctx));
      return;
    case "enum": {
      const value = enumFromJson(r, f, f.enum, json, json, ctx);
      if (value !== undefined) r.set(f, value);
      return;
    }
    case "scalar":
      r.set(f, scalarFromJson(f.scalar, json, f.longAsString, f));
  }
}

/**
 * An enum value from its name or its number. A name the schema lacks is refused, or, when the read keeps what it
 * cannot place, answered with undefined after the field's JSON is held beside the message.
 */
function enumFromJson(r: ReflectMessage, f: DescField, e: DescEnum, json: JsonValue, fieldJson: JsonValue, ctx: ReadContext): number | undefined {
  if (typeof json === "number" && Number.isInteger(json)) return json;
  if (typeof json === "string") {
    const value = e.values.find((v) => v.name === json);
    if (value) return value.number;
    const custom = Object.entries(CUSTOM_ENUM_NAMES[e.typeName] ?? {}).find(([, name]) => name === json);
    if (custom) return Number(custom[0]);
    if (ctx.unknownEnum === "keep") {
      heldEnumNames.set(r.message, { ...heldEnumNames.get(r.message), [f.name]: fieldJson });
      ctx.kept++;
      return undefined;
    }
  }
  throw new ProtoJsonError(`${e.typeName}: unknown value ${JSON.stringify(json)}`);
}

/** An integer from JSON: a number that is one, or its decimal digits as text. Anything else is refused by name, never passed to BigInt to throw the runtime's error. */
function integerFromJson(json: JsonValue, where: string, min: bigint, max: bigint): bigint {
  let value: bigint | undefined;
  if (typeof json === "number" && Number.isInteger(json)) value = BigInt(json);
  else if (typeof json === "string" && /^-?\d+$/.test(json)) value = BigInt(json);
  if (value === undefined) throw new ProtoJsonError(`${where}: expected an integer, got ${JSON.stringify(json)}`);
  if (value < min || value > max) throw new ProtoJsonError(`${where}: ${value} is out of range`);
  return value;
}

/** The range of an integer scalar type. */
function integerRange(type: ScalarType): [bigint, bigint] {
  switch (type) {
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return [0n, 2n ** 64n - 1n];
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return [-(2n ** 63n), 2n ** 63n - 1n];
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return [0n, 2n ** 32n - 1n];
    default:
      return [-(2n ** 31n), 2n ** 31n - 1n];
  }
}

function mapKeyFromJson(type: ScalarType, key: string): unknown {
  switch (type) {
    case ScalarType.STRING:
      return key;
    case ScalarType.BOOL:
      return key === "true";
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return integerFromJson(key, "map key", ...integerRange(type));
    default:
      return Number(integerFromJson(key, "map key", ...integerRange(type)));
  }
}

function scalarFromJson(type: ScalarType, json: JsonValue, longAsString: boolean, f: DescField): unknown {
  const where = `${f.parent.typeName}.${f.name}`;
  const o = fieldOptions(f);
  if (o.isLegacyDec) {
    if (typeof json !== "string") throw new ProtoJsonError(`${where}: expected a decimal string`);
    const wire = LegacyDec.fromString(json).toWire();
    return type === ScalarType.BYTES ? utf8Encode(wire) : wire;
  }
  if (o.customtype !== undefined && o.isMathInt && (type === ScalarType.BYTES || type === ScalarType.STRING)) {
    if (typeof json !== "string") throw new ProtoJsonError(`${where}: expected an integer string`);
    // The chain reads an Int's JSON text as it reads the wire's, the base taken from the text, and holds the
    // integer; a message built from this JSON carries that integer's own text.
    const text = intFromWire(json).toString();
    return type === ScalarType.BYTES ? utf8Encode(text) : text;
  }
  if (o.isInlineJson) return utf8Encode(JSON.stringify(json));
  switch (type) {
    case ScalarType.STRING:
      if (typeof json !== "string") throw new ProtoJsonError(`${where}: expected a string`);
      return json;
    case ScalarType.BOOL:
      if (typeof json !== "boolean") throw new ProtoJsonError(`${where}: expected a boolean`);
      return json;
    case ScalarType.BYTES:
      if (typeof json !== "string") throw new ProtoJsonError(`${where}: expected base64`);
      try {
        return fromBase64(json);
      } catch (err) {
        throw new ProtoJsonError(`${where}: ${errorMessage(err)}`, { cause: err });
      }
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64: {
      const big = integerFromJson(json, where, ...integerRange(type));
      return longAsString ? big.toString() : big;
    }
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE:
      if (json === "NaN") return Number.NaN;
      if (json === "Infinity") return Number.POSITIVE_INFINITY;
      if (json === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (typeof json === "number") return json;
      if (typeof json !== "string" || json.trim() === "" || Number.isNaN(Number(json)))
        throw new ProtoJsonError(`${where}: expected a number, got ${JSON.stringify(json)}`);
      return Number(json);
    default:
      return Number(integerFromJson(json, where, ...integerRange(type)));
  }
}

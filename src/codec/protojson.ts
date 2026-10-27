// Proto JSON as the chain writes it: gogoproto's jsonpb with EmitDefaults and
// OrigName, the form the gRPC gateway returns and the decoding fixtures pin.
// It differs from proto3 JSON where Go's types show through: an unset
// pointer field is null, a non-nullable one is always present, Decs read as
// decimals, and a wasm message's JSON is inlined. The reverse direction reads
// the same dialect back into generated messages.
import { type DescEnum, type DescField, type DescMessage, type MessageShape, type Registry, ScalarType } from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMap, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { type Any, AnySchema, type Duration, DurationSchema, type Timestamp, TimestampSchema } from "@bufbuild/protobuf/wkt";

import { typeNameOf, typeUrlOf, UnknownTypeError } from "./any.js";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.js";
import { LegacyDec } from "./dec.js";
import type { JsonObject, JsonValue } from "./json.js";
import { fieldOptions } from "./options.js";
import { registry as defaultRegistry } from "./registry.js";
import { durationFromText, durationToProtoJson, GO_ZERO_TIME_SECONDS, timestampFromText, timestampToProtoJson } from "./wkt.js";

export class ProtoJsonError extends Error {
  override readonly name: string = "ProtoJsonError";
}

export interface ToProtoJsonOptions {
  registry?: Registry;
  /** What to do with an Any whose type the registry lacks: fail, or emit {"@type", "value": base64}. */
  unknownAny?: "throw" | "raw";
}

export interface FromProtoJsonOptions {
  registry?: Registry;
  /** Skip members no field matches; the default, so a newer chain's extra fields do not break a reader. */
  ignoreUnknownFields?: boolean;
}

interface WriteContext {
  registry: Registry;
  unknownAny: "throw" | "raw";
}

interface ReadContext {
  registry: Registry;
  ignoreUnknownFields: boolean;
}

const WKT_TIMESTAMP = "google.protobuf.Timestamp";
const WKT_DURATION = "google.protobuf.Duration";
const WKT_ANY = "google.protobuf.Any";

/** Renders a message in the chain's JSON dialect. */
export function toProtoJson<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, options: ToProtoJsonOptions = {}): JsonValue {
  const ctx: WriteContext = { registry: options.registry ?? defaultRegistry, unknownAny: options.unknownAny ?? "throw" };
  return messageToJson(reflect(schema, message), ctx);
}

/** Reads a message from the chain's JSON dialect. */
export function fromProtoJson<Desc extends DescMessage>(schema: Desc, json: JsonValue, options: FromProtoJsonOptions = {}): MessageShape<Desc> {
  const ctx: ReadContext = { registry: options.registry ?? defaultRegistry, ignoreUnknownFields: options.ignoreUnknownFields ?? true };
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
  const schema = ctx.registry.getMessage(typeNameOf(any.typeUrl));
  if (!schema) {
    if (ctx.unknownAny === "raw") return { "@type": any.typeUrl, value: toBase64(any.value) };
    throw new UnknownTypeError(any.typeUrl);
  }
  const inner = reflect(schema);
  const value = messageToJson(reflect(schema, fromBinaryInto(schema, any.value)), ctx);
  void inner;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { "@type": any.typeUrl, value };
  return { "@type": any.typeUrl, ...value };
}

function fromBinaryInto<Desc extends DescMessage>(schema: Desc, bytes: Uint8Array): MessageShape<Desc> {
  // Imported lazily through reflect's companion to keep this module's dependencies narrow.
  return fromBinaryImpl(schema, bytes);
}

import { create, fromBinary as fromBinaryImpl } from "@bufbuild/protobuf";

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
    if (!set) return o.nullable ? null : LegacyDec.zero().toString();
    return LegacyDec.fromWire(numericText(v)).toString();
  }
  if (o.customtype !== undefined && o.isMathInt) {
    if (!set) return o.nullable ? null : "0";
    return numericText(v);
  }
  if (o.isInlineJson) {
    if (!set) return null;
    return JSON.parse(utf8Decode(v as Uint8Array)) as JsonValue;
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
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new ProtoJsonError(`${desc.typeName}: expected an object`);
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
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new ProtoJsonError("Any: expected an object");
  const { "@type": typeUrl, ...rest } = json;
  if (typeof typeUrl !== "string") {
    if (Object.keys(json).length === 0) return create(AnySchema);
    throw new ProtoJsonError("Any: missing @type");
  }
  const schema = ctx.registry.getMessage(typeNameOf(typeUrl));
  if (!schema) throw new UnknownTypeError(typeUrl);
  const wkt = schema.typeName === WKT_TIMESTAMP || schema.typeName === WKT_DURATION || schema.typeName === WKT_ANY;
  const inner = messageFromJson(schema, wkt ? (rest.value as JsonValue) : rest, ctx);
  return create(AnySchema, { typeUrl: typeUrlOf(schema), value: toBinaryImpl(schema, inner.message) });
}

import { toBinary as toBinaryImpl } from "@bufbuild/protobuf";

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
            list.add(enumFromJson(f.enum, item));
            break;
          case "scalar":
            list.add(scalarFromJson(f.scalar, item, f.longAsString, f));
        }
      }
      return;
    }
    case "map": {
      if (json === null || typeof json !== "object" || Array.isArray(json)) throw new ProtoJsonError(`${f.parent.typeName}.${f.name}: expected an object`);
      const map = r.get(f);
      for (const [k, item] of Object.entries(json)) {
        const key = mapKeyFromJson(f.mapKey, k);
        switch (f.mapKind) {
          case "message":
            map.set(key, messageFromJson(f.message, item, ctx));
            break;
          case "enum":
            map.set(key, enumFromJson(f.enum, item));
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
    case "enum":
      r.set(f, enumFromJson(f.enum, json));
      return;
    case "scalar":
      r.set(f, scalarFromJson(f.scalar, json, f.longAsString, f));
  }
}

function enumFromJson(e: DescEnum, json: JsonValue): number {
  if (typeof json === "number") return json;
  if (typeof json === "string") {
    const value = e.values.find((v) => v.name === json);
    if (value) return value.number;
    const custom = Object.entries(CUSTOM_ENUM_NAMES[e.typeName] ?? {}).find(([, name]) => name === json);
    if (custom) return Number(custom[0]);
  }
  throw new ProtoJsonError(`${e.typeName}: unknown value ${JSON.stringify(json)}`);
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
      return BigInt(key);
    default:
      return Number(key);
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
  if (o.customtype !== undefined && o.isMathInt && type === ScalarType.BYTES) {
    if (typeof json !== "string") throw new ProtoJsonError(`${where}: expected an integer string`);
    return utf8Encode(json);
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
      return fromBase64(json);
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64: {
      if (typeof json !== "string" && typeof json !== "number") throw new ProtoJsonError(`${where}: expected an integer`);
      const big = BigInt(json);
      return longAsString ? big.toString() : big;
    }
    case ScalarType.FLOAT:
    case ScalarType.DOUBLE:
      if (json === "NaN") return Number.NaN;
      if (json === "Infinity") return Number.POSITIVE_INFINITY;
      if (json === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (typeof json !== "number" && typeof json !== "string") throw new ProtoJsonError(`${where}: expected a number`);
      return Number(json);
    default:
      if (typeof json !== "number" && typeof json !== "string") throw new ProtoJsonError(`${where}: expected an integer`);
      return Number(json);
  }
}

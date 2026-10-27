// Legacy amino JSON, the sign mode a Ledger signs in. The encoder follows the
// chain's x/tx aminojson rules: fields sorted by amino name, empty fields
// omitted unless amino.dont_omitempty, enums as integers, Decs and Ints as
// decimal text, Any as {"type", "value"} under its amino name, Timestamps in
// RFC 3339, Durations as nanoseconds, coins never null, wasm JSON inlined,
// public keys as their bare key. The bytes are Go's compact sorted JSON.
import { fromBinary, type DescField, type DescMessage, type MessageShape, type Registry, ScalarType } from "@bufbuild/protobuf";
import { reflect, type ReflectList, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { type Any, type Duration, type Timestamp } from "@bufbuild/protobuf/wkt";

import { UnknownTypeError, typeNameOf, typeUrlOf } from "./any.js";
import { toBase64, utf8Decode } from "./bytes.js";
import { LegacyDec } from "./dec.js";
import { compareUtf8, marshalGoJsonBytes, sortKeys, type JsonObject, type JsonValue } from "./json.js";
import { ENCODING_INLINE_JSON, ENCODING_LEGACY_COINS, ENCODING_NULL_SLICE_AS_EMPTY, LEGACY_DEC, SCALAR_DEC, SCALAR_INT, fieldOptions, messageOptions } from "./options.js";
import { registry as defaultRegistry } from "./registry.js";
import { durationToAmino, timestampToAmino } from "./wkt.js";
import { CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import type { Fee, TxBody } from "../gen/cosmos/tx/v1beta1/tx_pb.js";

export interface AminoCoin {
  denom: string;
  amount: string;
}

export interface AminoMsg {
  type: string;
  value: JsonValue;
}

/** The StdSignDoc a Ledger displays and signs. Optional members are omitted when zero. */
export interface AminoSignDoc {
  account_number: string;
  chain_id: string;
  fee: { amount: AminoCoin[]; gas: string; payer?: string; granter?: string };
  memo: string;
  msgs: AminoMsg[];
  sequence: string;
  timeout_height?: string;
  unordered?: boolean;
  timeout_timestamp?: string;
}

export class AminoError extends Error {
  override readonly name: string = "AminoError";
}

export interface AminoOptions {
  registry?: Registry;
}

export interface AminoSignDocInput {
  body: TxBody;
  fee: Fee;
  chainId: string;
  accountNumber: bigint;
  sequence: bigint;
}

/** The amino sign document of a transaction, as the chain's handler builds it. */
export function makeAminoSignDoc(input: AminoSignDocInput, options: AminoOptions = {}): AminoSignDoc {
  const { body, fee } = input;
  if (body.extensionOptions.length > 0 || body.nonCriticalExtensionOptions.length > 0) {
    throw new AminoError("SIGN_MODE_LEGACY_AMINO_JSON does not support protobuf extension options");
  }
  const ctx = { registry: options.registry ?? defaultRegistry };
  const doc: AminoSignDoc = {
    account_number: input.accountNumber.toString(),
    chain_id: input.chainId,
    fee: {
      amount: fee.amount.map((c) => marshalMessage(reflect(CoinSchema, c), ctx) as unknown as AminoCoin),
      gas: fee.gasLimit.toString(),
    },
    memo: body.memo,
    msgs: body.messages.map((m) => aminoEncodeAny(m, options) as unknown as AminoMsg),
    sequence: input.sequence.toString(),
  };
  if (fee.payer !== "") doc.fee.payer = fee.payer;
  if (fee.granter !== "") doc.fee.granter = fee.granter;
  if (body.timeoutHeight !== 0n) doc.timeout_height = body.timeoutHeight.toString();
  if (body.unordered) doc.unordered = true;
  if (body.timeoutTimestamp) doc.timeout_timestamp = timestampToAmino(body.timeoutTimestamp);
  return doc;
}

/** The sign bytes for an amino sign document: compact JSON, keys sorted, Go escaping. */
export function aminoSignDocBytes(doc: AminoSignDoc): Uint8Array {
  return marshalGoJsonBytes(doc as unknown as JsonValue);
}

/** Encodes a message; wrapped as {"type", "value"} when the message has an amino name. */
export function aminoEncode<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, options: AminoOptions = {}): JsonValue {
  return beginMarshal(reflect(schema, message), false, { registry: options.registry ?? defaultRegistry });
}

/** Encodes a packed message as {"type", "value"}, the type its amino name or else its type URL. */
export function aminoEncodeAny(any: Any, options: AminoOptions = {}): JsonValue {
  return marshalAny(any, { registry: options.registry ?? defaultRegistry });
}

interface Context {
  registry: Registry;
}

function beginMarshal(r: ReflectMessage, isAny: boolean, ctx: Context): JsonValue {
  const opts = messageOptions(r.desc);
  const name = isAny ? (opts.aminoName ?? typeUrlOf(r.desc)) : opts.aminoName;
  const value = marshalMessage(r, ctx);
  return name === undefined ? value : { type: name, value };
}

function marshalAny(any: Any, ctx: Context): JsonValue {
  const schema = ctx.registry.getMessage(typeNameOf(any.typeUrl));
  if (!schema) throw new UnknownTypeError(any.typeUrl);
  return beginMarshal(reflect(schema, fromBinary(schema, any.value)), true, ctx);
}

interface Entry {
  field: DescField;
  name: string;
  oneofFieldName: string | undefined;
  oneofTypeName: string | undefined;
}

function marshalMessage(r: ReflectMessage, ctx: Context): JsonValue {
  switch (r.desc.typeName) {
    case "google.protobuf.Timestamp":
      return timestampToAmino(r.message as Timestamp);
    case "google.protobuf.Duration":
      return durationToAmino(r.message as Duration);
    case "google.protobuf.Any":
      return marshalAny(r.message as Any, ctx);
  }
  switch (messageOptions(r.desc).messageEncoding) {
    case "key_field":
      return keyFieldEncoder(r);
    case "threshold_string":
      return thresholdStringEncoder(r, ctx);
    case "module_account":
      throw new AminoError("module_account encoding is not supported in a sign document");
  }

  const entries: Entry[] = r.fields.map((field) => {
    const o = fieldOptions(field);
    if (!field.oneof) return { field, name: o.aminoName, oneofFieldName: undefined, oneofTypeName: undefined };
    if (o.oneofName === undefined) throw new AminoError(`field ${field.name} within a oneof must have the amino.oneof_name option set`);
    return { field, name: o.aminoName, oneofFieldName: toCamel(field.oneof.name), oneofTypeName: o.oneofName };
  });
  entries.sort((a, b) => compareUtf8(a.oneofFieldName ?? a.name, b.oneofFieldName ?? b.name));

  const out: JsonObject = {};
  const emptyOneofWritten = new Set<string>();
  for (const e of entries) {
    const f = e.field;
    let name = e.name;
    let writeNil = false;
    if (!r.isSet(f)) {
      if (f.oneof && e.oneofFieldName !== undefined && r.oneofCase(f.oneof) === undefined && !emptyOneofWritten.has(e.oneofFieldName)) {
        name = e.oneofFieldName;
        writeNil = true;
        emptyOneofWritten.add(e.oneofFieldName);
      } else if (!fieldOptions(f).dontOmitEmpty) {
        continue;
      } else if (f.fieldKind === "message") {
        throw new AminoError(`not supported: dont_omit_empty=true on unset message field ${name}`);
      }
    }
    const encoder = fieldEncoder(f);
    let value: JsonValue;
    if (encoder) value = encoder(r, f, ctx);
    else if (writeNil) value = null;
    else value = marshalField(r, f, ctx);

    if (f.oneof && !writeNil && e.oneofFieldName !== undefined && e.oneofTypeName !== undefined) {
      out[e.oneofFieldName] = { type: e.oneofTypeName, value: { [name]: value } };
    } else {
      out[name] = value;
    }
  }
  return out;
}

function marshalField(r: ReflectMessage, f: DescField, ctx: Context): JsonValue {
  switch (f.fieldKind) {
    case "list":
      return marshalList(r.get(f), f, ctx);
    case "map":
      throw new AminoError("maps are not supported");
    case "message":
      return marshalMessage(r.get(f), ctx);
    case "enum":
      return r.get(f);
    case "scalar":
      return marshalScalar(f.scalar, r.get(f), f.longAsString);
  }
}

function marshalList(list: ReflectList, f: DescField & { fieldKind: "list" }, ctx: Context): JsonValue {
  const out: JsonValue[] = [];
  for (const item of list) {
    switch (f.listKind) {
      case "message":
        out.push(marshalMessage(item as ReflectMessage, ctx));
        break;
      case "enum":
        out.push(item as number);
        break;
      case "scalar":
        out.push(marshalScalar(f.scalar, item, f.longAsString));
    }
  }
  return out;
}

function marshalScalar(type: ScalarType, v: unknown, longAsString: boolean): JsonValue {
  switch (type) {
    case ScalarType.STRING:
      return v as string;
    case ScalarType.BOOL:
      return v as boolean;
    case ScalarType.BYTES:
      return toBase64(v as Uint8Array);
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return v as number;
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return longAsString ? (v as string) : (v as bigint).toString();
    default:
      throw new AminoError(`unknown type ${ScalarType[type]}`);
  }
}

type FieldEncoder = (r: ReflectMessage, f: DescField, ctx: Context) => JsonValue;

function fieldEncoder(f: DescField): FieldEncoder | undefined {
  const o = fieldOptions(f);
  switch (o.encoding) {
    case ENCODING_LEGACY_COINS:
    case ENCODING_NULL_SLICE_AS_EMPTY:
      return nullSliceAsEmpty;
    case ENCODING_INLINE_JSON:
      return inlineJson;
  }
  if (o.scalar === SCALAR_DEC) return o.customtype === LEGACY_DEC ? cosmosDec : undefined;
  if (o.scalar === SCALAR_INT) return cosmosInt;
  return undefined;
}

const nullSliceAsEmpty: FieldEncoder = (r, f, ctx) => {
  if (f.fieldKind !== "list") throw new AminoError(`unsupported type for ${f.name}`);
  const list = r.get(f);
  return list.size === 0 ? [] : marshalList(list, f, ctx);
};

const inlineJson: FieldEncoder = (r, f) => {
  if (f.fieldKind !== "scalar" || f.scalar !== ScalarType.BYTES) throw new AminoError(`unsupported type for ${f.name}`);
  const bytes = r.get(f) as Uint8Array;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(utf8Decode(bytes)) as JsonValue;
  } catch {
    throw new AminoError("could not normalize JSON: invalid JSON bytes");
  }
  return sortKeys(parsed);
};

// Decs and Ints travel as decimal text, in a string field or as the bytes of one.
function numericText(r: ReflectMessage, f: DescField): string {
  if (f.fieldKind !== "scalar") throw new AminoError(`unsupported type for ${f.name}`);
  const v = r.get(f);
  if (f.scalar === ScalarType.STRING) return v as string;
  if (f.scalar === ScalarType.BYTES) return utf8Decode(v as Uint8Array);
  throw new AminoError(`unsupported type for ${f.name}`);
}

const cosmosDec: FieldEncoder = (r, f) => {
  const v = numericText(r, f);
  return v === "" ? "0" : LegacyDec.fromWire(v).toString();
};

const cosmosInt: FieldEncoder = (r, f) => {
  const v = numericText(r, f);
  return v === "" ? "0" : v;
};

function keyFieldEncoder(r: ReflectMessage): JsonValue {
  const key = r.desc.fields.find((f) => f.name === "key");
  if (!key || key.fieldKind !== "scalar" || key.scalar !== ScalarType.BYTES) throw new AminoError('message encoder for key_field: no field named "key" found');
  const bytes = r.get(key) as Uint8Array;
  return bytes.length === 0 ? null : toBase64(bytes);
}

function thresholdStringEncoder(r: ReflectMessage, ctx: Context): JsonValue {
  const keys = r.desc.fields.find((f) => f.name === "public_keys");
  const threshold = r.desc.fields.find((f) => f.name === "threshold");
  if (!keys || keys.fieldKind !== "list" || !threshold || threshold.fieldKind !== "scalar") {
    throw new AminoError("thresholdStringEncoder: msg not a multisig.LegacyAminoPubKey");
  }
  const list = r.get(keys);
  return { pubkeys: list.size === 0 ? [] : marshalList(list, keys, ctx), threshold: String(r.get(threshold)) };
}

/** strcase.ToCamel on a snake_case oneof name. */
function toCamel(name: string): string {
  return name
    .split("_")
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

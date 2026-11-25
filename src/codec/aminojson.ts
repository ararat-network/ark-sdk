// Legacy amino JSON, the sign mode a Ledger signs in. The encoder follows the
// chain's x/tx aminojson rules: fields sorted by amino name, empty fields
// omitted unless amino.dont_omitempty, enums as integers, Decs and Ints as
// decimal text, Any as {"type", "value"} under its amino name, Timestamps in
// RFC 3339, Durations as nanoseconds, coins never null, wasm JSON inlined,
// public keys as their bare key. The bytes are Go's compact sorted JSON.
// The decoder is the same rules read backwards, from the same schemas, for
// whoever is handed a document and must know what it says before signing it.
// The chain has no such reader, so the encoder is its check: a decoding is
// returned only if it encodes back to the JSON it was read from.
import {
  create,
  type DescField,
  type DescMessage,
  type DescOneof,
  isMessage,
  type MessageShape,
  type Registry,
  ScalarType,
  toBinary,
} from "@bufbuild/protobuf";
import { type ReflectList, type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { type Any, AnySchema, DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { ArkSdkError, errorMessage } from "../errors.js";
import { type Coin, CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { type Fee, FeeSchema, type TxBody, TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { requireRegistry, typeUrlOf, UnknownTypeError, unpackAny, type WithRegistry } from "./any.js";
import { fromBase64, toBase64, utf8Decode, utf8Encode } from "./bytes.js";
import { intFromWire } from "./coins.js";
import { LegacyDec } from "./dec.js";
import { CANONICAL_INTEGER_TEXT, numericText } from "./fixed.js";
import { compareUtf8, isJsonObject, type JsonObject, type JsonValue, marshalGoJson, marshalGoJsonBytes, sortKeys } from "./json.js";
import {
  ENCODING_INLINE_JSON,
  ENCODING_LEGACY_COINS,
  ENCODING_NULL_SLICE_AS_EMPTY,
  fieldOptions,
  LEGACY_DEC,
  messageOptions,
  SCALAR_DEC,
  SCALAR_INT,
} from "./options.js";
import { integerRange } from "./protojson.js";
import { durationFromAmino, durationToAmino, timestampFromText, timestampToAmino } from "./wkt.js";

export interface AminoCoin {
  denom: string;
  amount: string;
}

/** A type alias, not an interface, so that it is itself JSON: the encoder returns one where a JSON value is expected. */
export type AminoMsg = {
  type: string;
  value: JsonValue;
};

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

export class AminoError extends ArkSdkError {
  override readonly name: string = "AminoError";
}

export type AminoOptions = WithRegistry;

export interface AminoSignDocInput {
  body: TxBody;
  fee: Fee;
  chainId: string;
  accountNumber: bigint;
  sequence: bigint;
}

/** The amino sign document of a transaction, as the chain's handler builds it. */
export function makeAminoSignDoc(input: AminoSignDocInput, options: AminoOptions): AminoSignDoc {
  const { body, fee } = input;
  if (body.extensionOptions.length > 0 || body.nonCriticalExtensionOptions.length > 0) {
    throw new AminoError("SIGN_MODE_LEGACY_AMINO_JSON does not support protobuf extension options");
  }
  const ctx: Context = { registry: requireRegistry(options?.registry, "makeAminoSignDoc") };
  const doc: AminoSignDoc = {
    account_number: input.accountNumber.toString(),
    chain_id: wellFormed(input.chainId),
    fee: {
      amount: fee.amount.map((c) => marshalMessage(reflect(CoinSchema, c), ctx) as unknown as AminoCoin),
      gas: fee.gasLimit.toString(),
    },
    memo: wellFormed(body.memo),
    msgs: body.messages.map((m) => marshalAny(m, ctx)),
    sequence: input.sequence.toString(),
  };
  if (fee.payer !== "") doc.fee.payer = wellFormed(fee.payer);
  if (fee.granter !== "") doc.fee.granter = wellFormed(fee.granter);
  if (body.timeoutHeight !== 0n) doc.timeout_height = body.timeoutHeight.toString();
  if (body.unordered) doc.unordered = true;
  if (body.timeoutTimestamp) doc.timeout_timestamp = timestampToAmino(body.timeoutTimestamp);
  return doc;
}

/**
 * A string as the transaction's bytes carry it. The bytes are UTF-8, where half of a surrogate pair becomes U+FFFD,
 * and the chain builds its document from the bytes: the document signed here must hold the same character, not
 * the half the caller's string held.
 */
function wellFormed(text: string): string {
  return utf8Decode(utf8Encode(text));
}

/** The sign bytes for an amino sign document: compact JSON, keys sorted, Go escaping. */
export function aminoSignDocBytes(doc: AminoSignDoc): Uint8Array {
  return marshalGoJsonBytes(doc as unknown as JsonValue);
}

const SIGN_DOC_MEMBERS = ["account_number", "chain_id", "fee", "memo", "msgs", "sequence", "timeout_height", "unordered", "timeout_timestamp"];
const FEE_MEMBERS = ["amount", "gas", "payer", "granter"];

/**
 * The transaction an amino sign document describes: the reverse of makeAminoSignDoc. Each message is packed under its
 * type URL, found by its amino name. A member that names nothing is refused, so nothing in the document goes unread,
 * and so is a document that is not, byte for byte, the one its decoded form encodes to.
 */
export function decodeAminoSignDoc(doc: AminoSignDoc, options: AminoOptions): AminoSignDocInput {
  const ctx: ReadContext = { registry: requireRegistry(options?.registry, "decodeAminoSignDoc"), types: undefined };
  const top = knownMembers(doc as unknown as JsonValue, "sign document", SIGN_DOC_MEMBERS);
  const fee = knownMembers(top.fee ?? null, "sign document: fee", FEE_MEMBERS);
  const text = (json: JsonValue | undefined, where: string) => unmarshalScalar(ScalarType.STRING, json ?? null, false, `sign document: ${where}`) as string;
  const uint = (json: JsonValue | undefined, where: string) => unmarshalScalar(ScalarType.UINT64, json ?? null, false, `sign document: ${where}`) as bigint;

  const body = create(TxBodySchema, { messages: itemsOf(top.msgs, "sign document: msgs").map((m) => unmarshalAny(m, ctx)), memo: text(top.memo, "memo") });
  if (top.timeout_height !== undefined) body.timeoutHeight = uint(top.timeout_height, "timeout_height");
  if (top.unordered !== undefined) body.unordered = unmarshalScalar(ScalarType.BOOL, top.unordered, false, "sign document: unordered") as boolean;
  if (top.timeout_timestamp !== undefined) body.timeoutTimestamp = timestampFromText(text(top.timeout_timestamp, "timeout_timestamp"));
  const input: AminoSignDocInput = {
    body,
    fee: create(FeeSchema, {
      amount: itemsOf(fee.amount, "sign document: fee.amount").map((c) => unmarshalMessage(CoinSchema, c, ctx).message as Coin),
      gasLimit: uint(fee.gas, "fee.gas"),
      payer: fee.payer === undefined ? "" : text(fee.payer, "fee.payer"),
      granter: fee.granter === undefined ? "" : text(fee.granter, "fee.granter"),
    }),
    chainId: text(top.chain_id, "chain_id"),
    accountNumber: uint(top.account_number, "account_number"),
    sequence: uint(top.sequence, "sequence"),
  };
  requireSame(makeAminoSignDoc(input, options) as unknown as JsonValue, top, "sign document");
  return input;
}

/** Encodes a message; wrapped as {"type", "value"} when the message has an amino name. */
export function aminoEncode<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, options: AminoOptions): JsonValue {
  const name = messageOptions(schema).aminoName;
  const value = marshalMessage(reflect(schema, message), { registry: requireRegistry(options?.registry, "aminoEncode") });
  return name === undefined ? value : { type: name, value };
}

/** Encodes a packed message as {"type", "value"}, the type its amino name or else its type URL. */
export function aminoEncodeAny(any: Any, options: AminoOptions): JsonValue {
  return marshalAny(any, { registry: requireRegistry(options?.registry, "aminoEncodeAny") });
}

/** Decodes what aminoEncode wrote: {"type", "value"} for a message with an amino name, its bare value for one without. */
export function aminoDecode<Desc extends DescMessage>(schema: Desc, json: JsonValue, options: AminoOptions): MessageShape<Desc> {
  const ctx: ReadContext = { registry: requireRegistry(options?.registry, "aminoDecode"), types: undefined };
  const name = messageOptions(schema).aminoName;
  let value = json;
  if (name !== undefined) {
    const wrapper = typedValue(json, schema.typeName);
    if (wrapper.type !== name) throw new AminoError(`${schema.typeName}: expected the type ${name}, got ${wrapper.type}`);
    value = wrapper.value;
  }
  const message = unmarshalMessage(schema, value, ctx).message as MessageShape<Desc>;
  requireSame(aminoEncode(schema, message, options), json, schema.typeName);
  return message;
}

/** Decodes {"type", "value"} into a packed message, the type an amino name or else the type URL of a message that has none. */
export function aminoDecodeAny(json: JsonValue, options: AminoOptions): Any {
  const any = unmarshalAny(json, { registry: requireRegistry(options?.registry, "aminoDecodeAny"), types: undefined });
  requireSame(aminoEncodeAny(any, options), json, any.typeUrl);
  return any;
}

interface Context {
  registry: Registry;
}

/** A packed message as {"type", "value"}: always wrapped, under its amino name or else its type URL. */
function marshalAny(any: Any, ctx: Context): AminoMsg {
  // Nothing to encode for a type the registry lacks, nor for an Any read without its type, which has no bytes
  // whatever this registry knows.
  const unpacked = unpackAny(any, ctx.registry);
  if (!unpacked) throw new UnknownTypeError(any.typeUrl);
  const value = marshalMessage(reflect(unpacked.schema, unpacked.message), ctx);
  return { type: messageOptions(unpacked.schema).aminoName ?? typeUrlOf(unpacked.schema), value };
}

interface Entry {
  field: DescField;
  name: string;
  oneofFieldName: string | undefined;
  oneofTypeName: string | undefined;
}

function marshalMessage(r: ReflectMessage, ctx: Context): JsonValue {
  const message = r.message;
  if (isMessage(message, TimestampSchema)) return timestampToAmino(message);
  if (isMessage(message, DurationSchema)) return durationToAmino(message);
  if (isMessage(message, AnySchema)) return marshalAny(message, ctx);
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
    case "list": {
      // Reached empty only under dont_omitempty: the chain decodes an absent
      // repeated field as a nil slice and writes null; legacy_coins and
      // null_slice_as_empty write [] through their own encoder.
      const list = r.get(f);
      return list.size === 0 ? null : marshalList(list, f, ctx);
    }
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
  return sortKeys(asGoReads(parsed));
};

/**
 * JSON as Go's decoder holds it. Half of a surrogate pair written as an escape, "\ud83d", is a string here that holds
 * the half; Go reads U+FFFD in its place, in a member's name as in a value, and the chain signs that character. Two
 * names that become one are refused: Go keeps the member that came later in the text, and that order is gone.
 */
function asGoReads(value: JsonValue): JsonValue {
  if (typeof value === "string") return wellFormed(value);
  if (Array.isArray(value)) return value.map(asGoReads);
  if (value === null || typeof value !== "object") return value;
  // From entries, never by assignment, as sortKeys builds its copy: a member may be named "__proto__".
  const entries = Object.entries(value).map(([name, member]) => [wellFormed(name), asGoReads(member)] as const);
  if (new Set(entries.map(([name]) => name)).size < entries.length) {
    throw new AminoError("could not normalize JSON: two members have one name once half a surrogate pair is read as U+FFFD");
  }
  return Object.fromEntries(entries);
}

const cosmosDec: FieldEncoder = (r, f) => {
  const v = numericField(r, f);
  return v === "" ? "0" : LegacyDec.fromWire(v).toString();
};

const cosmosInt: FieldEncoder = (r, f) => {
  const v = numericField(r, f);
  if (v === "") return "0";
  // The chain's encoder writes a string field's text as it is, and reads the bytes of one as an Int before writing it.
  return f.fieldKind === "scalar" && f.scalar === ScalarType.BYTES ? intFromWire(v).toString() : v;
};

/** The text of a Dec or an Int field, which is a string field or a bytes one and no other. */
function numericField(r: ReflectMessage, f: DescField): string {
  if (f.fieldKind !== "scalar" || (f.scalar !== ScalarType.STRING && f.scalar !== ScalarType.BYTES)) throw new AminoError(`unsupported type for ${f.name}`);
  return numericText(r.get(f));
}

function keyFieldEncoder(r: ReflectMessage): JsonValue {
  const key = r.desc.fields.find((f) => f.name === "key");
  if (key?.fieldKind !== "scalar" || key.scalar !== ScalarType.BYTES) throw new AminoError('message encoder for key_field: no field named "key" found');
  const bytes = r.get(key) as Uint8Array;
  return bytes.length === 0 ? null : toBase64(bytes);
}

function thresholdStringEncoder(r: ReflectMessage, ctx: Context): JsonValue {
  const keys = r.desc.fields.find((f) => f.name === "public_keys");
  const threshold = r.desc.fields.find((f) => f.name === "threshold");
  if (keys?.fieldKind !== "list" || !threshold || threshold.fieldKind !== "scalar") {
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

interface ReadContext extends Context {
  /** The registry's messages by amino name, built at the first lookup of one read. */
  types: Map<string, DescMessage[]> | undefined;
}

/**
 * Refuses a decoding that does not encode back to the JSON it was read from. Where the encoder writes two messages
 * alike, the decoder can return only one of them; this is what makes the one it returns a message the JSON stands for.
 */
function requireSame(encoded: JsonValue, given: JsonValue, what: string): void {
  if (marshalGoJson(encoded) !== marshalGoJson(given)) throw new AminoError(`${what}: not the amino JSON its decoded form encodes to`);
}

/** An object's members, refused if one of them is not among those named: nothing in a document is passed over. */
function knownMembers(json: JsonValue, where: string, known: readonly string[]): JsonObject {
  if (!isJsonObject(json)) throw new AminoError(`${where}: expected an object`);
  for (const [key, value] of Object.entries(json)) {
    if (!known.includes(key)) throw new AminoError(`${where}: no field is named ${key}`);
    if (value === undefined) throw new AminoError(`${where}: ${key} is undefined, which is not JSON`);
  }
  return json;
}

function itemsOf(json: JsonValue | undefined, where: string): JsonValue[] {
  if (!Array.isArray(json)) throw new AminoError(`${where}: expected an array`);
  return json;
}

/** The two members of {"type", "value"}, and no other. */
function typedValue(json: JsonValue, where: string): AminoMsg {
  const { type, value } = knownMembers(json, where, ["type", "value"]);
  if (typeof type !== "string" || value === undefined) throw new AminoError(`${where}: expected {"type", "value"}`);
  return { type, value };
}

function unmarshalAny(json: JsonValue, ctx: ReadContext): Any {
  const { type, value } = typedValue(json, "Any");
  const schema = schemaOfType(type, ctx);
  return create(AnySchema, { typeUrl: typeUrlOf(schema), value: toBinary(schema, unmarshalMessage(schema, value, ctx).message) });
}

/**
 * The message a "type" names: the one registered type with that amino name, or, for a type URL, the message of that
 * name if it has no amino name, which is when the encoder writes the URL. A name two registered types share picks
 * neither.
 */
function schemaOfType(type: string, ctx: ReadContext): DescMessage {
  if (!ctx.types) {
    ctx.types = new Map();
    for (const desc of ctx.registry) {
      if (desc.kind !== "message") continue;
      const name = messageOptions(desc).aminoName;
      if (name !== undefined) ctx.types.set(name, [...(ctx.types.get(name) ?? []), desc]);
    }
  }
  const named = ctx.types.get(type);
  if (named) {
    if (named.length > 1) throw new AminoError(`the amino name ${type} is shared by ${named.map((d) => d.typeName).join(" and ")}`);
    return named[0] as DescMessage;
  }
  const schema = type.startsWith("/") ? ctx.registry.getMessage(type.slice(1)) : undefined;
  if (!schema || messageOptions(schema).aminoName !== undefined) throw new UnknownTypeError(type);
  return schema;
}

function unmarshalMessage(desc: DescMessage, json: JsonValue, ctx: ReadContext): ReflectMessage {
  if (desc.typeName === TimestampSchema.typeName)
    return reflect(TimestampSchema, timestampFromText(unmarshalScalar(ScalarType.STRING, json, false, desc.typeName) as string));
  if (desc.typeName === DurationSchema.typeName)
    return reflect(DurationSchema, durationFromAmino(unmarshalScalar(ScalarType.STRING, json, false, desc.typeName) as string));
  if (desc.typeName === AnySchema.typeName) return reflect(AnySchema, unmarshalAny(json, ctx));
  switch (messageOptions(desc).messageEncoding) {
    case "key_field":
      return keyFieldDecoder(desc, json);
    case "threshold_string":
      return thresholdStringDecoder(desc, json, ctx);
    case "module_account":
      throw new AminoError("module_account encoding is not supported in a sign document");
  }

  if (!isJsonObject(json)) throw new AminoError(`${desc.typeName}: expected an object`);
  const members = aminoMembers(desc);
  const r = reflect(desc);
  for (const [key, value] of Object.entries(json)) {
    const member = members.get(key);
    if (!member) throw new AminoError(`${desc.typeName}: no field is named ${key}`);
    if (member.kind === "oneof") unmarshalOneof(r, member, value, ctx);
    else unmarshalField(r, member, value, ctx);
  }
  return r;
}

const memberIndex = new WeakMap<DescMessage, Map<string, DescField | DescOneof>>();

/** What each member of a message's JSON names: a field by its amino name, or a oneof by its camel-cased name. */
function aminoMembers(desc: DescMessage): Map<string, DescField | DescOneof> {
  let index = memberIndex.get(desc);
  if (index) return index;
  index = new Map();
  for (const field of desc.fields) {
    const o = fieldOptions(field);
    if (field.oneof && o.oneofName === undefined) throw new AminoError(`field ${field.name} within a oneof must have the amino.oneof_name option set`);
    const key = field.oneof ? toCamel(field.oneof.name) : o.aminoName;
    const member = field.oneof ?? field;
    // The encoder would write one over the other; there is no reading both back.
    if (index.has(key) && index.get(key) !== member) throw new AminoError(`${desc.typeName}: two fields are written as ${key}`);
    index.set(key, member);
  }
  memberIndex.set(desc, index);
  return index;
}

/** A oneof from {"type", "value": {field: v}}, the type its member's oneof name, or from the null written when no member is set. */
function unmarshalOneof(r: ReflectMessage, oneof: DescOneof, json: JsonValue, ctx: ReadContext): void {
  if (json === null) return;
  const where = `${r.desc.typeName}.${oneof.name}`;
  const { type, value } = typedValue(json, where);
  const keys = isJsonObject(value) ? Object.keys(value) : [];
  const key = keys.length === 1 ? (keys[0] as string) : undefined;
  const field = oneof.fields.find((f) => fieldOptions(f).oneofName === type && fieldOptions(f).aminoName === key);
  if (!field || key === undefined) throw new AminoError(`${where}: no member is written as ${marshalGoJson(json)}`);
  unmarshalField(r, field, (value as JsonObject)[key] as JsonValue, ctx);
}

function unmarshalField(r: ReflectMessage, f: DescField, json: JsonValue, ctx: ReadContext): void {
  const decoder = fieldDecoder(f);
  if (decoder) {
    decoder(r, f, json, ctx);
    return;
  }
  const where = `${f.parent.typeName}.${f.name}`;
  switch (f.fieldKind) {
    case "list":
      // Null is the chain's nil slice, written for an empty list under dont_omitempty.
      if (json !== null) unmarshalList(r.get(f), f, json, ctx);
      return;
    case "map":
      throw new AminoError("maps are not supported");
    case "message":
      r.set(f, unmarshalMessage(f.message, json, ctx));
      return;
    case "enum":
      r.set(f, unmarshalEnum(json, where));
      return;
    case "scalar":
      r.set(f, unmarshalScalar(f.scalar, json, f.longAsString, where));
  }
}

function unmarshalList(list: ReflectList, f: DescField & { fieldKind: "list" }, json: JsonValue, ctx: ReadContext): void {
  const where = `${f.parent.typeName}.${f.name}`;
  for (const item of itemsOf(json, where)) {
    switch (f.listKind) {
      case "message":
        list.add(unmarshalMessage(f.message, item, ctx));
        break;
      case "enum":
        list.add(unmarshalEnum(item, where));
        break;
      case "scalar":
        list.add(unmarshalScalar(f.scalar, item, f.longAsString, where));
    }
  }
}

function unmarshalEnum(json: JsonValue, where: string): number {
  if (typeof json !== "number" || !Number.isInteger(json)) throw new AminoError(`${where}: expected an enum's number`);
  return integerValue(ScalarType.INT32, BigInt(json), false, where) as number;
}

function unmarshalScalar(type: ScalarType, json: JsonValue, longAsString: boolean, where: string): unknown {
  switch (type) {
    case ScalarType.STRING:
      if (typeof json !== "string") throw new AminoError(`${where}: expected a string`);
      return json;
    case ScalarType.BOOL:
      if (typeof json !== "boolean") throw new AminoError(`${where}: expected a boolean`);
      return json;
    case ScalarType.BYTES:
      if (typeof json !== "string") throw new AminoError(`${where}: expected base64`);
      try {
        return fromBase64(json);
      } catch (err) {
        throw new AminoError(`${where}: ${errorMessage(err)}`, { cause: err });
      }
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      if (typeof json !== "number" || !Number.isInteger(json)) throw new AminoError(`${where}: expected an integer`);
      return integerValue(type, BigInt(json), longAsString, where);
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      if (typeof json !== "string" || !CANONICAL_INTEGER_TEXT.test(json)) throw new AminoError(`${where}: expected an integer in decimal text`);
      return integerValue(type, BigInt(json), longAsString, where);
    default:
      throw new AminoError(`unknown type ${ScalarType[type]}`);
  }
}

/** An integer as a field of its type holds it, once within the type's range: a number in 32 bits, a bigint or its text in 64. */
function integerValue(type: ScalarType, value: bigint, longAsString: boolean, where: string): number | bigint | string {
  const [min, max] = integerRange(type);
  if (value < min || value > max) throw new AminoError(`${where}: ${value} is out of range`);
  switch (type) {
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return longAsString ? value.toString() : value;
    default:
      return Number(value);
  }
}

type FieldDecoder = (r: ReflectMessage, f: DescField, json: JsonValue, ctx: ReadContext) => void;

/** The reverse of fieldEncoder, chosen by the same options in the same order. */
function fieldDecoder(f: DescField): FieldDecoder | undefined {
  const o = fieldOptions(f);
  switch (o.encoding) {
    case ENCODING_LEGACY_COINS:
    case ENCODING_NULL_SLICE_AS_EMPTY:
      return sliceFromArray;
    case ENCODING_INLINE_JSON:
      return inlineJsonBytes;
  }
  if (o.scalar === SCALAR_DEC) return o.customtype === LEGACY_DEC ? cosmosDecWire : undefined;
  if (o.scalar === SCALAR_INT) return cosmosIntWire;
  return undefined;
}

const sliceFromArray: FieldDecoder = (r, f, json, ctx) => {
  if (f.fieldKind !== "list") throw new AminoError(`unsupported type for ${f.name}`);
  unmarshalList(r.get(f), f, json, ctx);
};

/**
 * JSON back to the bytes of a contract's message. The bytes the sender wrote are not in the document, only the JSON
 * they held; these are that JSON as the encoder itself writes it, compact with sorted keys.
 */
const inlineJsonBytes: FieldDecoder = (r, f, json) => {
  if (f.fieldKind !== "scalar" || f.scalar !== ScalarType.BYTES) throw new AminoError(`unsupported type for ${f.name}`);
  r.set(f, utf8Encode(marshalGoJson(json)));
};

const cosmosDecWire: FieldDecoder = (r, f, json) => {
  const text = numericJson(f, json);
  // A Dec that is present is written with its eighteen places; "0" alone stands for one that is absent, and stays so.
  if (text !== "0") setNumeric(r, f, LegacyDec.fromString(text).toWire());
};

/**
 * An Int's text is its wire form. The encoder writes "0" for an absent Int under dont_omitempty as it does for one
 * that holds "0": read back, the field holds "0", as the chain's own encoding of a zero Int and materialise do.
 */
const cosmosIntWire: FieldDecoder = (r, f, json) => {
  setNumeric(r, f, numericJson(f, json));
};

/** The JSON text of a Dec or an Int field, which is a string field or a bytes one and no other. */
function numericJson(f: DescField, json: JsonValue): string {
  if (f.fieldKind !== "scalar" || (f.scalar !== ScalarType.STRING && f.scalar !== ScalarType.BYTES)) throw new AminoError(`unsupported type for ${f.name}`);
  if (typeof json !== "string") throw new AminoError(`${f.parent.typeName}.${f.name}: expected a number in decimal text`);
  return json;
}

function setNumeric(r: ReflectMessage, f: DescField, wire: string): void {
  r.set(f, f.fieldKind === "scalar" && f.scalar === ScalarType.BYTES ? utf8Encode(wire) : wire);
}

function keyFieldDecoder(desc: DescMessage, json: JsonValue): ReflectMessage {
  const key = desc.fields.find((f) => f.name === "key");
  if (key?.fieldKind !== "scalar" || key.scalar !== ScalarType.BYTES) throw new AminoError('message decoder for key_field: no field named "key" found');
  const r = reflect(desc);
  // Null is a key of no bytes.
  if (json !== null) r.set(key, unmarshalScalar(ScalarType.BYTES, json, false, `${desc.typeName}.key`));
  return r;
}

function thresholdStringDecoder(desc: DescMessage, json: JsonValue, ctx: ReadContext): ReflectMessage {
  const keys = desc.fields.find((f) => f.name === "public_keys");
  const threshold = desc.fields.find((f) => f.name === "threshold");
  if (keys?.fieldKind !== "list" || !threshold || threshold.fieldKind !== "scalar") {
    throw new AminoError("thresholdStringDecoder: msg not a multisig.LegacyAminoPubKey");
  }
  const { pubkeys, threshold: text } = knownMembers(json, desc.typeName, ["pubkeys", "threshold"]);
  if (typeof text !== "string" || !CANONICAL_INTEGER_TEXT.test(text))
    throw new AminoError(`${desc.typeName}: expected the threshold as an integer in decimal text`);
  const r = reflect(desc);
  unmarshalList(r.get(keys), keys, pubkeys ?? null, ctx);
  r.set(threshold, integerValue(threshold.scalar, BigInt(text), threshold.longAsString, `${desc.typeName}.threshold`));
  return r;
}

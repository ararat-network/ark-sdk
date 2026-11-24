// Any packing the Cosmos way: the type URL is "/" plus the full type name, not
// protobuf-es's type.googleapis.com form, which the chain would refuse.
import { create, type DescMessage, fromBinary, type Message, type MessageShape, type Registry, toBinary } from "@bufbuild/protobuf";
import { type ReflectMessage, reflect } from "@bufbuild/protobuf/reflect";
import { type Any, AnySchema } from "@bufbuild/protobuf/wkt";
import { ArkSdkError } from "../errors.js";
import type { JsonObject } from "./json.js";

/** What every reader of packed messages needs: the types an Any resolves against. */
export interface WithRegistry {
  registry: Registry;
}

/** The same where it may be left out: the main entry defaults it to every generated type, and a client's helpers to the client's own. */
export interface RegistryOption {
  registry?: Registry;
}

export class UnknownTypeError extends ArkSdkError {
  override readonly name: string = "UnknownTypeError";
  constructor(
    readonly typeUrl: string,
    message = `unknown type ${typeUrl}`,
  ) {
    super(message);
  }
}

/** The type URL of a message schema: "/" and the full name. */
export function typeUrlOf(schema: DescMessage): string {
  return `/${schema.typeName}`;
}

/** The full type name a type URL carries, whatever its prefix. */
export function typeNameOf(typeUrl: string): string {
  return typeUrl.slice(typeUrl.lastIndexOf("/") + 1);
}

/**
 * Packs a message into an Any under its Cosmos type URL. A message that holds, at any depth, an Any read without its
 * type is refused: that Any has no bytes, and the packed message would name its type with no content.
 */
export function packAny<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): Any {
  const held = heldAnyWithin(reflect(schema, message));
  if (held) {
    throw new UnknownTypeError(
      held.typeUrl,
      `${schema.typeName} holds ${held.typeUrl}, which was read without its type and holds no bytes; it cannot be packed`,
    );
  }
  return create(AnySchema, { typeUrl: typeUrlOf(schema), value: toBinary(schema, message) });
}

export interface Unpacked {
  schema: DescMessage;
  message: Message;
}

// An Any read from JSON whose type the reader's registry lacks has no bytes:
// JSON cannot be turned into a message without its schema. Such an Any keeps
// its type URL and an empty value, and the JSON it arrived as is held beside
// it here, by identity, so a copy made with create or clone carries only the
// type URL. Its empty value must never be decoded as if it were the message.
// A known Any that held one is read the same way, whole, so no bytes the
// reader writes ever stand around one.
const heldJson = new WeakMap<Any, JsonObject>();

/** The first Any within a message, the message itself included, that is held as JSON and has no bytes. One that carries bytes is not looked into. */
function heldAnyWithin(r: ReflectMessage): Any | undefined {
  if (r.desc.typeName === AnySchema.typeName) return heldJson.has(r.message as Any) ? (r.message as Any) : undefined;
  for (const f of r.fields) {
    let found: Any | undefined;
    switch (f.fieldKind) {
      case "message":
        if (r.isSet(f)) found = heldAnyWithin(r.get(f));
        break;
      case "list":
        if (f.listKind === "message") for (const item of r.get(f)) found ??= heldAnyWithin(item as ReflectMessage);
        break;
      case "map":
        if (f.mapKind === "message") for (const [, item] of r.get(f)) found ??= heldAnyWithin(item as ReflectMessage);
        break;
    }
    if (found) return found;
  }
  return undefined;
}

/** The Any standing for a message known only as the JSON a node rendered, "@type" included: its type URL, no bytes, the JSON held beside it. */
export function anyFromUnknownJson(typeUrl: string, json: JsonObject): Any {
  const any = create(AnySchema, { typeUrl });
  heldJson.set(any, json);
  return any;
}

/** The JSON of an Any that was read without its type being known, "@type" included; undefined for an Any that carries its bytes. */
export function unknownAnyJson(any: Any): JsonObject | undefined {
  return heldJson.get(any);
}

/** Unpacks an Any through the registry; undefined when the type is unknown, or was when the Any was read and only its JSON is held. */
export function unpackAny(any: Any, registry: Registry): Unpacked | undefined {
  if (heldJson.has(any)) return undefined;
  const schema = registry.getMessage(typeNameOf(any.typeUrl));
  if (!schema) return undefined;
  return { schema, message: fromBinary(schema, any.value) };
}

/** Unpacks an Any as one schema, refusing another type. */
export function unpackAnyAs<Desc extends DescMessage>(any: Any, schema: Desc): MessageShape<Desc> {
  if (heldJson.has(any) || typeNameOf(any.typeUrl) !== schema.typeName) throw new UnknownTypeError(any.typeUrl);
  return fromBinary(schema, any.value);
}

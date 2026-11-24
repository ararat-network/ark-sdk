// Any packing the Cosmos way: the type URL is "/" plus the full type name, not
// protobuf-es's type.googleapis.com form, which the chain would refuse.
import { create, type DescMessage, fromBinary, type Message, type MessageShape, type Registry, toBinary } from "@bufbuild/protobuf";
import { type Any, AnySchema } from "@bufbuild/protobuf/wkt";

import type { JsonObject } from "./json.js";
import { registry as defaultRegistry } from "./registry.js";

export class UnknownTypeError extends Error {
  override readonly name: string = "UnknownTypeError";
  constructor(readonly typeUrl: string) {
    super(`unknown type ${typeUrl}`);
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

/** Packs a message into an Any under its Cosmos type URL. */
export function packAny<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): Any {
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
const heldJson = new WeakMap<Any, JsonObject>();

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
export function unpackAny(any: Any, registry: Registry = defaultRegistry): Unpacked | undefined {
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

/** Whether an Any holds a message of this schema. */
export function anyHolds(any: Any, schema: DescMessage): boolean {
  return typeNameOf(any.typeUrl) === schema.typeName;
}

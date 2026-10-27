// Any packing the Cosmos way: the type URL is "/" plus the full type name, not
// protobuf-es's type.googleapis.com form, which the chain would refuse.
import { create, type DescMessage, fromBinary, type Message, type MessageShape, type Registry, toBinary } from "@bufbuild/protobuf";
import { type Any, AnySchema } from "@bufbuild/protobuf/wkt";

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

/** Unpacks an Any through the registry; undefined when the type is unknown. */
export function unpackAny(any: Any, registry: Registry = defaultRegistry): Unpacked | undefined {
  const schema = registry.getMessage(typeNameOf(any.typeUrl));
  if (!schema) return undefined;
  return { schema, message: fromBinary(schema, any.value) };
}

/** Unpacks an Any as one schema, refusing another type. */
export function unpackAnyAs<Desc extends DescMessage>(any: Any, schema: Desc): MessageShape<Desc> {
  if (typeNameOf(any.typeUrl) !== schema.typeName) throw new UnknownTypeError(any.typeUrl);
  return fromBinary(schema, any.value);
}

/** Whether an Any holds a message of this schema. */
export function anyHolds(any: Any, schema: DescMessage): boolean {
  return typeNameOf(any.typeUrl) === schema.typeName;
}

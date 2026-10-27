// Typed events as the chain emits them: an event whose type is a message name
// carries each field as an attribute whose value is JSON. A block event adds a
// `mode` attribute whose value is a bare word, which must go before decoding;
// `msg_index` names the message an event belongs to and is not a field.
import type { DescMessage, Message, Registry } from "@bufbuild/protobuf";

import type { JsonObject, JsonValue } from "../codec/json.js";
import { fromProtoJson, toProtoJson } from "../codec/protojson.js";
import { registry as defaultRegistry } from "../codec/registry.js";

export interface EventAttribute {
  key: string;
  value: string;
  index?: boolean;
}

export interface Event {
  type: string;
  attributes: readonly EventAttribute[];
}

export interface DecodedEvent {
  type: string;
  /** The attributes as emitted, `mode` included. */
  attributes: readonly EventAttribute[];
  /** The message the event decodes to, when its type is a registered message and every attribute parses. */
  typed: Message | undefined;
  schema: DescMessage | undefined;
  /** The typed event in the chain's JSON dialect, as the fixtures pin it. */
  json: JsonValue | undefined;
  /** The index of the message that emitted it, from `msg_index`; undefined for transaction-level and block events. */
  msgIndex: number | undefined;
  /** BeginBlock or EndBlock for a block event; undefined inside a transaction. */
  mode: string | undefined;
}

export interface EventDecodeOptions {
  registry?: Registry;
}

/** Decodes one event; an event that is not a typed proto event keeps its attributes and has no `typed`. */
export function decodeEvent(event: Event, options: EventDecodeOptions = {}): DecodedEvent {
  const registry = options.registry ?? defaultRegistry;
  const mode = event.attributes.find((a) => a.key === "mode")?.value;
  const msgIndexText = event.attributes.find((a) => a.key === "msg_index")?.value;
  const msgIndex = msgIndexText !== undefined && /^\d+$/.test(msgIndexText) ? Number(msgIndexText) : undefined;
  const base: DecodedEvent = { type: event.type, attributes: event.attributes, typed: undefined, schema: undefined, json: undefined, msgIndex, mode };

  const schema = registry.getMessage(event.type);
  if (!schema) return base;
  const fields: JsonObject = {};
  for (const a of event.attributes) {
    if (a.key === "mode") continue;
    try {
      fields[a.key] = JSON.parse(a.value) as JsonValue;
    } catch {
      return base;
    }
  }
  try {
    const typed = fromProtoJson(schema, fields, { registry, ignoreUnknownFields: true });
    return { ...base, typed, schema, json: toProtoJson(schema, typed, { registry, unknownAny: "raw" }) };
  } catch {
    return base;
  }
}

export function decodeEvents(events: readonly Event[], options: EventDecodeOptions = {}): DecodedEvent[] {
  return events.map((e) => decodeEvent(e, options));
}

/** Groups a transaction's events by the message that emitted them; the key undefined holds the transaction-level ones. */
export function eventsByMessage(events: readonly DecodedEvent[]): Map<number | undefined, DecodedEvent[]> {
  const out = new Map<number | undefined, DecodedEvent[]>();
  for (const e of events) {
    const list = out.get(e.msgIndex) ?? [];
    list.push(e);
    out.set(e.msgIndex, list);
  }
  return out;
}

// The main entry's layer over the core: the same readers and clients with
// the registry defaulted to every generated type. This is the one module that
// imports the full registry; every other takes its registry as an argument,
// which is what keeps the core entry's bundle to the types its caller names.
// It exports the core's every name, and a name declared here stands in place
// of the core's: writing the defaulted form below is what makes it the main
// entry's.
import type { DescMessage, MessageShape, Registry } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import {
  type AminoSignDoc,
  type AminoSignDocInput,
  aminoEncodeAny as aminoEncodeAnyWith,
  aminoEncode as aminoEncodeWith,
  makeAminoSignDoc as makeAminoSignDocWith,
} from "./codec/aminojson.js";
import { type RegistryOption, type Unpacked, unpackAny as unpackAnyWith } from "./codec/any.js";
import type { JsonValue } from "./codec/json.js";
import {
  type FromProtoJsonOptions as CoreFromProtoJsonOptions,
  type ToProtoJsonOptions as CoreToProtoJsonOptions,
  fromProtoJson as fromProtoJsonWith,
  toProtoJson as toProtoJsonWith,
} from "./codec/protojson.js";
import { registry } from "./codec/registry.js";
import { type DecodedAccount, decodeAccount as decodeAccountWith } from "./decode/account.js";
import { type ChainEvent, type DecodedEvent, decodeEvents as decodeEventsWith, decodeEvent as decodeEventWith } from "./decode/events.js";
import { decodeMsgResponses as decodeMsgResponsesWith } from "./decode/responses.js";
import {
  type DecodedMessage,
  type DecodedTx,
  decodeMessage as decodeMessageWith,
  decodeTxMessages as decodeTxMessagesWith,
  decodeTx as decodeTxWith,
} from "./decode/tx.js";
import type { TxResponse } from "./gen/cosmos/base/abci/v1beta1/abci_pb.js";
import type { Tx } from "./gen/cosmos/tx/v1beta1/tx_pb.js";
import { QueryClient as CoreQueryClient, restEndpoints } from "./query/client.js";
import { GatewayClient as CoreGatewayClient, type GatewayOptions as CoreGatewayOptions } from "./query/gateway.js";
import { type FoundTx, foundTx as foundTxWith } from "./query/search.js";
import type { Network } from "./registry/network.js";
import { type SignedTx, type SignTxInput, signTx as signTxWith } from "./tx/builder.js";

export * from "./core.js";
export { registry };

/** An options type with its registry optional: left out, it is every generated type. */
type Defaulted<T> = Omit<T, "registry"> & RegistryOption;

export type AminoOptions = RegistryOption;
export type EventDecodeOptions = RegistryOption;
export type TxDecodeOptions = RegistryOption;
export type ToProtoJsonOptions = Defaulted<CoreToProtoJsonOptions>;
export type FromProtoJsonOptions = Defaulted<CoreFromProtoJsonOptions>;
/** `registry` is the types Any fields resolve against in requests and answers; every generated type by default. */
export type GatewayOptions = Defaulted<CoreGatewayOptions>;

/** Unpacks an Any through the registry; undefined when the type is unknown, or was when the Any was read and only its JSON is held. */
export function unpackAny(any: Any, reg: Registry = registry): Unpacked | undefined {
  return unpackAnyWith(any, reg);
}

/** The amino sign document of a transaction, as the chain's handler builds it. */
export function makeAminoSignDoc(input: AminoSignDocInput, options: AminoOptions = {}): AminoSignDoc {
  return makeAminoSignDocWith(input, withRegistry(options));
}

/** Encodes a message; wrapped as {"type", "value"} when the message has an amino name. */
export function aminoEncode<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, options: AminoOptions = {}): JsonValue {
  return aminoEncodeWith(schema, message, withRegistry(options));
}

/** Encodes a packed message as {"type", "value"}, the type its amino name or else its type URL. */
export function aminoEncodeAny(any: Any, options: AminoOptions = {}): JsonValue {
  return aminoEncodeAnyWith(any, withRegistry(options));
}

/** Renders a message in the chain's JSON dialect. */
export function toProtoJson<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>, options: ToProtoJsonOptions = {}): JsonValue {
  return toProtoJsonWith(schema, message, withRegistry(options));
}

/** Reads a message from the chain's JSON dialect. */
export function fromProtoJson<Desc extends DescMessage>(schema: Desc, json: JsonValue, options: FromProtoJsonOptions = {}): MessageShape<Desc> {
  return fromProtoJsonWith(schema, json, withRegistry(options));
}

/** Decodes the Any an account query returns. */
export function decodeAccount(any: Any, reg: Registry = registry): DecodedAccount {
  return decodeAccountWith(any, reg);
}

/** Decodes a result's data, hex as the gateway returns it or raw bytes, into one response per message. */
export function decodeMsgResponses(data: string | Uint8Array, reg: Registry = registry): DecodedMessage[] {
  return decodeMsgResponsesWith(data, reg);
}

/** Decodes one packed message; one whose type the registry lacks is named as unknown. */
export function decodeMessage(any: Any, options: TxDecodeOptions = {}): DecodedMessage {
  return decodeMessageWith(any, withRegistry(options));
}

/** The decoded messages of a transaction a query returned already parsed. */
export function decodeTxMessages(tx: Tx, options: TxDecodeOptions = {}): DecodedMessage[] {
  return decodeTxMessagesWith(tx, withRegistry(options));
}

/** Decodes raw transaction bytes as a node returns them. */
export function decodeTx(bytes: Uint8Array, options: TxDecodeOptions = {}): DecodedTx {
  return decodeTxWith(bytes, withRegistry(options));
}

/** Decodes one event; an event that is not a typed proto event keeps its attributes and has no `typed`. */
export function decodeEvent(event: ChainEvent, options: EventDecodeOptions = {}): DecodedEvent {
  return decodeEventWith(event, withRegistry(options));
}

export function decodeEvents(events: readonly ChainEvent[], options: EventDecodeOptions = {}): DecodedEvent[] {
  return decodeEventsWith(events, withRegistry(options));
}

/** Builds the decoded view of one committed transaction. */
export function foundTx(response: TxResponse, tx: Tx | undefined, reg: Registry = registry): FoundTx {
  return foundTxWith(response, tx, reg);
}

/** Builds and signs a transaction for one signer; amino mode encodes the messages through the registry. */
export function signTx(input: SignTxInput): Promise<SignedTx> {
  return signTxWith(withRegistry(input));
}

/** The gateway client, resolving Any fields against every generated type unless given a registry. */
export class GatewayClient extends CoreGatewayClient {
  constructor(baseUrl: string | readonly string[], options: GatewayOptions = {}) {
    super(baseUrl, withRegistry(options));
  }
}

/** The query client, resolving Any fields against every generated type unless given a registry. */
export class QueryClient extends CoreQueryClient {
  constructor(restUrl: string | readonly string[], options: GatewayOptions = {}) {
    super(restUrl, withRegistry(options));
  }

  /** A client over the network's REST endpoints, in the registry's order, moving on when one cannot answer. */
  static override forNetwork(network: Network, options: GatewayOptions = {}): QueryClient {
    return new QueryClient(restEndpoints(network), options);
  }
}

function withRegistry<T extends RegistryOption>(options: T): T & { registry: Registry } {
  return { ...options, registry: options.registry ?? registry };
}

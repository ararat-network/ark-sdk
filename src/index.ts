// The main entry: everything the core entry exports, with the registry
// defaulted to every generated type wherever the core takes one as an
// argument. A name listed below replaces the core's export of the same name.
// src/core.ts holds the list of every public name. Generated types are
// importable under ./gen/*.

export { registry } from "./codec/registry.js";
export * from "./core.js";
export {
  type AminoOptions,
  aminoEncode,
  aminoEncodeAny,
  decodeAccount,
  decodeEvent,
  decodeEvents,
  decodeMessage,
  decodeMsgResponses,
  decodeTx,
  decodeTxMessages,
  type EventDecodeOptions,
  type FromProtoJsonOptions,
  foundTx,
  fromProtoJson,
  GatewayClient,
  type GatewayOptions,
  makeAminoSignDoc,
  QueryClient,
  signTx,
  type ToProtoJsonOptions,
  type TxDecodeOptions,
  toProtoJson,
  unpackAny,
} from "./defaults.js";

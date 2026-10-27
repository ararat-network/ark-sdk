// The responses the messages of a committed transaction returned, packed in
// the result's data as TxMsgData. A market sell's output or a proposal's ID
// comes back here, typed, beside the events.
import { fromBinary, type Registry } from "@bufbuild/protobuf";

import { fromHex } from "../codec/bytes.js";
import { registry as defaultRegistry } from "../codec/registry.js";
import { TxMsgDataSchema } from "../gen/cosmos/base/abci/v1beta1/abci_pb.js";
import { type DecodedMessage, decodeMessage } from "./tx.js";

/** Decodes a result's data, hex as the gateway returns it or raw bytes, into one response per message. */
export function decodeMsgResponses(data: string | Uint8Array, registry: Registry = defaultRegistry): DecodedMessage[] {
  if (typeof data === "string" && data === "") return [];
  const bytes = typeof data === "string" ? fromHex(data) : data;
  if (bytes.length === 0) return [];
  return fromBinary(TxMsgDataSchema, bytes).msgResponses.map((m) => decodeMessage(m, { registry }));
}

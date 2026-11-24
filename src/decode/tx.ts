// Decoding a transaction the way every Ark reader must: the typed messages
// through the registry, and the JSON view in the chain's own dialect, which
// the fixtures pin. An unknown message stays an Any, named as unknown and
// never given a reassuring label.
import { create, type DescMessage, fromBinary, type Message, type Registry } from "@bufbuild/protobuf";
import { type Any, AnySchema } from "@bufbuild/protobuf/wkt";
import { requireRegistry, unknownAnyJson, unpackAny, type WithRegistry } from "../codec/any.js";
import { txHash } from "../codec/hash.js";
import { isJsonObject, type JsonValue } from "../codec/json.js";
import { anyJson, toProtoJson } from "../codec/protojson.js";
import type { SignMode } from "../gen/cosmos/tx/signing/v1beta1/signing_pb.js";
import { type AuthInfo, AuthInfoSchema, type Fee, type Tx, type TxBody, TxBodySchema, TxRawSchema, TxSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";

export type TxDecodeOptions = WithRegistry;

export interface DecodedMessage {
  typeUrl: string;
  /** The schema the registry knows for this type, or undefined for an unknown message. */
  schema: DescMessage | undefined;
  /** The decoded message, or undefined for an unknown message. */
  message: Message | undefined;
  known: boolean;
  /** The chain's JSON view; for an unknown message, its type URL and raw bytes, or the JSON the node rendered when it was read through the gateway. */
  json: JsonValue;
}

export interface DecodedSigner {
  publicKey: Any | undefined;
  sequence: bigint;
  /** The sign mode of a single signer; undefined for a multisig's bit array. */
  mode: SignMode | undefined;
}

export interface DecodedTx {
  bytes: Uint8Array;
  /** SHA-256 of the bytes, uppercase hex. */
  hash: string;
  tx: Tx;
  body: TxBody;
  authInfo: AuthInfo;
  messages: DecodedMessage[];
  memo: string;
  fee: Fee | undefined;
  signers: DecodedSigner[];
  signatures: Uint8Array[];
  /** The whole transaction in the chain's JSON dialect, as the gateway and the fixtures render it. */
  json: JsonValue;
}

export function decodeMessage(any: Any, options: TxDecodeOptions): DecodedMessage {
  return decodePacked(any, requireRegistry(options?.registry, "decodeMessage"), undefined);
}

/**
 * Decodes one packed message. `rendered` is its JSON when the caller has it
 * already, from rendering the transaction that holds it, so the message is
 * not rendered a second time.
 */
function decodePacked(any: Any, registry: Registry, rendered: JsonValue | undefined): DecodedMessage {
  // Read through the gateway without its type: there are no bytes to decode, only the node's JSON.
  const held = unknownAnyJson(any);
  if (held) return { typeUrl: any.typeUrl, schema: undefined, message: undefined, known: false, json: held };
  const unpacked = unpackAny(any, registry);
  if (!unpacked) {
    const json = rendered ?? toProtoJson(AnySchema, any, { registry, unknownAny: "raw" });
    return { typeUrl: any.typeUrl, schema: undefined, message: undefined, known: false, json };
  }
  const { schema, message } = unpacked;
  const json = rendered ?? anyJson(any.typeUrl, toProtoJson(schema, message, { registry, unknownAny: "raw" }));
  return { typeUrl: any.typeUrl, schema, message, known: true, json };
}

/** The messages' JSON out of a rendered transaction, in order. */
function renderedMessages(txJson: JsonValue): JsonValue[] {
  const body = isJsonObject(txJson) ? txJson.body : undefined;
  const messages = isJsonObject(body) ? body.messages : undefined;
  return Array.isArray(messages) ? messages : [];
}

/** The decoded messages of a transaction a query returned already parsed. */
export function decodeTxMessages(tx: Tx, options: TxDecodeOptions): DecodedMessage[] {
  const registry = requireRegistry(options?.registry, "decodeTxMessages");
  return (tx.body?.messages ?? []).map((m) => decodeMessage(m, { registry }));
}

/** Decodes raw transaction bytes as a node returns them. */
export function decodeTx(bytes: Uint8Array, options: TxDecodeOptions): DecodedTx {
  const registry = requireRegistry(options?.registry, "decodeTx");
  const raw = fromBinary(TxRawSchema, bytes);
  const body = fromBinary(TxBodySchema, raw.bodyBytes);
  const authInfo = fromBinary(AuthInfoSchema, raw.authInfoBytes);
  const tx = create(TxSchema, { body, authInfo, signatures: raw.signatures });
  // Rendered once: each message's JSON is taken from the transaction's, not rendered again from its bytes.
  const json = toProtoJson(TxSchema, tx, { registry, unknownAny: "raw" });
  const rendered = renderedMessages(json);
  return {
    bytes,
    hash: txHash(bytes),
    tx,
    body,
    authInfo,
    messages: body.messages.map((m, i) => decodePacked(m, registry, rendered[i])),
    memo: body.memo,
    fee: authInfo.fee,
    signers: authInfo.signerInfos.map((s) => ({
      publicKey: s.publicKey,
      sequence: s.sequence,
      mode: s.modeInfo?.sum.case === "single" ? s.modeInfo.sum.value.mode : undefined,
    })),
    signatures: raw.signatures,
    json,
  };
}

// Decoding a transaction the way every Ark reader must: the typed messages
// through the registry, and the JSON view in the chain's own dialect, which
// the fixtures pin. An unknown message stays an Any, named as unknown and
// never given a reassuring label.
import { fromBinary, type DescMessage, type Message, type Registry } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { typeNameOf } from "../codec/any.js";
import type { JsonValue } from "../codec/json.js";
import { toProtoJson } from "../codec/protojson.js";
import { registry as defaultRegistry } from "../codec/registry.js";
import { AuthInfoSchema, TxBodySchema, TxRawSchema, TxSchema, type AuthInfo, type Fee, type Tx, type TxBody } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { SignMode } from "../gen/cosmos/tx/signing/v1beta1/signing_pb.js";
import { txHash } from "../tx/signdoc.js";
import { create } from "@bufbuild/protobuf";

export interface TxDecodeOptions {
  registry?: Registry;
}

export interface DecodedMessage {
  typeUrl: string;
  /** The schema the registry knows for this type, or undefined for an unknown message. */
  schema: DescMessage | undefined;
  /** The decoded message, or undefined for an unknown message. */
  message: Message | undefined;
  known: boolean;
  /** The chain's JSON view; for an unknown message, its type URL and raw bytes. */
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

export function decodeMessage(any: Any, options: TxDecodeOptions = {}): DecodedMessage {
  const registry = options.registry ?? defaultRegistry;
  const schema = registry.getMessage(typeNameOf(any.typeUrl));
  if (!schema) {
    return { typeUrl: any.typeUrl, schema: undefined, message: undefined, known: false, json: toProtoJson(AnySchemaRef, any, { registry, unknownAny: "raw" }) };
  }
  const message = fromBinary(schema, any.value);
  return { typeUrl: any.typeUrl, schema, message, known: true, json: { "@type": any.typeUrl, ...(toProtoJson(schema, message, { registry, unknownAny: "raw" }) as object) } };
}

import { AnySchema as AnySchemaRef } from "@bufbuild/protobuf/wkt";

/** The decoded messages of a transaction a query returned already parsed. */
export function decodeTxMessages(tx: Tx, options: TxDecodeOptions = {}): DecodedMessage[] {
  return (tx.body?.messages ?? []).map((m) => decodeMessage(m, options));
}

/** Decodes raw transaction bytes as a node returns them. */
export function decodeTx(bytes: Uint8Array, options: TxDecodeOptions = {}): DecodedTx {
  const registry = options.registry ?? defaultRegistry;
  const raw = fromBinary(TxRawSchema, bytes);
  const body = fromBinary(TxBodySchema, raw.bodyBytes);
  const authInfo = fromBinary(AuthInfoSchema, raw.authInfoBytes);
  const tx = create(TxSchema, { body, authInfo, signatures: raw.signatures });
  return {
    bytes,
    hash: txHash(bytes),
    tx,
    body,
    authInfo,
    messages: body.messages.map((m) => decodeMessage(m, { registry })),
    memo: body.memo,
    fee: authInfo.fee,
    signers: authInfo.signerInfos.map((s) => ({
      publicKey: s.publicKey,
      sequence: s.sequence,
      mode: s.modeInfo?.sum.case === "single" ? s.modeInfo.sum.value.mode : undefined,
    })),
    signatures: raw.signatures,
    json: toProtoJson(TxSchema, tx, { registry, unknownAny: "raw" }),
  };
}

// Sign documents and the raw transaction. SIGN_MODE_DIRECT signs the protobuf
// SignDoc over the body and auth-info bytes; the amino document for the Ledger
// path is built by the codec. The hash is SHA-256 of the raw bytes, upper hex,
// as a node reports it.
import { create, toBinary } from "@bufbuild/protobuf";
import { sha256 } from "@noble/hashes/sha2.js";

import { toHex } from "../codec/bytes.js";
import { type AuthInfo, AuthInfoSchema, type SignDoc, SignDocSchema, type TxBody, TxBodySchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";

export function encodeTxBody(body: TxBody): Uint8Array {
  return toBinary(TxBodySchema, body);
}

export function encodeAuthInfo(authInfo: AuthInfo): Uint8Array {
  return toBinary(AuthInfoSchema, authInfo);
}

export interface SignDocInput {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: bigint;
}

export function makeSignDoc(input: SignDocInput): SignDoc {
  return create(SignDocSchema, input);
}

/** The bytes a direct signer signs: the serialised SignDoc. */
export function directSignBytes(signDoc: SignDoc): Uint8Array {
  return toBinary(SignDocSchema, signDoc);
}

export interface TxRawInput {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signatures: readonly Uint8Array[];
}

/** The transaction as broadcast: body, auth info, and signatures. */
export function encodeTxRaw(input: TxRawInput): Uint8Array {
  return toBinary(TxRawSchema, create(TxRawSchema, { bodyBytes: input.bodyBytes, authInfoBytes: input.authInfoBytes, signatures: [...input.signatures] }));
}

/** SHA-256 of the raw transaction, uppercase hex, as a node reports it. */
export function txHash(txBytes: Uint8Array): string {
  return toHex(sha256(txBytes)).toUpperCase();
}

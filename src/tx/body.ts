// The parts of a transaction: the body with its messages, the signer info,
// the fee, and the auth info. Messages are packed under their Cosmos type
// URL after the gogo pass, so the bytes are what the chain itself would write.
import { create, type DescMessage, isMessage, type MessageShape } from "@bufbuild/protobuf";
import { type Any, AnySchema, type Timestamp } from "@bufbuild/protobuf/wkt";

import { packAny, UnknownTypeError, unknownAnyJson } from "../codec/any.js";
import { type CoinInput, coins } from "../codec/coins.js";
import { materialise } from "../codec/gogo.js";
import { SignMode } from "../gen/cosmos/tx/signing/v1beta1/signing_pb.js";
import {
  type AuthInfo,
  AuthInfoSchema,
  type Fee,
  FeeSchema,
  ModeInfo_SingleSchema,
  ModeInfoSchema,
  type SignerInfo,
  SignerInfoSchema,
  type TxBody,
  TxBodySchema,
} from "../gen/cosmos/tx/v1beta1/tx_pb.js";

/** A message with the schema that encodes it. */
export interface Typed<Desc extends DescMessage = DescMessage> {
  schema: Desc;
  message: MessageShape<Desc>;
}

export type TxMessage = Any | Typed;

export function typed<Desc extends DescMessage>(schema: Desc, message: MessageShape<Desc>): Typed<Desc> {
  return { schema, message };
}

/**
 * Packs each message under its type URL; an Any passes through. One that was
 * read from a node without its type is refused: it holds no bytes, and
 * signing it would sign an empty message under that type. So is a message
 * that holds one, which packAny refuses.
 */
export function packMessages(messages: readonly TxMessage[]): Any[] {
  return messages.map((m) => {
    if (!isMessage(m, AnySchema)) return packAny(m.schema, materialise(m.schema, m.message));
    if (unknownAnyJson(m))
      throw new UnknownTypeError(m.typeUrl, `message ${m.typeUrl} was read without its type and holds no bytes; it cannot be put in a transaction`);
    return m;
  });
}

export interface TxBodyInput {
  messages: readonly TxMessage[];
  memo?: string;
  timeoutHeight?: bigint;
  timeoutTimestamp?: Timestamp;
  /** An unordered transaction, valid until its timeout timestamp in place of a sequence: the chain refuses one whose sequence is not zero. */
  unordered?: boolean;
}

export function makeTxBody(input: TxBodyInput): TxBody {
  return create(TxBodySchema, {
    messages: packMessages(input.messages),
    memo: input.memo ?? "",
    timeoutHeight: input.timeoutHeight ?? 0n,
    timeoutTimestamp: input.timeoutTimestamp,
    unordered: input.unordered ?? false,
  });
}

export interface FeeInput {
  /** The declared legs, in the order they are encoded: the ante walks them in this order to pick the paying leg. */
  amount: readonly CoinInput[];
  gasLimit: bigint;
  payer?: string;
  granter?: string;
}

export function makeFee(input: FeeInput): Fee {
  return create(FeeSchema, { amount: coins(input.amount), gasLimit: input.gasLimit, payer: input.payer ?? "", granter: input.granter ?? "" });
}

export function makeSignerInfo(publicKey: Any, sequence: bigint, mode: SignMode): SignerInfo {
  return create(SignerInfoSchema, {
    publicKey,
    modeInfo: create(ModeInfoSchema, { sum: { case: "single", value: create(ModeInfo_SingleSchema, { mode }) } }),
    sequence,
  });
}

export function makeAuthInfo(signerInfos: readonly SignerInfo[], fee: Fee): AuthInfo {
  return create(AuthInfoSchema, { signerInfos: [...signerInfos], fee });
}

export { SignMode };

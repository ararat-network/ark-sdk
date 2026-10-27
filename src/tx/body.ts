// The parts of a transaction: the body with its messages, the signer info,
// the fee, and the auth info. Messages are packed under their Cosmos type
// URL after the gogo pass, so the bytes are what the chain itself would write.
import { create, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import type { Any, Timestamp } from "@bufbuild/protobuf/wkt";

import { packAny } from "../codec/any.js";
import { materialise } from "../codec/gogo.js";
import { type Coin, CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
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

function isAny(m: TxMessage): m is Any {
  return (m as Any).$typeName === "google.protobuf.Any";
}

/** Packs each message under its type URL; an Any passes through. */
export function packMessages(messages: readonly TxMessage[]): Any[] {
  return messages.map((m) => (isAny(m) ? m : packAny(m.schema, materialise(m.schema, m.message))));
}

export interface TxBodyInput {
  messages: readonly TxMessage[];
  memo?: string;
  timeoutHeight?: bigint;
  timeoutTimestamp?: Timestamp;
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

export interface CoinInput {
  denom: string;
  amount: bigint | string;
}

export function coin(denom: string, amount: bigint | string): Coin {
  return create(CoinSchema, { denom, amount: amount.toString() });
}

export function coins(inputs: readonly CoinInput[]): Coin[] {
  return inputs.map((c) => coin(c.denom, c.amount));
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

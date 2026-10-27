// Building and signing a transaction. The builder assembles body, auth info,
// and the sign document for the chosen mode, hands the document to the
// signer, and refuses to continue if the signer returns a different one, since
// the broadcast bytes must be the signed bytes. Direct mode is refused for a
// multisig key: its sign document binds one public key and sequence, which a
// multisig account does not have as one.
import { toBinary } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { type AminoSignDoc, aminoSignDocBytes, makeAminoSignDoc } from "../codec/aminojson.js";
import { bytesEqual } from "../codec/bytes.js";
import { type Fee, type SignDoc, SignDocSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MULTISIG_PUBLIC_KEY_URL, type Signer, SignerError } from "../keys/signer.js";
import { makeAuthInfo, makeFee, makeSignerInfo, makeTxBody, SignMode, type TxMessage } from "./body.js";
import type { FeeQuote } from "./fee.js";
import { directSignBytes, encodeAuthInfo, encodeTxBody, encodeTxRaw, makeSignDoc, txHash } from "./signdoc.js";

export type SigningMode = "direct" | "amino";

export class MultisigNeedsAmino extends SignerError {
  override readonly name: string = "MultisigNeedsAmino";
  constructor() {
    super("a multisig account cannot sign in SIGN_MODE_DIRECT; its signers sign in amino JSON and their signatures are combined");
  }
}

export class SignerAlteredDocument extends SignerError {
  override readonly name: string = "SignerAlteredDocument";
  constructor() {
    super("the signer returned a different sign document than it was given; the transaction was not built");
  }
}

export interface SignTxInput {
  signer: Signer;
  address: string;
  chainId: string;
  accountNumber: bigint;
  sequence: bigint;
  messages: readonly TxMessage[];
  memo?: string;
  timeoutHeight?: bigint;
  /** The declared fee, a ceiling; see fee.ts for how it is priced. */
  fee: Fee;
  /** direct by default; amino for a Ledger. */
  mode?: SigningMode;
}

export interface SignedTx {
  /** The raw transaction to broadcast. */
  txBytes: Uint8Array;
  /** SHA-256 of txBytes, uppercase hex: the hash a node reports. */
  hash: string;
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signature: Uint8Array;
  mode: SigningMode;
  /** The document signed in direct mode. */
  signDoc: SignDoc | undefined;
  /** The document signed in amino mode. */
  aminoSignDoc: AminoSignDoc | undefined;
}

/** Builds and signs a transaction for one signer. */
export async function signTx(input: SignTxInput): Promise<SignedTx> {
  const mode = input.mode ?? "direct";
  const account = (await input.signer.accounts()).find((a) => a.address === input.address);
  if (!account) throw new SignerError(`signer holds no account ${input.address}`);
  checkKeyForMode(account.publicKey, mode);

  const body = makeTxBody({ messages: input.messages, memo: input.memo, timeoutHeight: input.timeoutHeight });
  const bodyBytes = encodeTxBody(body);
  const signMode = mode === "direct" ? SignMode.DIRECT : SignMode.LEGACY_AMINO_JSON;
  const authInfo = makeAuthInfo([makeSignerInfo(account.publicKey, input.sequence, signMode)], input.fee);
  const authInfoBytes = encodeAuthInfo(authInfo);

  let signature: Uint8Array;
  let signDoc: SignDoc | undefined;
  let aminoSignDoc: AminoSignDoc | undefined;
  if (mode === "direct") {
    signDoc = makeSignDoc({ bodyBytes, authInfoBytes, chainId: input.chainId, accountNumber: input.accountNumber });
    const signed = await input.signer.signDirect(input.address, signDoc);
    if (!bytesEqual(toBinary(SignDocSchema, signed.signDoc), directSignBytes(signDoc))) throw new SignerAlteredDocument();
    signature = signed.signature;
  } else {
    aminoSignDoc = makeAminoSignDoc({ body, fee: input.fee, chainId: input.chainId, accountNumber: input.accountNumber, sequence: input.sequence });
    const signed = await input.signer.signAmino(input.address, aminoSignDoc);
    if (!bytesEqual(aminoSignDocBytes(signed.signDoc), aminoSignDocBytes(aminoSignDoc))) throw new SignerAlteredDocument();
    signature = signed.signature;
  }
  const txBytes = encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [signature] });
  return { txBytes, hash: txHash(txBytes), bodyBytes, authInfoBytes, signature, mode, signDoc, aminoSignDoc };
}

function checkKeyForMode(publicKey: Any, mode: SigningMode): void {
  if (publicKey.typeUrl !== MULTISIG_PUBLIC_KEY_URL) return;
  if (mode === "direct") throw new MultisigNeedsAmino();
  throw new SignerError("multisig signing, with its bit array mode info and combined signature, is not built here yet");
}

export interface SimulationTxInput {
  messages: readonly TxMessage[];
  memo?: string;
  publicKey: Any;
  sequence: bigint;
  /** A fee to meter the transfer under, or none: the ante then charges its fee-transfer allowance instead. */
  fee?: Fee;
}

/** An unsigned transaction for Simulate: the real body and signer info with an empty signature. */
export function simulationTxBytes(input: SimulationTxInput): Uint8Array {
  const body = makeTxBody({ messages: input.messages, memo: input.memo });
  const fee = input.fee ?? makeFee({ amount: [], gasLimit: 0n });
  const authInfo = makeAuthInfo([makeSignerInfo(input.publicKey, input.sequence, SignMode.DIRECT)], fee);
  return encodeTxRaw({ bodyBytes: encodeTxBody(body), authInfoBytes: encodeAuthInfo(authInfo), signatures: [new Uint8Array()] });
}

/** The fee a quote declares, as the Fee message a transaction carries. */
export function feeFromQuote(quote: FeeQuote, options: { payer?: string; granter?: string } = {}): Fee {
  return makeFee({
    amount: quote.declared.map((c) => ({ denom: c.denom, amount: c.amount })),
    gasLimit: quote.gasLimit,
    payer: options.payer,
    granter: options.granter,
  });
}

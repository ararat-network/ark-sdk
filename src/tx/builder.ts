// Building and signing a transaction. The builder assembles body, auth info,
// and the sign document for the chosen mode, hands the document to the
// signer, and refuses to continue if the signer returns a different one, since
// the broadcast bytes must be the signed bytes. Direct mode is refused for a
// multisig key: its sign document binds one public key and sequence, which a
// multisig account does not have as one.
import { toBinary } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { type AminoSignDoc, aminoSignDocBytes, makeAminoSignDoc } from "../codec/aminojson.js";
import type { RegistryOption } from "../codec/any.js";
import { bytesEqual } from "../codec/bytes.js";
import { txHash } from "../codec/hash.js";
import { SignMode } from "../gen/cosmos/tx/signing/v1beta1/signing_pb.js";
import { type Fee, type SignDoc, SignDocSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MULTISIG_PUBLIC_KEY_URL, type Signer, type SignerAccount, SignerError, signerAccountFor } from "../keys/signer.js";
import { type FeeInput, makeAuthInfo, makeFee, makeSignerInfo, makeTxBody, type TxBodyInput } from "./body.js";
import type { FeeQuote } from "./fee.js";
import { directSignBytes, encodeAuthInfo, encodeTxBody, encodeTxRaw, makeSignDoc } from "./signdoc.js";

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

/**
 * A transaction ready to sign: the body's members, and whose it is at what
 * account number, sequence, and fee. prepareTx makes one with the fee the
 * chain's figures price; a caller that already holds every figure writes one
 * out. `registry` is the types the amino encoder resolves the messages
 * against: amino mode needs it, direct mode does not read it.
 */
export interface UnsignedTx extends TxBodyInput, RegistryOption {
  address: string;
  /** The signer's account for `address`, when the caller already holds it; the signer is asked for its accounts otherwise. */
  signerAccount?: SignerAccount;
  chainId: string;
  accountNumber: bigint;
  sequence: bigint;
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
  /** The body's timeout height, when it has one: what a wait for its block reads to say it expired. */
  timeoutHeight: bigint | undefined;
}

/**
 * Builds the transaction and has one signer sign it, as it stands and with no
 * request to a node: the fee signed is the fee it carries.
 */
export async function signTx(input: UnsignedTx, signer: Signer): Promise<SignedTx> {
  const mode = input.mode ?? "direct";
  const account = input.signerAccount ?? signerAccountFor(await signer.accounts(), input.address);
  if (account.address !== input.address) throw new SignerError(`the signer account given is ${account.address}, not ${input.address}`);
  checkKeyForMode(account.publicKey, mode);

  const body = makeTxBody(input);
  const bodyBytes = encodeTxBody(body);
  const signMode = mode === "direct" ? SignMode.DIRECT : SignMode.LEGACY_AMINO_JSON;
  const authInfo = makeAuthInfo([makeSignerInfo(account.publicKey, input.sequence, signMode)], input.fee);
  const authInfoBytes = encodeAuthInfo(authInfo);

  let signature: Uint8Array;
  let signDoc: SignDoc | undefined;
  let aminoSignDoc: AminoSignDoc | undefined;
  if (mode === "direct") {
    signDoc = makeSignDoc({ bodyBytes, authInfoBytes, chainId: input.chainId, accountNumber: input.accountNumber });
    const signed = await signer.signDirect(input.address, signDoc);
    if (!bytesEqual(toBinary(SignDocSchema, signed.signDoc), directSignBytes(signDoc))) throw new SignerAlteredDocument();
    signature = signed.signature;
  } else {
    if (!input.registry) throw new SignerError("signing in amino mode needs a registry: the types the amino encoder resolves the messages against");
    aminoSignDoc = makeAminoSignDoc(
      { body, fee: input.fee, chainId: input.chainId, accountNumber: input.accountNumber, sequence: input.sequence },
      { registry: input.registry },
    );
    const signed = await signer.signAmino(input.address, aminoSignDoc);
    if (!bytesEqual(aminoSignDocBytes(signed.signDoc), aminoSignDocBytes(aminoSignDoc))) throw new SignerAlteredDocument();
    signature = signed.signature;
  }
  const txBytes = encodeTxRaw({ bodyBytes, authInfoBytes, signatures: [signature] });
  return { txBytes, hash: txHash(txBytes), bodyBytes, authInfoBytes, signature, mode, signDoc, aminoSignDoc, timeoutHeight: input.timeoutHeight };
}

function checkKeyForMode(publicKey: Any, mode: SigningMode): void {
  if (publicKey.typeUrl !== MULTISIG_PUBLIC_KEY_URL) return;
  if (mode === "direct") throw new MultisigNeedsAmino();
  throw new SignerError("multisig signing, with its bit array mode info and combined signature, is not built here yet");
}

export interface SimulationTxInput extends TxBodyInput {
  publicKey: Any;
  sequence: bigint;
  /** A fee to meter the transfer under, or none: the ante then charges its fee-transfer allowance instead. */
  fee?: Fee;
}

/** An unsigned transaction for Simulate: the real body and signer info with an empty signature. */
export function simulationTxBytes(input: SimulationTxInput): Uint8Array {
  const body = makeTxBody(input);
  const fee = input.fee ?? makeFee({ amount: [], gasLimit: 0n });
  const authInfo = makeAuthInfo([makeSignerInfo(input.publicKey, input.sequence, SignMode.DIRECT)], fee);
  return encodeTxRaw({ bodyBytes: encodeTxBody(body), authInfoBytes: encodeAuthInfo(authInfo), signatures: [new Uint8Array()] });
}

/** The fee a quote declares, as the Fee message a transaction carries. */
export function feeFromQuote(quote: FeeQuote, options: Pick<FeeInput, "payer" | "granter"> = {}): Fee {
  return makeFee({
    amount: quote.declared.map((c) => ({ denom: c.denom, amount: c.amount })),
    gasLimit: quote.gasLimit,
    payer: options.payer,
    granter: options.granter,
  });
}

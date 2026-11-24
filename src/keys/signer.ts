// The signer interface: what the SDK asks of whatever holds a key. The SDK
// builds every document and never sees a private key; the app's signer
// package implements this for device keys and the Ledger, and the memory
// signer for tests.
import { create } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import type { AminoSignDoc } from "../codec/aminojson.js";
import { packAny } from "../codec/any.js";
import { ArkSdkError } from "../errors.js";
import { PubKeySchema } from "../gen/cosmos/crypto/secp256k1/keys_pb.js";
import type { SignDoc } from "../gen/cosmos/tx/v1beta1/tx_pb.js";

export const SECP256K1_PUBLIC_KEY_URL = "/cosmos.crypto.secp256k1.PubKey";
export const MULTISIG_PUBLIC_KEY_URL = "/cosmos.crypto.multisig.LegacyAminoPubKey";

/** Packs a compressed secp256k1 key as the Any a signer info carries; what a signer returns for each of its accounts. */
export function secp256k1PublicKey(key: Uint8Array): Any {
  return packAny(PubKeySchema, create(PubKeySchema, { key }));
}

export interface SignerAccount {
  readonly address: string;
  /** The packed public key, as it is placed in a transaction's signer info. */
  readonly publicKey: Any;
}

export interface DirectSignature {
  /** The document that was signed; a signer may not alter it. */
  readonly signDoc: SignDoc;
  readonly signature: Uint8Array;
}

export interface AminoSignature {
  /** The document that was signed; the builder refuses one the wallet altered. */
  readonly signDoc: AminoSignDoc;
  readonly signature: Uint8Array;
}

export interface Signer {
  /** The accounts this signer can sign for. */
  accounts(): Promise<readonly SignerAccount[]>;
  /** SIGN_MODE_DIRECT: a signature over the protobuf SignDoc. */
  signDirect(address: string, signDoc: SignDoc): Promise<DirectSignature>;
  /** SIGN_MODE_LEGACY_AMINO_JSON: a signature over the sorted JSON sign document, the Ledger path. */
  signAmino(address: string, signDoc: AminoSignDoc): Promise<AminoSignature>;
}

export class SignerError extends ArkSdkError {
  override readonly name: string = "SignerError";
}

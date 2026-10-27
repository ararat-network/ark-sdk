// The signer interface: what the SDK asks of whatever holds a key. The SDK
// builds every document and never sees a private key; the app's signer
// package implements this for device keys and the Ledger, and the memory
// signer for tests.
import type { Any } from "@bufbuild/protobuf/wkt";

import type { AminoSignDoc } from "../codec/aminojson.js";
import type { SignDoc } from "../gen/cosmos/tx/v1beta1/tx_pb.js";

export const SECP256K1_PUBLIC_KEY_URL = "/cosmos.crypto.secp256k1.PubKey";
export const MULTISIG_PUBLIC_KEY_URL = "/cosmos.crypto.multisig.LegacyAminoPubKey";

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

export interface ArbitrarySignature {
  readonly signature: Uint8Array;
  readonly publicKey: Any;
}

export interface Signer {
  /** The accounts this signer can sign for. */
  accounts(): Promise<readonly SignerAccount[]>;
  /** SIGN_MODE_DIRECT: a signature over the protobuf SignDoc. */
  signDirect(address: string, signDoc: SignDoc): Promise<DirectSignature>;
  /** SIGN_MODE_LEGACY_AMINO_JSON: a signature over the sorted JSON sign document, the Ledger path. */
  signAmino(address: string, signDoc: AminoSignDoc): Promise<AminoSignature>;
  /** ADR-036: a signature over the sign bytes for `data` by this address. */
  signArbitrary(address: string, data: Uint8Array): Promise<ArbitrarySignature>;
}

export class SignerError extends Error {
  override readonly name: string = "SignerError";
}

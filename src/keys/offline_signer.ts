// An adapter from the OfflineSigner shape CosmJS defines and Keplr and Leap
// implement to the SDK's Signer, so an external wallet signs through the same
// interface as the app's signer. The shape is declared structurally; nothing
// from CosmJS is imported.
import { create } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import type { AminoSignDoc } from "../codec/aminojson.js";
import { packAny } from "../codec/any.js";
import { bytesEqual, fromBase64 } from "../codec/bytes.js";
import { PubKeySchema } from "../gen/cosmos/crypto/secp256k1/keys_pb.js";
import { type SignDoc, SignDocSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { type AminoSignature, type ArbitrarySignature, type DirectSignature, type Signer, type SignerAccount, SignerError } from "./signer.js";

export interface OfflineAccount {
  readonly address: string;
  readonly algo: string;
  readonly pubkey: Uint8Array;
}

export interface OfflineDirectSignDoc {
  readonly bodyBytes: Uint8Array;
  readonly authInfoBytes: Uint8Array;
  readonly chainId: string;
  /** bigint in current cosmjs-types; a Long or a string in older ones; null from a wallet that dropped it. */
  readonly accountNumber: bigint | number | string | { toString(): string } | null;
}

/** CosmJS's StdSignature: the key and signature in standard base64. */
export interface OfflineStdSignature {
  readonly pub_key: { readonly type: string; readonly value: string };
  readonly signature: string;
}

export interface OfflineSignerLike {
  getAccounts(): Promise<readonly OfflineAccount[]>;
  signDirect?(signerAddress: string, signDoc: OfflineDirectSignDoc): Promise<{ signed: OfflineDirectSignDoc; signature: OfflineStdSignature }>;
  signAmino?(signerAddress: string, signDoc: AminoSignDoc): Promise<{ signed: AminoSignDoc; signature: OfflineStdSignature }>;
}

/** Keplr's and Leap's ADR-036 call. */
export interface ArbitrarySignerLike {
  signArbitrary(chainId: string, signer: string, data: string | Uint8Array): Promise<OfflineStdSignature>;
}

export interface OfflineSignerOptions {
  /** The chain the wallet is connected to; signArbitrary needs it. */
  chainId?: string;
  /** The wallet's ADR-036 surface; signArbitrary is refused without it. */
  arbitrary?: ArbitrarySignerLike;
}

const SECP256K1_ALGO = "secp256k1";
const SECP256K1_AMINO_TYPE = "tendermint/PubKeySecp256k1";

/** Wraps an OfflineSigner as a Signer. Accounts of another key algorithm are left out. */
export function fromOfflineSigner(offline: OfflineSignerLike, options: OfflineSignerOptions = {}): Signer {
  return {
    async accounts(): Promise<readonly SignerAccount[]> {
      return (await offline.getAccounts()).filter((a) => a.algo === SECP256K1_ALGO).map((a) => ({ address: a.address, publicKey: secp256k1Any(a.pubkey) }));
    },
    async signDirect(address: string, signDoc: SignDoc): Promise<DirectSignature> {
      if (!offline.signDirect) throw new SignerError("the wallet signs in amino only; sign with mode amino");
      const { signed, signature } = await offline.signDirect(address, {
        bodyBytes: signDoc.bodyBytes,
        authInfoBytes: signDoc.authInfoBytes,
        chainId: signDoc.chainId,
        accountNumber: signDoc.accountNumber,
      });
      if (signed.accountNumber === null || signed.accountNumber === undefined)
        throw new SignerError("the wallet returned a sign document without an account number");
      return {
        signDoc: create(SignDocSchema, {
          bodyBytes: signed.bodyBytes,
          authInfoBytes: signed.authInfoBytes,
          chainId: signed.chainId,
          accountNumber: BigInt(signed.accountNumber.toString()),
        }),
        signature: fromBase64(signature.signature),
      };
    },
    async signAmino(address: string, signDoc: AminoSignDoc): Promise<AminoSignature> {
      if (!offline.signAmino) throw new SignerError("the wallet signs in direct mode only; sign with mode direct");
      const { signed, signature } = await offline.signAmino(address, signDoc);
      return { signDoc: signed, signature: fromBase64(signature.signature) };
    },
    async signArbitrary(address: string, data: Uint8Array): Promise<ArbitrarySignature> {
      if (!options.arbitrary || !options.chainId) throw new SignerError("ADR-036 signing needs the wallet's signArbitrary and the chain ID");
      // Keplr and Leap show a string as text and bytes as base64, and sign the
      // same bytes either way; a signup document is printable ASCII, so the
      // member reads it. Data that is not UTF-8 goes as bytes.
      const signature = await options.arbitrary.signArbitrary(options.chainId, address, asText(data) ?? data);
      if (signature.pub_key.type !== SECP256K1_AMINO_TYPE)
        throw new SignerError(`ADR-036 needs a secp256k1 key, the wallet signed with ${signature.pub_key.type}`);
      return { signature: fromBase64(signature.signature), publicKey: secp256k1Any(fromBase64(signature.pub_key.value)) };
    },
  };
}

function secp256k1Any(key: Uint8Array): Any {
  return packAny(PubKeySchema, create(PubKeySchema, { key }));
}

/** The text whose UTF-8 encoding is exactly `data`, or undefined. */
function asText(data: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    return bytesEqual(new TextEncoder().encode(text), data) ? text : undefined;
  } catch {
    return undefined;
  }
}

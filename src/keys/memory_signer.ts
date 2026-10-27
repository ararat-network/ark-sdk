// A signer holding its key in memory, for tests, fixtures, and development
// against a localnet. Nothing in an app should use it: a real key lives in
// the app's signer package or a wallet, behind the same interface.
import { create, toBinary } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";

import { adr036SignBytes } from "../adr036/signbytes.js";
import { type AminoSignDoc, aminoSignDocBytes } from "../codec/aminojson.js";
import { packAny } from "../codec/any.js";
import { PubKeySchema } from "../gen/cosmos/crypto/secp256k1/keys_pb.js";
import { type SignDoc, SignDocSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { DEFAULT_PREFIX, publicKeyToAddress } from "./address.js";
import { type MnemonicOptions, privateKeyFromMnemonic } from "./hd.js";
import { publicKeyFromPrivate, randomPrivateKey, signMessage } from "./secp256k1.js";
import { type AminoSignature, type ArbitrarySignature, type DirectSignature, type Signer, type SignerAccount, SignerError } from "./signer.js";

/** Packs a compressed secp256k1 key as the Any a signer info carries. */
export function secp256k1PublicKey(key: Uint8Array): Any {
  return packAny(PubKeySchema, create(PubKeySchema, { key }));
}

export class MemorySigner implements Signer {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly #privateKey: Uint8Array;

  private constructor(privateKey: Uint8Array, prefix: string) {
    this.#privateKey = privateKey;
    this.publicKey = publicKeyFromPrivate(privateKey);
    this.address = publicKeyToAddress(this.publicKey, prefix);
  }

  static fromPrivateKey(privateKey: Uint8Array, prefix = DEFAULT_PREFIX): MemorySigner {
    return new MemorySigner(privateKey, prefix);
  }

  static fromMnemonic(mnemonic: string, options: MnemonicOptions & { prefix?: string } = {}): MemorySigner {
    return new MemorySigner(privateKeyFromMnemonic(mnemonic, options), options.prefix ?? DEFAULT_PREFIX);
  }

  static random(prefix = DEFAULT_PREFIX): MemorySigner {
    return new MemorySigner(randomPrivateKey(), prefix);
  }

  async accounts(): Promise<readonly SignerAccount[]> {
    return [{ address: this.address, publicKey: secp256k1PublicKey(this.publicKey) }];
  }

  async signDirect(address: string, signDoc: SignDoc): Promise<DirectSignature> {
    this.#check(address);
    return { signDoc, signature: signMessage(toBinary(SignDocSchema, signDoc), this.#privateKey) };
  }

  async signAmino(address: string, signDoc: AminoSignDoc): Promise<AminoSignature> {
    this.#check(address);
    return { signDoc, signature: signMessage(aminoSignDocBytes(signDoc), this.#privateKey) };
  }

  async signArbitrary(address: string, data: Uint8Array): Promise<ArbitrarySignature> {
    this.#check(address);
    return { signature: signMessage(adr036SignBytes(address, data), this.#privateKey), publicKey: secp256k1PublicKey(this.publicKey) };
  }

  #check(address: string): void {
    if (address !== this.address) throw new SignerError(`signer holds ${this.address}, not ${address}`);
  }
}

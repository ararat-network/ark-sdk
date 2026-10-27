// BIP-39 and BIP-32 derivation at Ark's coin type, 330. The path and the
// empty passphrase are the keyring's defaults, so a mnemonic from arkd derives
// the same key here.
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { KeyError } from "./secp256k1.js";

export const ARK_COIN_TYPE = 330;

export interface HdPathOptions {
  coinType?: number;
  account?: number;
  change?: number;
  index?: number;
}

/** The BIP-44 path m/44'/330'/account'/change/index. */
export function hdPath({ coinType = ARK_COIN_TYPE, account = 0, change = 0, index = 0 }: HdPathOptions = {}): string {
  return `m/44'/${coinType}'/${account}'/${change}/${index}`;
}

export interface MnemonicOptions {
  path?: string;
  passphrase?: string;
}

/** Whether a mnemonic is a valid English BIP-39 phrase. */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/** The private key at `path` (default m/44'/330'/0'/0/0) of a mnemonic. */
export function privateKeyFromMnemonic(mnemonic: string, { path = hdPath(), passphrase = "" }: MnemonicOptions = {}): Uint8Array {
  if (!isValidMnemonic(mnemonic)) throw new KeyError("invalid mnemonic");
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic, passphrase)).derive(path);
  if (!key.privateKey) throw new KeyError(`no private key at ${path}`);
  return key.privateKey;
}

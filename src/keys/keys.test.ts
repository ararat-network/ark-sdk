import assert from "node:assert/strict";
import { test } from "node:test";

import { fromBase64, fromHex, toBase64, toHex, utf8Encode } from "../codec/bytes.js";
import { fixtureKeys, signupVectors } from "../testing/fixtures.js";
import { AddressError, addressBytes, decodeAddress, encodeAddress, fromValidatorAddress, isAccountAddress, publicKeyToAddress, toValidatorAddress, validatorPrefix } from "./address.js";
import { hdPath, isValidMnemonic, privateKeyFromMnemonic } from "./hd.js";
import { isCompressedPublicKey, isLowS, publicKeyFromPrivate, signMessage, verifyMessage } from "./secp256k1.js";

test("fixture and vector keys derive their public keys and addresses", () => {
  const keys = [...fixtureKeys().accounts, ...signupVectors().keys];
  assert.ok(keys.length >= 11);
  for (const k of keys) {
    const pub = publicKeyFromPrivate(fromHex(k.private_key_hex));
    assert.equal(toBase64(pub), k.public_key, k.name);
    assert.equal(publicKeyToAddress(pub), k.address, k.name);
    assert.ok(isCompressedPublicKey(pub));
  }
});

test("the validator operator address is the account address under arkvaloper", () => {
  const keys = fixtureKeys();
  const validator = keys.accounts.find((a) => a.name === "validator");
  assert.ok(validator);
  assert.equal(toValidatorAddress(validator.address), keys.validator.operator);
  assert.equal(fromValidatorAddress(keys.validator.operator), validator.address);
  assert.throws(() => fromValidatorAddress(validator.address), AddressError, "an account address is not an operator address");
  assert.equal(validatorPrefix(), "arkvaloper");
  assert.equal(decodeAddress(keys.validator.operator, { prefix: "arkvaloper" }).bytes.length, 20);
});

test("decodeAddress accepts canonical addresses and refuses the rest", () => {
  const good = "ark10s999mwwwxzwd0hqg0s8xp67jxwhpu09g74u3s";
  assert.equal(decodeAddress(good, { prefix: "ark" }).bytes.length, 20);
  assert.ok(isAccountAddress(good));
  assert.equal(encodeAddress(decodeAddress(good).bytes), good);
  const contract = "ark14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s9drudu";
  assert.equal(decodeAddress(contract).bytes.length, 32);
  assert.equal(isAccountAddress(contract), false, "a contract is not an account address");
  const bad: [string, string][] = [
    ["uppercase", good.toUpperCase()],
    ["mixed case", "Ark10s999mwwwxzwd0hqg0s8xp67jxwhpu09g74u3s"],
    ["other prefix", "cosmos10s999mwwwxzwd0hqg0s8xp67jxwhpu09hwlyrh"],
    ["bad checksum", good.slice(0, -1) + "t"],
    ["not bech32", "not-an-address"],
  ];
  for (const [name, address] of bad) {
    assert.throws(() => decodeAddress(address, { prefix: "ark" }), AddressError, name);
    assert.equal(isAccountAddress(address), false, name);
  }
  assert.throws(() => addressBytes(new Uint8Array(32)), AddressError);
});

// Derived by the Cosmos SDK's own hd.Secp256k1 at m/44'/330'/0'/0/i with an
// empty passphrase, signing "ark sdk key vector" with secp256k1.PrivKey.Sign.
const hdVectors = [
  {
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    index: 0,
    privateKey: "05be413bb5bd1fb67757251976dd43adf0d4db27d1a5444b4f6ef754ef939b10",
    publicKey: "Aqy0vCZ9t3dGFL9gEcWZKbAGwlVDhqMJC6/ws/xBjsBE",
    address: "ark1amdttz2937a3dytmxmkany53pp6ma6dyrj9wuv",
    signature: "146QEzh9FhUa1uC6AX731qu8RRzdoKwZ5k+OHNp8k+UhWOiIf8/dOO+ug7riAwo5udO5yeWiAlJugIEr72iWtg==",
  },
  {
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    index: 1,
    privateKey: "a113e160a57a032523143c64baf23ac21b2069b9963e28c4b2fece3f87d480bd",
    publicKey: "A4u2dV5JlIxJfNa/WTiY5DfFPnOsJFmzhe3xayp5b9qq",
    address: "ark1lpywxkky22stctm9yzn5quwkr9fnxu3aa7rm7x",
    signature: "+/HaD8bDS565uABRGve+BQ7OO+qWJBBuRkwhJ2iro9NaAQRT+/+EvWwfzdtgkMd/2GkOG9LP2292FdFLAIVKLw==",
  },
  {
    mnemonic: "notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius",
    index: 0,
    privateKey: "da02ede4c818876fe19b5a789f84e8591debd74fd4c134546c9cd7c95e9233a6",
    publicKey: "AjszqFJDRAYbEjZMuiD+ChqzbUSGq/RRu3zr0R6iJB5b",
    address: "ark1x46rqay4d3cssq8gxxvqz8xt6nwlz4tdu3rqyv",
    signature: "1gUAbkraYTeYBHEaX3fGh/u7t5s9YEWQeaSL6gIQM41o8V8Qec/gkhNZWmpZxh8itURKq0fSOQcqrxUCGV/C/A==",
  },
  {
    mnemonic: "notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius",
    index: 1,
    privateKey: "46cde6da59b8a38747efb2946b22da527bdbdd848f26ca49c167ea5bcf4c5ad3",
    publicKey: "Ani4Fl+Q1jN45/L6k6l1vnl+kDHvqX+PmN35CyK0x1pd",
    address: "ark1gzk3usnc26avhf3deuxuwr3wggm9ntarxltxek",
    signature: "vqgOzJikUqFYCwah9o5uPGAr8oOr00YkLH8p4OQH1FdPsY6ccUq43pTnQolxdvNojev9aElBuPjxhzf2QSf4mg==",
  },
];

test("mnemonics derive the keyring's keys at coin type 330", () => {
  assert.equal(hdPath(), "m/44'/330'/0'/0/0");
  assert.equal(hdPath({ index: 7 }), "m/44'/330'/0'/0/7");
  for (const v of hdVectors) {
    const priv = privateKeyFromMnemonic(v.mnemonic, { path: hdPath({ index: v.index }) });
    assert.equal(toHex(priv), v.privateKey, `${v.mnemonic.slice(0, 12)} #${v.index}`);
    const pub = publicKeyFromPrivate(priv);
    assert.equal(toBase64(pub), v.publicKey);
    assert.equal(publicKeyToAddress(pub), v.address);
  }
  assert.equal(isValidMnemonic("abandon abandon about"), false);
  assert.throws(() => privateKeyFromMnemonic("abandon abandon about"));
});

test("signatures are RFC 6979 deterministic, low S, and verify", () => {
  const message = utf8Encode("ark sdk key vector");
  for (const v of hdVectors) {
    const priv = fromHex(v.privateKey);
    const sig = signMessage(message, priv);
    assert.equal(toBase64(sig), v.signature, v.address);
    assert.ok(isLowS(sig));
    assert.ok(verifyMessage(sig, message, publicKeyFromPrivate(priv)));
    assert.equal(verifyMessage(sig, utf8Encode("other"), publicKeyFromPrivate(priv)), false);
  }
});

test("a high-S signature is neither low S nor accepted", () => {
  const v = hdVectors[0]!;
  const sig = fromBase64(v.signature);
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(sig[i] as number);
  const high = new Uint8Array(sig);
  let hs = n - s;
  for (let i = 63; i >= 32; i--) {
    high[i] = Number(hs & 0xffn);
    hs >>= 8n;
  }
  assert.equal(isLowS(high), false);
  assert.equal(verifyMessage(high, utf8Encode("ark sdk key vector"), fromBase64(v.publicKey)), false);
});

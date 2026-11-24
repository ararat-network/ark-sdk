// Readers for the test data the SDK is checked against: ark's decoding
// fixtures and the registry's files. Test-only; excluded from the build.
import { readdirSync, readFileSync } from "node:fs";

import type { JsonObject } from "../codec/json.js";
import type { ArkJson, AssetListJson, ChainJson, RegistryFiles } from "../registry/types.js";

const root = new URL("../../testdata/", import.meta.url);

export interface FixtureKey {
  name: string;
  private_key_hex: string;
  public_key: string;
  address: string;
}

export interface FixtureKeys {
  chain_id: string;
  validator: { operator: string; consensus_public_key: string };
  accounts: FixtureKey[];
}

export interface FixtureEvent {
  type: string;
  attributes: { key: string; value: string; index: boolean }[];
  typed?: unknown;
}

/** A transaction as the chain's JSON renders it. */
export type FixtureTx = { body: JsonObject & { messages: JsonObject[]; memo: string }; auth_info: JsonObject; signatures: string[] };

/** What every fixture carries: the block it was recorded at, and the events of that block or of its transaction. */
export interface Fixture {
  name: string;
  description: string;
  chain_id: string;
  height: number;
  block_time: string;
  /** A transaction's events; absent for a block's fixture, and for a transaction the ante refused. */
  events?: FixtureEvent[];
  block_events?: FixtureEvent[];
}

/** A transaction's fixture, which is every one but a block's: its signer, fee, sign documents, bytes, and result. */
export interface TxFixture extends Fixture {
  signer: { key: string; address: string; public_key: string; account_number: string; sequence: string };
  fee: {
    fee_denom: string;
    gas_limit: string;
    tax: { denom: string; amount: string }[];
    gas_price: { denom: string; gas_price: string; derived_height: string };
    required: { denom: string; amount: string };
    pad_stable: string;
    pad_noah: string;
    declared: { denom: string; amount: string }[];
  };
  sign_mode_direct: { sign_doc: string; body_bytes: string; auth_info_bytes: string };
  sign_mode_amino: { sign_bytes: string };
  signature: string;
  tx_bytes: string;
  tx_hash: string;
  tx: FixtureTx;
  result: { code: number; codespace: string; log: string; gas_wanted: string; gas_used: string };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;
}

export function fixtureKeys(): FixtureKeys {
  return readJson<FixtureKeys>("decoding/keys.json");
}

export function fixtureKey(name: string): FixtureKey {
  const key = fixtureKeys().accounts.find((a) => a.name === name);
  if (!key) throw new Error(`no fixture key ${name}`);
  return key;
}

/** Every decoding fixture, in file order. */
export function fixtures(): Fixture[] {
  const dir = new URL("decoding/", root);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "keys.json")
    .sort()
    .map((f) => readJson<Fixture>(`decoding/${f}`));
}

const holdsTx = (f: Fixture): f is TxFixture => "tx_bytes" in f;

/** Every fixture of a transaction, in file order. */
export function txFixtures(): TxFixture[] {
  return fixtures().filter(holdsTx);
}

/** One transaction's fixture, by name. */
export function fixture(name: string): TxFixture {
  const f = readJson<Fixture>(`decoding/${name}.json`);
  if (!holdsTx(f)) throw new Error(`fixture ${name} holds no transaction`);
  return f;
}

/** The three registry files of one network under testdata/registry, parsed. */
export function registryFiles(name: string): RegistryFiles {
  return {
    chain: readJson<ChainJson>(`registry/${name}/chain.json`),
    assets: readJson<AssetListJson>(`registry/${name}/assetlist.json`),
    ark: readJson<ArkJson>(`registry/${name}/ark.json`),
  };
}

/** Coins as the chain's coin text, in the order given, so two lists compare in one assertion. */
export function amounts(coins: readonly { denom: string; amount: string }[]): string[] {
  return coins.map((c) => c.amount + c.denom);
}

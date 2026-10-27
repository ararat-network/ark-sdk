// Readers for the test data the SDK is checked against: ark's decoding
// fixtures and the signup vectors. Test-only; excluded from the build.
import { readdirSync, readFileSync } from "node:fs";

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

export interface Fixture {
  name: string;
  description: string;
  chain_id: string;
  height: number;
  block_time: string;
  signer?: { key: string; address: string; public_key: string; account_number: string; sequence: string };
  fee?: {
    fee_denom: string;
    gas_limit: string;
    tax: { denom: string; amount: string }[];
    gas_price: { denom: string; gas_price: string; derived_height: string };
    required: { denom: string; amount: string };
    pad_stable: string;
    pad_noah: string;
    declared: { denom: string; amount: string }[];
  };
  sign_mode_direct?: { sign_doc: string; body_bytes: string; auth_info_bytes: string };
  sign_mode_amino?: { sign_bytes: string };
  signature?: string;
  tx_bytes?: string;
  tx_hash?: string;
  tx?: unknown;
  result?: { code: number; codespace: string; log: string; gas_wanted: string; gas_used: string };
  events?: FixtureEvent[];
  block_events?: FixtureEvent[];
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

export function fixture(name: string): Fixture {
  return readJson<Fixture>(`decoding/${name}.json`);
}

export interface SignupKey {
  name: string;
  private_key_hex: string;
  public_key: string;
  address: string;
}

export interface SignupVector {
  name: string;
  description: string;
  prefix: string;
  domain: string;
  challenge: Record<string, string> | null;
  now: string;
  signer: string;
  public_key: string;
  data: string;
  sign_bytes: string;
  signature: string;
  signature_valid: boolean;
  expect: string;
}

export function signupVectors(): { keys: SignupKey[]; vectors: SignupVector[] } {
  return readJson<{ keys: SignupKey[]; vectors: SignupVector[] }>("signup/vectors.json");
}

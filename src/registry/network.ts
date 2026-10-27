// One Ark network as the registry describes it. The chain-derived half
// (denominations, prefix, coin type, genesis identity) and the hand-kept half
// (endpoints) arrive in the same files; the SDK reads both here and nowhere
// else, so an app never carries its own copy. The files are checked member
// by member before anything is read from them, the prefix and coin type are
// held to the SDK's own, and an endpoint is accepted over https, or http on
// the loopback: the registry is fetched from a branch by default, and a
// change there must fail loudly here, never reach a signer as a TypeError or
// an address as a different chain's.
import { sha256 } from "@noble/hashes/sha2.js";

import { toHex } from "../codec/bytes.js";
import { DEFAULT_PREFIX } from "../keys/address.js";
import { ARK_COIN_TYPE } from "../keys/hd.js";
import type { ArkFeatures, AssetJson, DenomUnit, Endpoint, Explorer, RegistryFiles } from "./types.js";

export class RegistryError extends Error {
  override readonly name: string = "RegistryError";
}

/** Thrown when a genesis file is not the one the registry names for the network. */
export class GenesisMismatch extends RegistryError {
  override readonly name: string = "GenesisMismatch";
  constructor(
    readonly chainId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`genesis for ${chainId}: expected sha256 ${expected}, got ${actual}`);
  }
}

/** One asset of the network: its base denomination and the units it is shown in. */
export class Asset {
  readonly base: string;
  readonly display: string;
  readonly symbol: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly units: readonly DenomUnit[];

  constructor(json: AssetJson) {
    this.base = json.base;
    this.display = json.display;
    this.symbol = json.symbol;
    this.name = json.name;
    this.description = json.description;
    this.units = json.denom_units.map((u) => ({ denom: u.denom, exponent: u.exponent, ...(u.aliases ? { aliases: [...u.aliases] } : {}) }));
    if (!this.units.some((u) => u.denom === this.base && u.exponent === 0)) {
      throw new RegistryError(`asset ${json.base}: no base unit with exponent 0`);
    }
    if (!this.units.some((u) => u.denom === this.display)) {
      throw new RegistryError(`asset ${json.base}: display unit ${json.display} is not among its units`);
    }
  }

  /** The exponent of the display unit: how many base units make one. */
  get exponent(): number {
    return this.unit(this.display).exponent;
  }

  unit(denom: string): DenomUnit {
    const unit = this.units.find((u) => u.denom === denom || u.aliases?.includes(denom));
    if (!unit) throw new RegistryError(`asset ${this.base}: no unit ${denom}`);
    return unit;
  }
}

export interface Endpoints {
  readonly rest: readonly Endpoint[];
  readonly rpc: readonly Endpoint[];
  readonly grpc: readonly Endpoint[];
  readonly indexer: readonly Endpoint[];
  readonly explorers: readonly Explorer[];
}

export class Network {
  readonly name: string;
  readonly chainId: string;
  readonly prettyName: string;
  readonly networkType: string | undefined;
  readonly bech32Prefix: string;
  readonly slip44: number;
  readonly arkVersion: string;
  /** The binary version the registry recommends, and every version it lists as compatible. */
  readonly recommendedVersion: string | undefined;
  readonly compatibleVersions: readonly string[];
  readonly genesisUrl: string | undefined;
  /** SHA-256 of the genesis file, lowercase hex; absent for a network whose genesis is made on each start. */
  readonly genesisSha256: string | undefined;
  readonly features: Readonly<ArkFeatures>;
  readonly referenceDenom: string;
  readonly feeds: readonly string[];
  readonly feeDenoms: readonly string[];
  readonly stakingDenom: string;
  readonly feeContract: string;
  readonly endpoints: Endpoints;
  /** Every asset by base denomination. */
  readonly assets: ReadonlyMap<string, Asset>;

  private constructor(files: RegistryFiles) {
    checkFiles(files);
    const { chain, assets, ark } = files;
    if (ark.chain_id !== chain.chain_id) throw new RegistryError(`chain.json names ${chain.chain_id}, ark.json ${ark.chain_id}`);
    if (assets.chain_name !== chain.chain_name) throw new RegistryError(`chain.json names ${chain.chain_name}, assetlist.json ${assets.chain_name}`);
    if (ark.bech32_prefix !== chain.bech32_prefix) throw new RegistryError(`chain.json prefix ${chain.bech32_prefix}, ark.json ${ark.bech32_prefix}`);
    if (ark.slip44 !== chain.slip44) throw new RegistryError(`chain.json slip44 ${chain.slip44}, ark.json ${ark.slip44}`);
    if (ark.genesis_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(ark.genesis_sha256)) {
      throw new RegistryError(`ark.json genesis_sha256 is not 64 lowercase hex characters`);
    }
    if (chain.bech32_prefix !== DEFAULT_PREFIX) {
      throw new RegistryError(`chain.json prefix ${chain.bech32_prefix} is not ${DEFAULT_PREFIX}, the prefix this SDK derives addresses for`);
    }
    if (chain.slip44 !== ARK_COIN_TYPE) {
      throw new RegistryError(`chain.json slip44 ${chain.slip44} is not ${ARK_COIN_TYPE}, the coin type this SDK derives keys at`);
    }
    const staking = chain.staking?.staking_tokens?.[0]?.denom;
    if (!staking) throw new RegistryError(`chain.json names no staking token`);
    for (const [kind, list] of [
      ["rest", chain.apis?.rest],
      ["rpc", chain.apis?.rpc],
      ["indexer", ark.indexer],
    ] as const) {
      for (const e of list ?? []) checkEndpointUrl(e.address, `chain.json ${kind} endpoint`);
    }
    if (chain.codebase?.genesis?.genesis_url !== undefined) checkEndpointUrl(chain.codebase.genesis.genesis_url, "chain.json genesis_url");

    this.name = chain.chain_name;
    this.chainId = chain.chain_id;
    this.prettyName = chain.pretty_name ?? chain.chain_name;
    this.networkType = chain.network_type;
    this.bech32Prefix = chain.bech32_prefix;
    this.slip44 = chain.slip44;
    this.arkVersion = ark.ark_version;
    this.recommendedVersion = chain.codebase?.recommended_version;
    this.compatibleVersions = [...(chain.codebase?.compatible_versions ?? [])];
    this.genesisUrl = chain.codebase?.genesis?.genesis_url;
    this.genesisSha256 = ark.genesis_sha256;
    this.features = { ...ark.features };
    this.referenceDenom = ark.reference_denom;
    this.feeds = [...ark.feeds];
    this.feeDenoms = [...ark.fee_denoms];
    this.stakingDenom = staking;
    this.feeContract = ark.fee_contract;
    this.endpoints = {
      rest: [...(chain.apis?.rest ?? [])],
      rpc: [...(chain.apis?.rpc ?? [])],
      grpc: [...(chain.apis?.grpc ?? [])],
      indexer: [...(ark.indexer ?? [])],
      explorers: [...(chain.explorers ?? [])],
    };
    const byBase = new Map<string, Asset>();
    for (const a of assets.assets) {
      if (byBase.has(a.base)) throw new RegistryError(`assetlist.json lists ${a.base} twice`);
      byBase.set(a.base, new Asset(a));
    }
    this.assets = byBase;
  }

  /** Builds a network from the three parsed registry files, checking they agree. */
  static fromRegistry(files: RegistryFiles): Network {
    return new Network(files);
  }

  /** The asset with this base denomination, or undefined for one the registry does not list. */
  asset(denom: string): Asset | undefined {
    return this.assets.get(denom);
  }

  /** The asset whose base, display, or alias unit is `denom`. */
  assetByUnit(denom: string): Asset | undefined {
    for (const a of this.assets.values()) {
      if (a.units.some((u) => u.denom === denom || u.aliases?.includes(denom))) return a;
    }
    return undefined;
  }

  /** The address prefix for a validator operator. */
  get validatorPrefix(): string {
    return `${this.bech32Prefix}valoper`;
  }

  /** The first REST endpoint, which a client reaches the gateway through. */
  get restUrl(): string | undefined {
    return this.endpoints.rest[0]?.address;
  }

  /** SHA-256 of a genesis file, as ark.json records it. */
  static genesisHash(genesis: Uint8Array): string {
    return toHex(sha256(genesis));
  }

  /**
   * Checks a genesis file against the registry's hash. A node's RPC
   * re-serialises the genesis, so only the file itself can be checked;
   * `unverifiable` means the registry carries no hash for this network.
   */
  verifyGenesis(genesis: Uint8Array): "verified" | "unverifiable" {
    if (this.genesisSha256 === undefined) return "unverifiable";
    const actual = Network.genesisHash(genesis);
    if (actual !== this.genesisSha256) throw new GenesisMismatch(this.chainId, this.genesisSha256, actual);
    return "verified";
  }
}

export const REGISTRY_REPOSITORY = "ararat-network/ark-registry";
/** The ref the registry is read at unless one is given: the branch its endpoints are kept on. */
export const DEFAULT_REGISTRY_REF = "main";

/** Where the published registry's files are read from, at a git ref: a branch, a tag, or a commit, which pins it. */
export function registrySource(ref = DEFAULT_REGISTRY_REF): string {
  return `https://raw.githubusercontent.com/${REGISTRY_REPOSITORY}/${ref}`;
}

export interface LoadOptions {
  /** Base URL holding `<name>/chain.json` and the two other files; the published registry at `ref` by default. */
  source?: string;
  /** The registry's git ref when `source` is not given: `main` by default; a commit pins what is read. */
  ref?: string;
  fetch?: typeof fetch;
}

/** Fetches the three files for a network, checks them, and builds it. */
export async function loadNetwork(name: string, options: LoadOptions = {}): Promise<Network> {
  const source = options.source ?? registrySource(options.ref);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const read = async (file: string): Promise<unknown> => {
    const url = `${source}/${name}/${file}`;
    const response = await fetchFn(url);
    if (!response.ok) throw new RegistryError(`${url}: ${response.status} ${response.statusText}`);
    try {
      return await response.json();
    } catch (err) {
      throw new RegistryError(`${url}: not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const [chain, assets, ark] = await Promise.all([read("chain.json"), read("assetlist.json"), read("ark.json")]);
  return Network.fromRegistry({ chain, assets, ark } as RegistryFiles);
}

// The checks below read the files as the unknown JSON they are, so a member
// the SDK relies on that is missing or mistyped is refused by name.

type JsonObject = Record<string, unknown>;

function object(value: unknown, where: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RegistryError(`${where} is not an object`);
  return value as JsonObject;
}

function member(o: JsonObject, key: string, where: string): unknown {
  if (!(key in o)) throw new RegistryError(`${where}: ${key} is missing`);
  return o[key];
}

function text(o: JsonObject, key: string, where: string): string {
  const v = member(o, key, where);
  if (typeof v !== "string" || v === "") throw new RegistryError(`${where}: ${key} must be a non-empty string`);
  return v;
}

function optionalText(o: JsonObject, key: string, where: string): string | undefined {
  return o[key] === undefined ? undefined : text(o, key, where);
}

function wholeNumber(o: JsonObject, key: string, where: string): number {
  const v = member(o, key, where);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new RegistryError(`${where}: ${key} must be a whole number`);
  return v;
}

function flag(o: JsonObject, key: string, where: string): boolean {
  const v = member(o, key, where);
  if (typeof v !== "boolean") throw new RegistryError(`${where}: ${key} must be true or false`);
  return v;
}

function list(o: JsonObject, key: string, where: string): unknown[] {
  const v = member(o, key, where);
  if (!Array.isArray(v)) throw new RegistryError(`${where}: ${key} must be a list`);
  return v;
}

function optionalList(o: JsonObject, key: string, where: string): unknown[] | undefined {
  return o[key] === undefined ? undefined : list(o, key, where);
}

function texts(o: JsonObject, key: string, where: string): string[] {
  const v = list(o, key, where);
  if (!v.every((x) => typeof x === "string" && x !== "")) throw new RegistryError(`${where}: ${key} must be a list of non-empty strings`);
  return v as string[];
}

function endpoints(o: JsonObject, key: string, where: string): void {
  for (const [i, e] of (optionalList(o, key, where) ?? []).entries()) {
    const entry = object(e, `${where}: ${key}[${i}]`);
    text(entry, "address", `${where}: ${key}[${i}]`);
    optionalText(entry, "provider", `${where}: ${key}[${i}]`);
  }
}

function checkChain(value: unknown): void {
  const where = "chain.json";
  const chain = object(value, where);
  text(chain, "chain_name", where);
  text(chain, "chain_id", where);
  optionalText(chain, "pretty_name", where);
  optionalText(chain, "network_type", where);
  text(chain, "bech32_prefix", where);
  wholeNumber(chain, "slip44", where);
  if (chain.staking !== undefined) {
    const staking = object(chain.staking, `${where}: staking`);
    for (const [i, t] of (optionalList(staking, "staking_tokens", `${where}: staking`) ?? []).entries()) {
      text(object(t, `${where}: staking_tokens[${i}]`), "denom", `${where}: staking_tokens[${i}]`);
    }
  }
  if (chain.codebase !== undefined) {
    const codebase = object(chain.codebase, `${where}: codebase`);
    optionalText(codebase, "recommended_version", `${where}: codebase`);
    if (codebase.compatible_versions !== undefined) texts(codebase, "compatible_versions", `${where}: codebase`);
    if (codebase.genesis !== undefined) optionalText(object(codebase.genesis, `${where}: codebase.genesis`), "genesis_url", `${where}: codebase.genesis`);
  }
  if (chain.apis !== undefined) {
    const apis = object(chain.apis, `${where}: apis`);
    for (const kind of ["rpc", "rest", "grpc"]) endpoints(apis, kind, `${where}: apis`);
  }
  for (const [i, e] of (optionalList(chain, "explorers", where) ?? []).entries()) {
    const explorer = object(e, `${where}: explorers[${i}]`);
    optionalText(explorer, "kind", `${where}: explorers[${i}]`);
    optionalText(explorer, "url", `${where}: explorers[${i}]`);
  }
}

function checkAssets(value: unknown): void {
  const where = "assetlist.json";
  const assets = object(value, where);
  text(assets, "chain_name", where);
  for (const [i, a] of list(assets, "assets", where).entries()) {
    const at = `${where}: assets[${i}]`;
    const asset = object(a, at);
    for (const key of ["base", "display", "symbol", "name"]) text(asset, key, at);
    optionalText(asset, "description", at);
    const units = list(asset, "denom_units", at);
    if (units.length === 0) throw new RegistryError(`${at}: denom_units is empty`);
    for (const [j, u] of units.entries()) {
      const unit = object(u, `${at}.denom_units[${j}]`);
      text(unit, "denom", `${at}.denom_units[${j}]`);
      wholeNumber(unit, "exponent", `${at}.denom_units[${j}]`);
      if (unit.aliases !== undefined) texts(unit, "aliases", `${at}.denom_units[${j}]`);
    }
  }
}

function checkArk(value: unknown): void {
  const where = "ark.json";
  const ark = object(value, where);
  text(ark, "chain_id", where);
  text(ark, "ark_version", where);
  optionalText(ark, "genesis_sha256", where);
  text(ark, "bech32_prefix", where);
  wholeNumber(ark, "slip44", where);
  const features = object(member(ark, "features", where), `${where}: features`);
  for (const key of ["cosmwasm", "vote_extensions", "conversion_open"]) flag(features, key, `${where}: features`);
  text(ark, "reference_denom", where);
  texts(ark, "feeds", where);
  texts(ark, "fee_denoms", where);
  text(ark, "fee_contract", where);
  endpoints(ark, "indexer", where);
}

function checkFiles(files: RegistryFiles): void {
  checkChain(files.chain);
  checkAssets(files.assets);
  checkArk(files.ark);
}

/** Whether a host is the machine itself, where http is as private as https. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]";
}

/** An endpoint the SDK will send requests to: https, or http on the loopback. */
function checkEndpointUrl(address: string, where: string): void {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new RegistryError(`${where} ${address} is not a URL`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return;
  throw new RegistryError(`${where} ${address} is not https, and http is accepted on the loopback only`);
}

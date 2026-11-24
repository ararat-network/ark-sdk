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
import { isJsonObject } from "../codec/json.js";
import { ArkSdkError, errorMessage } from "../errors.js";
import { DEFAULT_PREFIX } from "../keys/address.js";
import { ARK_COIN_TYPE } from "../keys/hd.js";
import type { ArkFeatures, ArkJson, AssetJson, AssetListJson, ChainJson, DenomUnit, Endpoint, Explorer } from "./types.js";

export class RegistryError extends ArkSdkError {
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
    // A name, a unit's denomination or one of its aliases, belongs to one unit. Two units answering to one name
    // would give an amount the exponent of whichever is listed first: the display unit's could be another's.
    const owner = new Map<string, DenomUnit>();
    for (const unit of this.units) {
      for (const name of [unit.denom, ...(unit.aliases ?? [])]) {
        const other = owner.get(name);
        if (other && other !== unit) {
          throw new RegistryError(`asset ${json.base}: ${name} names two units, at exponents ${other.exponent} and ${unit.exponent}`);
        }
        owner.set(name, unit);
      }
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

  private constructor(files: UncheckedFiles) {
    // Each file is parsed into the members the SDK reads, checked one by one: nothing below reads the files themselves.
    const chain = parseChain(files.chain);
    const assets = parseAssets(files.assets);
    const ark = parseArk(files.ark);
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
    for (const [where, list] of [
      ["chain.json rest endpoint", chain.apis?.rest],
      ["chain.json rpc endpoint", chain.apis?.rpc],
      ["ark.json indexer endpoint", ark.indexer],
    ] as const) {
      for (const e of list ?? []) checkEndpointUrl(e.address, where);
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
    this.features = ark.features;
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

  /**
   * Builds a network from the three registry files as they were read from JSON,
   * checking each member the SDK reads and that the files agree. `RegistryFiles`
   * is their shape; nothing is taken on trust from a value typed as it.
   */
  static fromRegistry(files: UncheckedFiles): Network {
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

/** A registry directory's name, as the chain registry names chains: lowercase letters and digits, single hyphens or underscores between them. */
const NETWORK_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** One part of a git ref between slashes: letters, digits, dots, hyphens, and underscores, not led by a dot. */
const REF_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Refuses a ref that is not a branch, tag, or commit name. The ref becomes
 * part of the registry's URL, and one holding "..", an empty part, or a
 * character a URL reads as structure would name another repository's files.
 */
function checkRef(ref: string): void {
  const named = ref.split("/").every((part) => REF_PART.test(part) && !part.includes("..") && !part.endsWith("."));
  if (!named) throw new RegistryError(`registry ref ${JSON.stringify(ref)} is not a branch, tag, or commit name`);
}

/** Where the published registry's files are read from, at a git ref: a branch, a tag, or a commit, which pins it. */
export function registrySource(ref = DEFAULT_REGISTRY_REF): string {
  checkRef(ref);
  return `https://raw.githubusercontent.com/${REGISTRY_REPOSITORY}/${ref}`;
}

export interface LoadOptions {
  /** Base URL holding `<name>/chain.json` and the two other files; the published registry at `ref` by default. */
  source?: string;
  /** The registry's git ref when `source` is not given: `main` by default; a commit pins what is read. */
  ref?: string;
  fetch?: typeof fetch;
}

/**
 * Fetches the three files for a network, checks them, and builds it. The name
 * is a registry directory's and nothing else: it and the ref become part of
 * the URL, and a caller may have taken either from a link or a setting. The
 * network the files describe must be the one asked for.
 */
export async function loadNetwork(name: string, options: LoadOptions = {}): Promise<Network> {
  if (!NETWORK_NAME.test(name)) {
    throw new RegistryError(
      `network name ${JSON.stringify(name)} is not a registry directory's: lowercase letters and digits, hyphens or underscores between them`,
    );
  }
  const source = options.source ?? registrySource(options.ref);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const read = async (file: string): Promise<unknown> => {
    const url = `${source}/${name}/${file}`;
    let response: Response;
    try {
      response = await fetchFn(url);
    } catch (err) {
      throw new RegistryError(`${url}: ${errorMessage(err)}`, { cause: err });
    }
    if (!response.ok) throw new RegistryError(`${url}: ${response.status} ${response.statusText}`);
    try {
      return await response.json();
    } catch (err) {
      throw new RegistryError(`${url}: not JSON: ${errorMessage(err)}`, { cause: err });
    }
  };
  const [chain, assets, ark] = await Promise.all([read("chain.json"), read("assetlist.json"), read("ark.json")]);
  const network = Network.fromRegistry({ chain, assets, ark });
  // A directory is named for the chain it describes. Files for another chain, well formed, would hand a caller
  // who asked for the testnet another network's chain ID and endpoints.
  if (network.name !== name) throw new RegistryError(`${source}/${name} describes the network ${network.name}, not ${name}`);
  return network;
}

/** The three files before they are checked: whatever the JSON held. */
interface UncheckedFiles {
  chain: unknown;
  assets: unknown;
  ark: unknown;
}

// The parsers below read the files as the unknown JSON they are and return
// the members the SDK reads, each one checked: a member that is missing or
// mistyped is refused by name, and one that no parser returns cannot be read.
// What a network hands on as it was written, an endpoint, an explorer, the
// feature flags, keeps the members the SDK does not name beside the checked
// ones, in a copy the files no longer share.

type JsonObject = Record<string, unknown>;

function object(value: unknown, where: string): JsonObject {
  if (!isJsonObject(value)) throw new RegistryError(`${where} is not an object`);
  return value;
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

const isText = (x: unknown): x is string => typeof x === "string" && x !== "";

function texts(o: JsonObject, key: string, where: string): string[] {
  const v = list(o, key, where);
  if (!v.every(isText)) throw new RegistryError(`${where}: ${key} must be a list of non-empty strings`);
  return v;
}

function optionalTexts(o: JsonObject, key: string, where: string): string[] | undefined {
  return o[key] === undefined ? undefined : texts(o, key, where);
}

function endpoints(o: JsonObject, key: string, where: string): Endpoint[] | undefined {
  return optionalList(o, key, where)?.map((e, i) => {
    const at = `${where}: ${key}[${i}]`;
    const entry = object(e, at);
    const address = text(entry, "address", at);
    optionalText(entry, "provider", at);
    return { ...entry, address };
  });
}

function parseChain(value: unknown): ChainJson {
  const where = "chain.json";
  const chain = object(value, where);
  const parsed: ChainJson = {
    chain_name: text(chain, "chain_name", where),
    chain_id: text(chain, "chain_id", where),
    pretty_name: optionalText(chain, "pretty_name", where),
    network_type: optionalText(chain, "network_type", where),
    bech32_prefix: text(chain, "bech32_prefix", where),
    slip44: wholeNumber(chain, "slip44", where),
  };
  if (chain.staking !== undefined) {
    const at = `${where}: staking`;
    const tokens = optionalList(object(chain.staking, at), "staking_tokens", at);
    parsed.staking = {
      staking_tokens: tokens?.map((t, i) => ({ denom: text(object(t, `${where}: staking_tokens[${i}]`), "denom", `${where}: staking_tokens[${i}]`) })),
    };
  }
  if (chain.codebase !== undefined) {
    const at = `${where}: codebase`;
    const codebase = object(chain.codebase, at);
    parsed.codebase = {
      recommended_version: optionalText(codebase, "recommended_version", at),
      compatible_versions: optionalTexts(codebase, "compatible_versions", at),
      genesis:
        codebase.genesis === undefined ? undefined : { genesis_url: optionalText(object(codebase.genesis, `${at}.genesis`), "genesis_url", `${at}.genesis`) },
    };
  }
  if (chain.apis !== undefined) {
    const at = `${where}: apis`;
    const apis = object(chain.apis, at);
    parsed.apis = { rpc: endpoints(apis, "rpc", at), rest: endpoints(apis, "rest", at), grpc: endpoints(apis, "grpc", at) };
  }
  parsed.explorers = optionalList(chain, "explorers", where)?.map((e, i): Explorer => {
    const at = `${where}: explorers[${i}]`;
    const explorer = object(e, at);
    optionalText(explorer, "kind", at);
    optionalText(explorer, "url", at);
    return { ...explorer };
  });
  return parsed;
}

/** The most places a unit can have: 10^77 is the largest power of ten a 256-bit amount holds. */
const MAX_UNIT_EXPONENT = 77;

function parseAssets(value: unknown): AssetListJson {
  const where = "assetlist.json";
  const assets = object(value, where);
  return {
    chain_name: text(assets, "chain_name", where),
    assets: list(assets, "assets", where).map((a, i): AssetJson => {
      const at = `${where}: assets[${i}]`;
      const asset = object(a, at);
      const named = {
        base: text(asset, "base", at),
        display: text(asset, "display", at),
        symbol: text(asset, "symbol", at),
        name: text(asset, "name", at),
        description: optionalText(asset, "description", at),
      };
      const units = list(asset, "denom_units", at);
      if (units.length === 0) throw new RegistryError(`${at}: denom_units is empty`);
      return {
        ...named,
        denom_units: units.map((u, j): DenomUnit => {
          const ut = `${at}.denom_units[${j}]`;
          const unit = object(u, ut);
          const exponent = wholeNumber(unit, "exponent", ut);
          // An amount is at most 256 bits, 78 digits: a unit of more places than 77 names no amount, and its power
          // of ten is past what the formatters can build.
          if (exponent > MAX_UNIT_EXPONENT) throw new RegistryError(`${ut}: exponent ${exponent} is more than ${MAX_UNIT_EXPONENT}`);
          return { denom: text(unit, "denom", ut), exponent, aliases: optionalTexts(unit, "aliases", ut) };
        }),
      };
    }),
  };
}

function parseFeatures(value: unknown, where: string): ArkFeatures {
  const features = object(value, where);
  // A flag the SDK does not name yet is kept when it is a flag, so a newer registry's reaches an app that knows it.
  const flags = Object.fromEntries(Object.entries(features).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  return {
    ...flags,
    cosmwasm: flag(features, "cosmwasm", where),
    vote_extensions: flag(features, "vote_extensions", where),
    conversion_open: flag(features, "conversion_open", where),
  };
}

function parseArk(value: unknown): ArkJson {
  const where = "ark.json";
  const ark = object(value, where);
  return {
    chain_id: text(ark, "chain_id", where),
    ark_version: text(ark, "ark_version", where),
    genesis_sha256: optionalText(ark, "genesis_sha256", where),
    bech32_prefix: text(ark, "bech32_prefix", where),
    slip44: wholeNumber(ark, "slip44", where),
    features: parseFeatures(member(ark, "features", where), `${where}: features`),
    reference_denom: text(ark, "reference_denom", where),
    feeds: texts(ark, "feeds", where),
    fee_denoms: texts(ark, "fee_denoms", where),
    fee_contract: text(ark, "fee_contract", where),
    indexer: endpoints(ark, "indexer", where),
  };
}

/** An IPv4 address in 127.0.0.0/8. URL writes every IPv4 host as four decimal octets, so nothing else is one. */
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/**
 * Whether a host is the machine itself, where http is as private as https.
 * The 127 block is matched as an address, never as a prefix: a name such as
 * 127.example.org is someone else's host.
 */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || LOOPBACK_IPV4.test(hostname) || hostname === "[::1]";
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

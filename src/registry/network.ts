// One Ark network as the registry describes it. The chain-derived half
// (denominations, prefix, coin type, genesis identity) and the hand-kept half
// (endpoints) arrive in the same files; the SDK reads both here and nowhere
// else, so an app never carries its own copy. The files are checked member
// by member, in parse.ts, before anything is read from them, the prefix and
// coin type are held to the SDK's own, and an endpoint is accepted over
// https, or http on the loopback: the registry is fetched from a branch by
// default, and a change there must fail loudly here, never reach a signer as
// a TypeError or an address as a different chain's.
import { sha256 } from "@noble/hashes/sha2.js";

import { toHex } from "../codec/bytes.js";
import { DEFAULT_PREFIX, validatorPrefix } from "../keys/address.js";
import { ARK_COIN_TYPE } from "../keys/hd.js";
import { parseArk, parseAssets, parseChain, RegistryError } from "./parse.js";
import type { ArkFeatures, AssetJson, DenomUnit, Endpoint, Explorer } from "./types.js";

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
    const unit = this.units.find((u) => answersTo(u, denom));
    if (!unit) throw new RegistryError(`asset ${this.base}: no unit ${denom}`);
    return unit;
  }
}

/** Whether a unit answers to a name: its denomination, or one of its aliases. */
function answersTo(unit: DenomUnit, name: string): boolean {
  return unit.denom === name || (unit.aliases?.includes(name) ?? false);
}

export interface Endpoints {
  readonly rest: readonly Endpoint[];
  readonly rpc: readonly Endpoint[];
  readonly grpc: readonly Endpoint[];
  readonly indexer: readonly Endpoint[];
  readonly explorers: readonly Explorer[];
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

  private constructor(files: { chain: unknown; assets: unknown; ark: unknown }) {
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
  static fromRegistry(files: { chain: unknown; assets: unknown; ark: unknown }): Network {
    return new Network(files);
  }

  /** The asset with this base denomination, or undefined for one the registry does not list. */
  asset(denom: string): Asset | undefined {
    return this.assets.get(denom);
  }

  /** The asset whose base, display, or alias unit is `denom`. */
  assetByUnit(denom: string): Asset | undefined {
    for (const a of this.assets.values()) {
      if (a.units.some((u) => answersTo(u, denom))) return a;
    }
    return undefined;
  }

  /** The address prefix for a validator operator. */
  get validatorPrefix(): string {
    return validatorPrefix(this.bech32Prefix);
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

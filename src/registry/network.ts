// One Ark network as the registry describes it. The chain-derived half
// (denominations, prefix, coin type, genesis identity) and the hand-kept half
// (endpoints) arrive in the same files; the SDK reads both here and nowhere
// else, so an app never carries its own copy.
import { sha256 } from "@noble/hashes/sha2.js";

import { toHex } from "../codec/bytes.js";
import type { ArkFeatures, ArkJson, AssetJson, ChainJson, DenomUnit, Endpoint, Explorer, RegistryFiles } from "./types.js";

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
    const { chain, assets, ark } = files;
    if (ark.chain_id !== chain.chain_id) throw new RegistryError(`chain.json names ${chain.chain_id}, ark.json ${ark.chain_id}`);
    if (assets.chain_name !== chain.chain_name) throw new RegistryError(`chain.json names ${chain.chain_name}, assetlist.json ${assets.chain_name}`);
    if (ark.bech32_prefix !== chain.bech32_prefix) throw new RegistryError(`chain.json prefix ${chain.bech32_prefix}, ark.json ${ark.bech32_prefix}`);
    if (ark.slip44 !== chain.slip44) throw new RegistryError(`chain.json slip44 ${chain.slip44}, ark.json ${ark.slip44}`);
    if (ark.genesis_sha256 !== undefined && !/^[0-9a-f]{64}$/.test(ark.genesis_sha256)) {
      throw new RegistryError(`ark.json genesis_sha256 is not 64 lowercase hex characters`);
    }
    const staking = chain.staking?.staking_tokens?.[0]?.denom;
    if (!staking) throw new RegistryError(`chain.json names no staking token`);

    this.name = chain.chain_name;
    this.chainId = chain.chain_id;
    this.prettyName = chain.pretty_name ?? chain.chain_name;
    this.networkType = chain.network_type;
    this.bech32Prefix = chain.bech32_prefix;
    this.slip44 = chain.slip44;
    this.arkVersion = ark.ark_version;
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

/** Where the published registry's files are read from, at a git ref. */
export function registrySource(ref = "main"): string {
  return `https://raw.githubusercontent.com/ararat-network/ark-registry/${ref}`;
}

export interface LoadOptions {
  /** Base URL holding `<name>/chain.json` and the two other files; the published registry at `main` by default. */
  source?: string;
  fetch?: typeof fetch;
}

/** Fetches the three files for a network and builds it. */
export async function loadNetwork(name: string, options: LoadOptions = {}): Promise<Network> {
  const source = options.source ?? registrySource();
  const fetchFn = options.fetch ?? globalThis.fetch;
  const read = async <T>(file: string): Promise<T> => {
    const url = `${source}/${name}/${file}`;
    const response = await fetchFn(url);
    if (!response.ok) throw new RegistryError(`${url}: ${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  };
  const [chain, assets, ark] = await Promise.all([
    read<ChainJson>("chain.json"),
    read<import("./types.js").AssetListJson>("assetlist.json"),
    read<ArkJson>("ark.json"),
  ]);
  return Network.fromRegistry({ chain, assets, ark });
}

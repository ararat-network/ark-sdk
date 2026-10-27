// The members of the network registry's files that the SDK reads. chain.json
// and assetlist.json follow the community chain-registry schema; ark.json
// holds what that schema has no field for. Fields the SDK never reads are
// left out, so a registry change cannot break a client that ignores it.

export interface Endpoint {
  address: string;
  provider?: string;
}

export interface Explorer {
  kind?: string;
  url?: string;
}

export interface ChainJson {
  chain_name: string;
  chain_id: string;
  pretty_name?: string;
  network_type?: string;
  status?: string;
  bech32_prefix: string;
  slip44: number;
  fees?: { fee_tokens?: { denom: string; fixed_min_gas_price?: number }[] };
  staking?: { staking_tokens?: { denom: string }[] };
  codebase?: {
    recommended_version?: string;
    /** The binary versions a node may run; verifyNetwork reports the node's against them. */
    compatible_versions?: string[];
    genesis?: { genesis_url?: string };
  };
  apis?: { rpc?: Endpoint[]; rest?: Endpoint[]; grpc?: Endpoint[] };
  explorers?: Explorer[];
}

export interface DenomUnit {
  denom: string;
  exponent: number;
  aliases?: string[];
}

export interface AssetJson {
  base: string;
  display: string;
  symbol: string;
  name: string;
  description?: string;
  denom_units: DenomUnit[];
}

export interface AssetListJson {
  chain_name: string;
  assets: AssetJson[];
}

export interface ArkFeatures {
  cosmwasm: boolean;
  vote_extensions: boolean;
  conversion_open: boolean;
}

export interface ArkJson {
  chain_id: string;
  ark_version: string;
  genesis_sha256?: string;
  bech32_prefix: string;
  slip44: number;
  features: ArkFeatures;
  reference_denom: string;
  feeds: string[];
  fee_denoms: string[];
  fee_contract: string;
  logo_URIs?: { png?: string; svg?: string };
  indexer?: Endpoint[];
}

/** The three files that describe one network. */
export interface RegistryFiles {
  chain: ChainJson;
  assets: AssetListJson;
  ark: ArkJson;
}

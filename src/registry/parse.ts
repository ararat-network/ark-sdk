// The registry's files, from unknown JSON to the members the SDK reads. Each
// parser takes a file as whatever the JSON held and returns its members, each
// one checked: a member that is missing or mistyped is refused by name, and
// one that no parser returns cannot be read. What a network hands on as it
// was written, an endpoint, an explorer, the feature flags, keeps the members
// the SDK does not name beside the checked ones, in a copy the files no
// longer share. What the checked files mean together, and which endpoints are
// accepted, is network.ts's.
import { isJsonObject } from "../codec/json.js";
import { ArkSdkError } from "../errors.js";
import type { ArkFeatures, ArkJson, AssetJson, AssetListJson, ChainJson, DenomUnit, Endpoint, Explorer } from "./types.js";

export class RegistryError extends ArkSdkError {
  override readonly name: string = "RegistryError";
}

/** A JSON object before its members are checked. */
type Unchecked = Record<string, unknown>;

function object(value: unknown, where: string): Unchecked {
  if (!isJsonObject(value)) throw new RegistryError(`${where} is not an object`);
  return value;
}

function member(o: Unchecked, key: string, where: string): unknown {
  if (!(key in o)) throw new RegistryError(`${where}: ${key} is missing`);
  return o[key];
}

function text(o: Unchecked, key: string, where: string): string {
  const v = member(o, key, where);
  if (typeof v !== "string" || v === "") throw new RegistryError(`${where}: ${key} must be a non-empty string`);
  return v;
}

function optionalText(o: Unchecked, key: string, where: string): string | undefined {
  return o[key] === undefined ? undefined : text(o, key, where);
}

function wholeNumber(o: Unchecked, key: string, where: string): number {
  const v = member(o, key, where);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new RegistryError(`${where}: ${key} must be a whole number`);
  return v;
}

function flag(o: Unchecked, key: string, where: string): boolean {
  const v = member(o, key, where);
  if (typeof v !== "boolean") throw new RegistryError(`${where}: ${key} must be true or false`);
  return v;
}

function list(o: Unchecked, key: string, where: string): unknown[] {
  const v = member(o, key, where);
  if (!Array.isArray(v)) throw new RegistryError(`${where}: ${key} must be a list`);
  return v;
}

function optionalList(o: Unchecked, key: string, where: string): unknown[] | undefined {
  return o[key] === undefined ? undefined : list(o, key, where);
}

const isText = (x: unknown): x is string => typeof x === "string" && x !== "";

function texts(o: Unchecked, key: string, where: string): string[] {
  const v = list(o, key, where);
  if (!v.every(isText)) throw new RegistryError(`${where}: ${key} must be a list of non-empty strings`);
  return v;
}

function optionalTexts(o: Unchecked, key: string, where: string): string[] | undefined {
  return o[key] === undefined ? undefined : texts(o, key, where);
}

function endpoints(o: Unchecked, key: string, where: string): Endpoint[] | undefined {
  return optionalList(o, key, where)?.map((e, i) => {
    const at = `${where}: ${key}[${i}]`;
    const entry = object(e, at);
    const address = text(entry, "address", at);
    optionalText(entry, "provider", at);
    return { ...entry, address };
  });
}

export function parseChain(value: unknown): ChainJson {
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

export function parseAssets(value: unknown): AssetListJson {
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

export function parseArk(value: unknown): ArkJson {
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

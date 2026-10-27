import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { GenesisMismatch, Network, RegistryError, loadNetwork, registrySource } from "./network.js";
import type { ArkJson, AssetListJson, ChainJson, RegistryFiles } from "./types.js";

function files(name: string): RegistryFiles {
  const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../testdata/registry/${name}/${file}`, import.meta.url), "utf8")) as T;
  return { chain: read<ChainJson>("chain.json"), assets: read<AssetListJson>("assetlist.json"), ark: read<ArkJson>("ark.json") };
}

test("the localnet entry carries ports, every asset, and no genesis hash", () => {
  const n = Network.fromRegistry(files("arklocal"));
  assert.equal(n.chainId, "localark");
  assert.equal(n.bech32Prefix, "ark");
  assert.equal(n.validatorPrefix, "arkvaloper");
  assert.equal(n.slip44, 330);
  assert.equal(n.stakingDenom, "anoah");
  assert.equal(n.restUrl, "http://localhost:1317");
  assert.equal(n.endpoints.rpc[0]?.address, "http://localhost:26657");
  assert.equal(n.assets.size, 11);
  assert.equal(n.asset("ausd")?.exponent, 18);
  assert.equal(n.asset("ausd")?.symbol, "arkUSD");
  assert.equal(n.assetByUnit("noah")?.base, "anoah");
  assert.equal(n.asset("axdr"), undefined, "the reference unit has a feed and no asset");
  assert.equal(n.referenceDenom, "axdr");
  assert.deepEqual(n.feeDenoms.slice(0, 2), ["anoah", "aaud"]);
  assert.equal(n.features.conversion_open, true);
  assert.equal(n.genesisSha256, undefined);
  assert.equal(n.verifyGenesis(new Uint8Array([1, 2, 3])), "unverifiable");
});

test("mainnet lists NOAH alone until a vote registers the stablecoins", () => {
  const n = Network.fromRegistry(files("ark"));
  assert.equal(n.chainId, "ark-1");
  assert.deepEqual([...n.assets.keys()], ["anoah"]);
  assert.deepEqual(n.feeDenoms, ["anoah"]);
  assert.equal(n.features.conversion_open, false);
  assert.equal(n.restUrl, undefined);
  assert.equal(n.genesisSha256?.length, 64);
});

test("verifyGenesis hashes the file and refuses another", () => {
  const f = files("arktestnet");
  const genesis = new TextEncoder().encode('{"chain_id":"ark-testnet-1"}');
  f.ark.genesis_sha256 = Network.genesisHash(genesis);
  const n = Network.fromRegistry(f);
  assert.equal(n.verifyGenesis(genesis), "verified");
  assert.throws(() => n.verifyGenesis(new TextEncoder().encode("{}")), GenesisMismatch);
});

test("files that disagree are refused", () => {
  const cases: [string, (f: RegistryFiles) => void][] = [
    ["chain id", (f) => (f.ark.chain_id = "other")],
    ["chain name", (f) => (f.assets.chain_name = "other")],
    ["prefix", (f) => (f.ark.bech32_prefix = "cosmos")],
    ["slip44", (f) => (f.ark.slip44 = 118)],
    ["genesis hash shape", (f) => (f.ark.genesis_sha256 = "ABCD")],
    ["staking token", (f) => (f.chain.staking = { staking_tokens: [] })],
    ["duplicate asset", (f) => f.assets.assets.push(f.assets.assets[0]!)],
    ["display unit missing", (f) => (f.assets.assets[0]!.display = "x")],
  ];
  for (const [name, mutate] of cases) {
    const f = files("arktestnet");
    mutate(f);
    assert.throws(() => Network.fromRegistry(f), RegistryError, name);
  }
});

test("loadNetwork reads the three files from a source", async () => {
  const f = files("arklocal");
  const seen: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = url.endsWith("chain.json") ? f.chain : url.endsWith("assetlist.json") ? f.assets : f.ark;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const n = await loadNetwork("arklocal", { fetch: fetchStub });
  assert.equal(n.chainId, "localark");
  assert.deepEqual(seen.map((u) => u.replace(registrySource(), "")).sort(), ["/arklocal/ark.json", "/arklocal/assetlist.json", "/arklocal/chain.json"]);
  const missing = (async () => new Response("", { status: 404, statusText: "Not Found" })) as typeof fetch;
  await assert.rejects(loadNetwork("nowhere", { fetch: missing }), RegistryError);
});

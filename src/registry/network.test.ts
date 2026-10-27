import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NetworkMismatch, NodeVersionUnlisted, QueryClient } from "../query/client.js";
import { GenesisMismatch, loadNetwork, Network, RegistryError, registrySource } from "./network.js";
import type { ArkJson, AssetJson, AssetListJson, ChainJson, RegistryFiles } from "./types.js";

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

test("a file missing or mistyping a member the SDK reads is refused by name", () => {
  const cases: [string, (f: RegistryFiles) => void, RegExp][] = [
    ["feeds missing", (f) => delete (f.ark as Partial<ArkJson>).feeds, /ark\.json: feeds is missing/],
    ["fee_denoms not a list", (f) => ((f.ark as unknown as Record<string, unknown>).fee_denoms = "anoah"), /ark\.json: fee_denoms must be a list/],
    ["features missing", (f) => delete (f.ark as Partial<ArkJson>).features, /ark\.json: features is missing/],
    ["feature not a flag", (f) => ((f.ark.features as unknown as Record<string, unknown>).cosmwasm = "yes"), /features: cosmwasm must be true or false/],
    [
      "exponent as text",
      (f) => ((f.assets.assets[0]!.denom_units[0] as unknown as Record<string, unknown>).exponent = "18"),
      /denom_units\[0\]: exponent must be a whole number/,
    ],
    ["no denom units", (f) => (f.assets.assets[0]!.denom_units = []), /denom_units is empty/],
    ["asset without a symbol", (f) => delete (f.assets.assets[0] as Partial<AssetJson>).symbol, /assets\[0\]: symbol is missing/],
    [
      "endpoint without an address",
      (f) => (f.chain.apis!.rest = [{ address: 5 } as unknown as { address: string }]),
      /rest\[0\]: address must be a non-empty string/,
    ],
    ["slip44 as text", (f) => ((f.chain as unknown as Record<string, unknown>).slip44 = "330"), /chain\.json: slip44 must be a whole number/],
    [
      "compatible_versions with an empty entry",
      (f) => (f.chain.codebase!.compatible_versions = [""]),
      /compatible_versions must be a list of non-empty strings/,
    ],
    ["a file that is a list", (f) => ((f as unknown as Record<string, unknown>).ark = []), /ark\.json is not an object/],
  ];
  for (const [name, mutate, message] of cases) {
    const f = files("arklocal");
    mutate(f);
    assert.throws(
      () => Network.fromRegistry(f),
      (err: unknown) => err instanceof RegistryError && message.test(err.message),
      name,
    );
  }
});

test("the prefix and coin type must be the SDK's own, and an endpoint https unless on the loopback", () => {
  const other = files("arklocal");
  other.chain.bech32_prefix = "cosmos";
  other.ark.bech32_prefix = "cosmos";
  assert.throws(
    () => Network.fromRegistry(other),
    (err: unknown) => err instanceof RegistryError && /prefix cosmos is not ark/.test(err.message),
  );
  const coinType = files("arklocal");
  coinType.chain.slip44 = 118;
  coinType.ark.slip44 = 118;
  assert.throws(
    () => Network.fromRegistry(coinType),
    (err: unknown) => err instanceof RegistryError && /slip44 118 is not 330/.test(err.message),
  );

  const loopback = Network.fromRegistry(files("arklocal"));
  assert.equal(loopback.restUrl, "http://localhost:1317", "http on the loopback is accepted");
  for (const [name, address] of [
    ["plain http", "http://node.example.org:1317"],
    ["a private address over http", "http://192.168.1.10:1317"],
    ["not a URL", "node.example.org:1317"],
    ["another scheme", "ftp://node.example.org"],
  ]) {
    const f = files("arklocal");
    f.chain.apis!.rest = [{ address: address as string }];
    assert.throws(() => Network.fromRegistry(f), RegistryError, name as string);
  }
  const indexer = files("arklocal");
  indexer.ark.indexer = [{ address: "http://indexer.example.org" }];
  assert.throws(() => Network.fromRegistry(indexer), RegistryError, "an indexer is held to the same rule");
  const secure = files("arklocal");
  secure.chain.apis!.rest = [{ address: "https://node.example.org" }];
  secure.chain.apis!.rpc = [{ address: "http://127.0.0.1:26657" }];
  secure.chain.apis!.grpc = [{ address: "node.example.org:9090" }];
  assert.equal(Network.fromRegistry(secure).restUrl, "https://node.example.org");
  const versions = Network.fromRegistry(files("ark"));
  assert.deepEqual(versions.compatibleVersions, ["v0.1.0-alpha.1"]);
  assert.equal(versions.recommendedVersion, "v0.1.0-alpha.1");
});

test("verifyNetwork checks the chain id, reports the binary against the registry, and can hash the genesis", async () => {
  const network = Network.fromRegistry(files("arklocal"));
  const node = (chainId: string, version: string) =>
    (async () =>
      new Response(
        JSON.stringify({
          default_node_info: { network: chainId },
          application_version: {
            name: "ark",
            app_name: "arkd",
            version,
            git_commit: "abc",
            build_tags: "",
            go_version: "",
            build_deps: [],
            cosmos_sdk_version: "v0.54.4",
          },
        }),
        { status: 200 },
      )) as typeof fetch;

  const listed = await new QueryClient("http://node", { fetch: node("localark", "v0.1.0-alpha.1") }).verifyNetwork(network);
  assert.deepEqual(listed, { chainId: "localark", appName: "arkd", version: "v0.1.0-alpha.1", versionListed: true, genesis: "skipped" });

  const dev = new QueryClient("http://node", { fetch: node("localark", "v0.1.0-alpha.1-7-gdeadbee") });
  assert.equal((await dev.verifyNetwork(network)).versionListed, false, "an unlisted version is reported, not refused");
  await assert.rejects(
    dev.verifyNetwork(network, { requireListedVersion: true }),
    (err: unknown) => err instanceof NodeVersionUnlisted && err.version === "v0.1.0-alpha.1-7-gdeadbee",
  );

  await assert.rejects(new QueryClient("http://node", { fetch: node("ark-1", "v0.1.0-alpha.1") }).verifyNetwork(network), NetworkMismatch);

  const unlisted = files("arklocal");
  unlisted.chain.codebase!.compatible_versions = [];
  assert.equal(
    (await new QueryClient("http://node", { fetch: node("localark", "anything") }).verifyNetwork(Network.fromRegistry(unlisted))).versionListed,
    undefined,
  );

  // The genesis: fetched from the registry's URL, hashed against its hash.
  const genesis = new TextEncoder().encode('{"chain_id":"ark-testnet-1"}');
  const f = files("arktestnet");
  f.ark.genesis_sha256 = Network.genesisHash(genesis);
  f.chain.codebase!.genesis = { genesis_url: "https://example.org/genesis.json" };
  const withGenesis = Network.fromRegistry(f);
  const serving = (body: Uint8Array) =>
    (async (input: string | URL | Request) =>
      String(input).endsWith("genesis.json") ? new Response(body, { status: 200 }) : node("ark-testnet-1", "v0.1.0-alpha.1")(input)) as typeof fetch;
  assert.equal((await new QueryClient("http://node", { fetch: serving(genesis) }).verifyNetwork(withGenesis, { genesis: true })).genesis, "verified");
  await assert.rejects(
    new QueryClient("http://node", { fetch: serving(new TextEncoder().encode("{}")) }).verifyNetwork(withGenesis, { genesis: true }),
    GenesisMismatch,
  );
  assert.equal(
    (await new QueryClient("http://node", { fetch: node("localark", "v0.1.0-alpha.1") }).verifyNetwork(network, { genesis: true })).genesis,
    "unverifiable",
  );
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
  const notJson = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
  await assert.rejects(loadNetwork("arklocal", { fetch: notJson }), (err: unknown) => err instanceof RegistryError && /not JSON/.test(err.message));

  const pinned: string[] = [];
  const pinnedFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    pinned.push(url);
    const body = url.endsWith("chain.json") ? f.chain : url.endsWith("assetlist.json") ? f.assets : f.ark;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  await loadNetwork("arklocal", { ref: "0123abcd", fetch: pinnedFetch });
  assert.ok(
    pinned.every((u) => u.startsWith(`${registrySource("0123abcd")}/arklocal/`)),
    "a ref pins what is read",
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { registryFiles } from "../testing/fixtures.js";
import { json, stubFetch } from "../testing/node.js";
import { GenesisMismatch, loadNetwork, Network, RegistryError, registrySource } from "./network.js";
import type { ArkJson, AssetJson, RegistryFiles } from "./types.js";

test("the localnet entry carries ports, every asset, and no genesis hash", () => {
  const n = Network.fromRegistry(registryFiles("arklocal"));
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
  const n = Network.fromRegistry(registryFiles("ark"));
  assert.equal(n.chainId, "ark-1");
  assert.deepEqual([...n.assets.keys()], ["anoah"]);
  assert.deepEqual(n.feeDenoms, ["anoah"]);
  assert.equal(n.features.conversion_open, false);
  assert.equal(n.restUrl, undefined);
  assert.equal(n.genesisSha256?.length, 64);
});

test("verifyGenesis hashes the file and refuses another", () => {
  const f = registryFiles("arktestnet");
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
    const f = registryFiles("arktestnet");
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
    const f = registryFiles("arklocal");
    mutate(f);
    assert.throws(
      () => Network.fromRegistry(f),
      (err: unknown) => err instanceof RegistryError && message.test(err.message),
      name,
    );
  }
});

test("the prefix and coin type must be the SDK's own, and an endpoint https unless on the loopback", () => {
  const other = registryFiles("arklocal");
  other.chain.bech32_prefix = "cosmos";
  other.ark.bech32_prefix = "cosmos";
  assert.throws(
    () => Network.fromRegistry(other),
    (err: unknown) => err instanceof RegistryError && /prefix cosmos is not ark/.test(err.message),
  );
  const coinType = registryFiles("arklocal");
  coinType.chain.slip44 = 118;
  coinType.ark.slip44 = 118;
  assert.throws(
    () => Network.fromRegistry(coinType),
    (err: unknown) => err instanceof RegistryError && /slip44 118 is not 330/.test(err.message),
  );

  const loopback = Network.fromRegistry(registryFiles("arklocal"));
  assert.equal(loopback.restUrl, "http://localhost:1317", "http on the loopback is accepted");
  for (const [name, address] of [
    ["plain http", "http://node.example.org:1317"],
    ["a private address over http", "http://192.168.1.10:1317"],
    ["a name that starts like the loopback block", "http://127.attacker.example:1317"],
    ["a loopback address as a name's labels", "http://127.0.0.1.attacker.example:1317"],
    ["not a URL", "node.example.org:1317"],
    ["another scheme", "ftp://node.example.org"],
  ]) {
    const f = registryFiles("arklocal");
    f.chain.apis!.rest = [{ address: address as string }];
    assert.throws(() => Network.fromRegistry(f), RegistryError, name as string);
  }
  const indexer = registryFiles("arklocal");
  indexer.ark.indexer = [{ address: "http://indexer.example.org" }];
  assert.throws(() => Network.fromRegistry(indexer), RegistryError, "an indexer is held to the same rule");
  const secure = registryFiles("arklocal");
  secure.chain.apis!.rest = [{ address: "https://node.example.org" }];
  secure.chain.apis!.rpc = [{ address: "http://127.0.0.1:26657" }];
  secure.chain.apis!.grpc = [{ address: "node.example.org:9090" }];
  assert.equal(Network.fromRegistry(secure).restUrl, "https://node.example.org");
  for (const address of ["http://127.0.0.1:1317", "http://127.8.9.10:1317", "http://127.1:1317", "http://[::1]:1317", "http://node.localhost:1317"]) {
    const f = registryFiles("arklocal");
    f.chain.apis!.rest = [{ address }];
    assert.equal(Network.fromRegistry(f).restUrl, address, `${address} is the loopback`);
  }
  const versions = Network.fromRegistry(registryFiles("ark"));
  assert.deepEqual(versions.compatibleVersions, ["v0.1.0-alpha.1"]);
  assert.equal(versions.recommendedVersion, "v0.1.0-alpha.1");
});

test("loadNetwork reads the three files from a source", async () => {
  const f = registryFiles("arklocal");
  const registry = () => stubFetch(({ url }) => json(url.endsWith("chain.json") ? f.chain : url.endsWith("assetlist.json") ? f.assets : f.ark));
  const main = registry();
  const n = await loadNetwork("arklocal", { fetch: main.fetch });
  assert.equal(n.chainId, "localark");
  assert.deepEqual(main.seen.map((s) => s.url.replace(registrySource(), "")).sort(), [
    "/arklocal/ark.json",
    "/arklocal/assetlist.json",
    "/arklocal/chain.json",
  ]);
  const missing = stubFetch(() => new Response("", { status: 404, statusText: "Not Found" }));
  await assert.rejects(loadNetwork("nowhere", { fetch: missing.fetch }), RegistryError);
  const notJson = stubFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(loadNetwork("arklocal", { fetch: notJson.fetch }), (err: unknown) => err instanceof RegistryError && /not JSON/.test(err.message));

  const pinned = registry();
  await loadNetwork("arklocal", { ref: "0123abcd", fetch: pinned.fetch });
  assert.ok(
    pinned.seen.every((s) => s.url.startsWith(`${registrySource("0123abcd")}/arklocal/`)),
    "a ref pins what is read",
  );
});

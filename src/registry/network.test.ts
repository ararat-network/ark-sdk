import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAssetAmount } from "../format/amount.js";
import { registryFiles } from "../testing/fixtures.js";
import { GenesisMismatch, Network } from "./network.js";
import { RegistryError } from "./parse.js";
import type { ArkFeatures, ArkJson, AssetJson, Endpoint, Explorer, RegistryFiles } from "./types.js";

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

type Refusal = [name: string, change: (f: RegistryFiles) => void, message: RegExp];

/** Each case changes the local network's files one way, and the network is refused with a RegistryError that says why. */
function refused(cases: Refusal[]): void {
  for (const [name, change, message] of cases) {
    const f = registryFiles("arklocal");
    change(f);
    assert.throws(
      () => Network.fromRegistry(f),
      (err: unknown) => err instanceof RegistryError && message.test(err.message),
      name,
    );
  }
}

test("a file missing or mistyping a member the SDK reads is refused by name", () => {
  const cases: Refusal[] = [
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
  refused(cases);
});

test("the prefix and coin type must be the SDK's own, and an endpoint https unless on the loopback", () => {
  refused([
    ["another chain's prefix", (f) => (f.chain.bech32_prefix = f.ark.bech32_prefix = "cosmos"), /prefix cosmos is not ark/],
    ["another chain's coin type", (f) => (f.chain.slip44 = f.ark.slip44 = 118), /slip44 118 is not 330/],
    // An indexer is held to the endpoint rule, and named for the file it is in.
    ["an indexer over http", (f) => (f.ark.indexer = [{ address: "http://indexer.example.org" }]), /ark\.json indexer endpoint http:\/\/indexer\.example\.org/],
    // The rpc endpoints and the genesis file's address are held to the rule too: the SDK sends requests to both.
    [
      "an rpc endpoint over http",
      (f) => (f.chain.apis!.rpc = [{ address: "http://rpc.example.org:26657" }]),
      /chain\.json rpc endpoint http:\/\/rpc\.example\.org/,
    ],
    [
      "a genesis file over http",
      (f) => (f.chain.codebase = { ...f.chain.codebase, genesis: { genesis_url: "http://files.example.org/genesis.json" } }),
      /chain\.json genesis_url/,
    ],
    // The genesis hash is compared as lowercase hex, so one written otherwise would never match.
    ["a genesis hash in uppercase", (f) => (f.ark.genesis_sha256 = "AB".repeat(32)), /genesis_sha256 is not 64 lowercase hex/],
  ]);
  const hashed = registryFiles("arktestnet");
  hashed.ark.genesis_sha256 = "ab".repeat(32);
  assert.equal(Network.fromRegistry(hashed).genesisSha256, "ab".repeat(32));

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

test("a network is built from checked copies of what the files hold", () => {
  const f = registryFiles("arklocal");
  // Members the SDK does not name ride along on what a network hands on as it was written.
  const rest = f.chain.apis!.rest![0] as Endpoint & { archive?: boolean };
  rest.archive = true;
  f.chain.explorers = [{ kind: "explorer", url: "https://explorer.example", tx_page: "https://explorer.example/tx" } as Explorer];
  const features = f.ark.features as ArkFeatures & Record<string, unknown>;
  const named = { cosmwasm: features.cosmwasm, vote_extensions: features.vote_extensions, conversion_open: features.conversion_open };
  features.ibc = true;
  features.note = "not a flag";

  // The files as plain JSON, typed as nothing: every member is checked, none taken on trust.
  const unchecked: { chain: unknown; assets: unknown; ark: unknown } = f;
  const n = Network.fromRegistry(unchecked);
  assert.equal(rest.address, "http://localhost:1317");
  assert.deepEqual(n.endpoints.rest[0], { ...rest }, "the endpoint with its unnamed member, in a copy");
  assert.notEqual(n.endpoints.rest[0], rest);
  assert.equal((n.endpoints.explorers[0] as Record<string, unknown>).tx_page, "https://explorer.example/tx");
  assert.notEqual(n.endpoints.explorers[0], f.chain.explorers[0], "an explorer is a copy too");
  assert.deepEqual(n.features, { ...named, ibc: true }, "a flag the SDK does not name yet is kept; a member that is not a flag is not");

  // The network shares no object with the files: changing them afterwards changes nothing.
  rest.address = "http://localhost:9999";
  f.chain.explorers[0]!.url = "https://elsewhere.example";
  f.ark.feeds.push("ajunk");
  features.cosmwasm = !features.cosmwasm;
  assert.equal(n.restUrl, "http://localhost:1317");
  assert.equal(n.endpoints.explorers[0]?.url, "https://explorer.example");
  assert.ok(!n.feeds.includes("ajunk"));
  assert.equal(n.features.cosmwasm, named.cosmwasm);
});

test("a name belongs to one unit of an asset, so the display unit's exponent is its own", () => {
  const withUnits = (display: string, units: AssetJson["denom_units"]) => {
    const f = registryFiles("arklocal");
    const usd = f.assets.assets.find((a) => a.base === "ausd")!;
    usd.display = display;
    usd.denom_units = units;
    return f;
  };
  // Another unit's alias matching the display: the exponent read was the alias's, 0, and one display unit became one base unit.
  assert.throws(
    () =>
      Network.fromRegistry(
        withUnits("usd", [
          { denom: "ausd", exponent: 0, aliases: ["usd"] },
          { denom: "usd", exponent: 18 },
        ]),
      ),
    (err: unknown) => err instanceof RegistryError && /asset ausd: usd names two units, at exponents 0 and 18/.test(err.message),
  );
  // The display unit listed twice.
  assert.throws(
    () =>
      Network.fromRegistry(
        withUnits("usd", [
          { denom: "ausd", exponent: 0 },
          { denom: "usd", exponent: 6 },
          { denom: "usd", exponent: 18 },
        ]),
      ),
    RegistryError,
  );
  // Two units sharing an alias.
  assert.throws(
    () =>
      Network.fromRegistry(
        withUnits("usd", [
          { denom: "ausd", exponent: 0, aliases: ["dollar"] },
          { denom: "usd", exponent: 18, aliases: ["dollar"] },
        ]),
      ),
    RegistryError,
  );

  // An alias of the unit's own is another name for it, and nothing else.
  const aliased = Network.fromRegistry(
    withUnits("usd", [
      { denom: "ausd", exponent: 0, aliases: ["attousd"] },
      { denom: "usd", exponent: 18, aliases: ["dollar", "usd"] },
    ]),
  );
  const asset = aliased.asset("ausd")!;
  assert.equal(asset.exponent, 18);
  assert.equal(asset.unit("dollar").exponent, 18);
  assert.equal(asset.unit("attousd").exponent, 0);
});

test("a unit's exponent is at most the places a 256-bit amount has", () => {
  const withExponent = (exponent: number) => {
    const f = registryFiles("arklocal");
    const usd = f.assets.assets.find((a) => a.base === "ausd")!;
    usd.denom_units = [
      { denom: "ausd", exponent: 0 },
      { denom: usd.display, exponent },
    ];
    return f;
  };
  // 1e21 is a whole number, and a unit of that many places made the formatters throw the runtime's RangeError.
  for (const exponent of [78, 1000, 1e21]) {
    assert.throws(
      () => Network.fromRegistry(withExponent(exponent)),
      (err: unknown) => err instanceof RegistryError && /exponent .* is more than 77/.test(err.message),
      String(exponent),
    );
  }
  const widest = Network.fromRegistry(withExponent(77)).asset("ausd")!;
  assert.equal(widest.exponent, 77);
  assert.equal(formatAssetAmount(10n ** 77n, widest, { locale: "en-US", symbol: false }), "1");
});

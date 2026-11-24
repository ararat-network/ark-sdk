// The client's own behaviour beyond a facade's one call: checking a node
// against the registry's network, and reading an account by its type.
import assert from "node:assert/strict";
import { test } from "node:test";

import { vestedCoins } from "../decode/account.js";
import { GenesisMismatch, Network } from "../registry/network.js";
import { amounts, registryFiles } from "../testing/fixtures.js";
import { json, stubFetch } from "../testing/node.js";
import { NetworkMismatch, NodeVersionUnlisted, QueryClient } from "./client.js";

test("verifyNetwork checks the chain id, reports the binary against the registry, and can hash the genesis", async () => {
  const network = Network.fromRegistry(registryFiles("arklocal"));
  const info = (chainId: string, version: string) =>
    json({
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
    });
  const node = (chainId: string, version: string) => stubFetch(() => info(chainId, version)).fetch;

  const listed = await new QueryClient("http://node", { fetch: node("localark", "v0.1.0-alpha.1") }).verifyNetwork(network);
  assert.deepEqual(listed, { chainId: "localark", appName: "arkd", version: "v0.1.0-alpha.1", versionListed: true, genesis: "skipped" });

  const dev = new QueryClient("http://node", { fetch: node("localark", "v0.1.0-alpha.1-7-gdeadbee") });
  assert.equal((await dev.verifyNetwork(network)).versionListed, false, "an unlisted version is reported, not refused");
  await assert.rejects(
    dev.verifyNetwork(network, { requireListedVersion: true }),
    (err: unknown) => err instanceof NodeVersionUnlisted && err.version === "v0.1.0-alpha.1-7-gdeadbee",
  );

  await assert.rejects(new QueryClient("http://node", { fetch: node("ark-1", "v0.1.0-alpha.1") }).verifyNetwork(network), NetworkMismatch);

  const unlisted = registryFiles("arklocal");
  unlisted.chain.codebase!.compatible_versions = [];
  assert.equal(
    (await new QueryClient("http://node", { fetch: node("localark", "anything") }).verifyNetwork(Network.fromRegistry(unlisted))).versionListed,
    undefined,
  );

  // The genesis: fetched from the registry's URL, hashed against its hash.
  const genesis = new TextEncoder().encode('{"chain_id":"ark-testnet-1"}');
  const f = registryFiles("arktestnet");
  f.ark.genesis_sha256 = Network.genesisHash(genesis);
  f.chain.codebase!.genesis = { genesis_url: "https://example.org/genesis.json" };
  const withGenesis = Network.fromRegistry(f);
  const serving = (body: Uint8Array) =>
    stubFetch(({ url }) => (url.endsWith("genesis.json") ? new Response(body, { status: 200 }) : info("ark-testnet-1", "v0.1.0-alpha.1"))).fetch;
  assert.equal((await new QueryClient("http://node", { fetch: serving(genesis) }).verifyNetwork(withGenesis, { genesis: true })).genesis, "verified");
  // A browser's fetch refuses a receiver that is not its window; the genesis file is fetched without one.
  const strict = async function (this: unknown, input: string | URL | Request): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return serving(genesis)(input);
  } as typeof fetch;
  assert.equal((await new QueryClient("http://node", { fetch: strict }).verifyNetwork(withGenesis, { genesis: true })).genesis, "verified");
  await assert.rejects(
    new QueryClient("http://node", { fetch: serving(new TextEncoder().encode("{}")) }).verifyNetwork(withGenesis, { genesis: true }),
    GenesisMismatch,
  );
  assert.equal(
    (await new QueryClient("http://node", { fetch: node("localark", "v0.1.0-alpha.1") }).verifyNetwork(network, { genesis: true })).genesis,
    "unverifiable",
  );
});

test("decodedAccount reads the gateway's JSON for a vesting account", async () => {
  const address = "ark1fec7dnxl3fre9zmc3kyvtt357de3ek9fnlu96j";
  const NOAH = 10n ** 18n;
  const YEAR = 31_536_000n;
  const genesis = 1_800_000_000n;
  const body = {
    account: {
      "@type": "/cosmos.vesting.v1beta1.ContinuousVestingAccount",
      base_vesting_account: {
        base_account: { address, pub_key: null, account_number: "5", sequence: "1" },
        original_vesting: [{ denom: "anoah", amount: "5000000000000000000000000" }],
        delegated_free: [],
        delegated_vesting: [],
        end_time: String(genesis + 8n * YEAR),
      },
      start_time: String(genesis + 4n * YEAR),
    },
  };
  const client = new QueryClient("http://node", { fetch: stubFetch(() => json(body)).fetch });
  const a = await client.auth.decodedAccount(address);
  assert.equal(a.kind, "continuous_vesting");
  assert.deepEqual(amounts(vestedCoins(a, genesis + 6n * YEAR)), [`${2_500_000n * NOAH}anoah`]);
});

test("decodedAccount names an account of a type the registry lacks as unknown, with its type URL", async () => {
  const { fetch } = stubFetch(() => json({ account: { "@type": "/ark.future.v1.SeatAccount", address: "ark1x" } }));
  const decoded = await new QueryClient("http://node", { fetch }).auth.decodedAccount("ark1x");
  assert.equal(decoded.kind, "unknown");
  assert.equal(decoded.typeUrl, "/ark.future.v1.SeatAccount");
  assert.equal(decoded.message, undefined);
});

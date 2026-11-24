import assert from "node:assert/strict";
import { test } from "node:test";
import { registryFiles } from "../testing/fixtures.js";
import { json, stubFetch } from "../testing/node.js";
import { loadNetwork, registrySource } from "./load.js";
import { RegistryError } from "./parse.js";

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

test("loadNetwork takes a registry directory's name and a git ref, and nothing that names other files", async () => {
  const f = registryFiles("arklocal");
  const registry = () => stubFetch(({ url }) => json(url.endsWith("chain.json") ? f.chain : url.endsWith("assetlist.json") ? f.assets : f.ark));

  // The name and the ref become part of the URL. Each of these would have read another directory or another repository.
  for (const name of [
    "../../../evil/repo/main/arklocal",
    "arklocal/../ark",
    "arklocal/",
    "/arklocal",
    "..",
    ".",
    "",
    "%2e%2e",
    "ark.local",
    "Arklocal",
    "ark local",
    "arklocal?x",
    "arklocal#x",
    "ark--local",
  ]) {
    const none = registry();
    await assert.rejects(
      loadNetwork(name, { fetch: none.fetch }),
      (err: unknown) => err instanceof RegistryError && /not a registry directory/.test(err.message),
      JSON.stringify(name),
    );
    assert.equal(none.seen.length, 0, `nothing is requested for ${JSON.stringify(name)}`);
  }
  for (const ref of [
    "../../evil/repo/main",
    "..",
    "main/../../evil",
    "/main",
    "main/",
    "a//b",
    "%2e%2e",
    "main?x",
    "main#x",
    ".hidden",
    "a..b",
    "v1.",
    "main\\x",
    "main x",
    "",
  ]) {
    const none = registry();
    await assert.rejects(
      loadNetwork("arklocal", { ref, fetch: none.fetch }),
      (err: unknown) => err instanceof RegistryError && /not a branch, tag, or commit/.test(err.message),
      JSON.stringify(ref),
    );
    assert.equal(none.seen.length, 0, `nothing is requested for the ref ${JSON.stringify(ref)}`);
    assert.throws(() => registrySource(ref), RegistryError);
  }
  // A branch, a tag, a commit, and a branch with a slash in its name all stay inside the registry's repository.
  for (const ref of ["main", "0123abcd", "v0.1.0", "release/v1", "feature/a_b-c.1"]) {
    const read = registry();
    assert.equal((await loadNetwork("arklocal", { ref, fetch: read.fetch })).chainId, "localark");
    assert.ok(read.seen.every((s) => s.url.startsWith(`https://raw.githubusercontent.com/ararat-network/ark-registry/${ref}/arklocal/`)));
  }
});

test("loadNetwork refuses files that describe another network, and reports a failed request as a registry error", async () => {
  // The testnet's directory serving the localnet's files: well formed, and not what was asked for.
  const local = registryFiles("arklocal");
  const misfiled = stubFetch(({ url }) => json(url.endsWith("chain.json") ? local.chain : url.endsWith("assetlist.json") ? local.assets : local.ark));
  await assert.rejects(
    loadNetwork("arktestnet", { fetch: misfiled.fetch }),
    (err: unknown) => err instanceof RegistryError && /describes the network arklocal, not arktestnet/.test(err.message),
  );
  assert.equal(
    (await loadNetwork("arklocal", { source: "https://mirror.example/registry", fetch: misfiled.fetch })).name,
    "arklocal",
    "a source of the caller's is held to the same",
  );
  await assert.rejects(loadNetwork("arktestnet", { source: "https://mirror.example/registry", fetch: misfiled.fetch }), RegistryError);

  const failure = new TypeError("fetch failed");
  const down = stubFetch(() => {
    throw failure;
  });
  await assert.rejects(loadNetwork("arklocal", { fetch: down.fetch }), (err: unknown) => {
    assert.ok(err instanceof RegistryError, "not the runtime's own error");
    assert.match(err.message, /arklocal\/(chain|assetlist|ark)\.json: fetch failed/);
    assert.equal(err.cause, failure);
    return true;
  });
  const notJson = stubFetch(() => new Response("<html>", { status: 200 }));
  await assert.rejects(loadNetwork("arklocal", { fetch: notJson.fetch }), (err: unknown) => err instanceof RegistryError && err.cause instanceof SyntaxError);
});

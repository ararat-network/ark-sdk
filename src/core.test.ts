// The core entry is the main entry without the full registry: the same
// names, each taking its registry as an argument, and no module beneath it
// importing every generated type.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { create, createRegistry } from "@bufbuild/protobuf";

import { fromBase64, fromHex } from "./codec/bytes.js";
import { registry } from "./codec/registry.js";
import * as core from "./core.js";
import { MsgSendSchema } from "./gen/cosmos/bank/v1beta1/tx_pb.js";
import * as main from "./index.js";
import { MemorySigner } from "./keys/memory_signer.js";
import { SignerError } from "./keys/signer.js";
import { fixture, fixtureKey } from "./testing/fixtures.js";
import { json, stubFetch } from "./testing/node.js";

test("only the defaulting layer imports the full registry", () => {
  const root = new URL(".", import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = `${dir}${name}`;
      if (statSync(path).isDirectory()) return name === "gen" || name === "testing" ? [] : walk(`${path}/`);
      return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });
  const importing = walk(root)
    .filter((path) => /from "[^"]*\/(registry|files)\.js"/.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(root.length))
    .sort();
  // The registry itself reads the generated file list; nothing else under the core entry may reach either.
  assert.deepEqual(importing, ["codec/registry.ts", "defaults.ts", "index.ts"]);
  // Nor may it reach them through the defaulting layer, which only the main entry imports.
  const defaulting = walk(root)
    .filter((path) => /from "[^"]*\/defaults\.js"/.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(root.length));
  assert.deepEqual(defaulting, ["index.ts"]);
});

test("the core entry exports every name the main entry does, but for the full registry", () => {
  assert.deepEqual(
    Object.keys(core).sort(),
    Object.keys(main)
      .filter((name) => name !== "registry")
      .sort(),
  );
  // Compared with === here and below: a registry prints as over a million lines, and a failed assert.equal diffs both sides.
  assert.ok(main.registry === registry);
});

test("a core reader given the full registry answers as the main entry's does", () => {
  const f = fixture("multi_message");
  const bytes = fromBase64(f.tx_bytes!);
  assert.deepEqual(core.decodeTx(bytes, { registry }).json, main.decodeTx(bytes).json);
  // Each event's schema is compared by name, for the same reason.
  const named = (events: ReturnType<typeof core.decodeEvents>) => events.map((e) => ({ ...e, schema: e.schema?.typeName }));
  assert.deepEqual(named(core.decodeEvents(f.events!, { registry })), named(main.decodeEvents(f.events!)));
  const send = create(MsgSendSchema, { fromAddress: "ark1a", toAddress: "ark1b", amount: [{ denom: "ausd", amount: "1" }] });
  assert.deepEqual(core.toProtoJson(MsgSendSchema, send, { registry }), main.toProtoJson(MsgSendSchema, send));
});

test("a core reader resolves an Any against the registry it is given and no other", () => {
  const bytes = fromBase64(fixture("bank_send_taxed").tx_bytes!);
  // A registry that knows only MsgSend: the message decodes, and a registry that knows nothing names it unknown.
  const [known] = core.decodeTx(bytes, { registry: createRegistry(MsgSendSchema) }).messages;
  assert.equal(known?.known, true);
  const [unknown] = core.decodeTx(bytes, { registry: createRegistry() }).messages;
  assert.equal(unknown?.known, false);
  assert.equal(unknown?.typeUrl, "/cosmos.bank.v1beta1.MsgSend");
});

test("a core client takes its registry, and the main entry's is the same client with the registry defaulted", async () => {
  const own = createRegistry();
  const { fetch } = stubFetch(() => json({ default_node_info: { network: "localark" }, application_version: null }));
  const client = new core.QueryClient("http://node", { fetch, registry: own });
  assert.ok(client.gateway.registry === own);
  assert.equal((await client.node.info()).defaultNodeInfo?.network, "localark");

  const defaulted = new main.QueryClient("http://node", { fetch });
  assert.ok(defaulted instanceof core.QueryClient, "what takes a core client takes the main entry's");
  assert.ok(defaulted.gateway.registry === registry);
  assert.ok(new main.GatewayClient("http://node") instanceof core.GatewayClient);
});

test("core signTx needs a registry for amino mode only", async () => {
  const signer = MemorySigner.fromPrivateKey(fromHex(fixtureKey("trader").private_key_hex));
  const send = core.typed(MsgSendSchema, create(MsgSendSchema, { fromAddress: signer.address, toAddress: signer.address }));
  const input = {
    signer,
    address: signer.address,
    chainId: "localark",
    accountNumber: 1n,
    sequence: 0n,
    messages: [send],
    fee: core.makeFee({ amount: [], gasLimit: 1n }),
  };
  assert.equal((await core.signTx(input)).mode, "direct", "direct mode reads no registry");
  await assert.rejects(core.signTx({ ...input, mode: "amino" }), (err: unknown) => err instanceof SignerError && /needs a registry/.test(err.message));
  const amino = await core.signTx({ ...input, mode: "amino", registry: createRegistry(MsgSendSchema) });
  assert.equal(amino.aminoSignDoc?.msgs[0]?.type, "cosmos-sdk/MsgSend");
  assert.equal((await main.signTx({ ...input, mode: "amino" })).aminoSignDoc?.msgs[0]?.type, "cosmos-sdk/MsgSend", "the main entry defaults it");
});

// Compile-time: the core entry takes its registry as an argument, so leaving it out does not type-check.
void (() => {
  const bytes = new Uint8Array();
  // @ts-expect-error the registry is required
  core.decodeTx(bytes);
  // @ts-expect-error the registry is required
  core.toProtoJson(MsgSendSchema, create(MsgSendSchema));
  // @ts-expect-error the registry is required
  new core.QueryClient("http://node");
  // @ts-expect-error the registry is required
  new core.GatewayClient("http://node", {});
  // The main entry defaults each of them.
  main.decodeTx(bytes);
  main.toProtoJson(MsgSendSchema, create(MsgSendSchema));
  new main.QueryClient("http://node");
  new main.GatewayClient("http://node", {});
});

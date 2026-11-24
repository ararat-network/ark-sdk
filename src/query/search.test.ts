import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../codec/json.js";
import { registry } from "../codec/registry.js";
import { QueryClient } from "../defaults.js";
import { fixture } from "../testing/fixtures.js";
import { json, stubFetch } from "../testing/node.js";
import { FUTURE_MSG_URL, registryWithFutureTypes } from "../testing/registry.js";
import { fetchTx, lookUpTx, searchTxs, txQuery, WrongTransaction } from "./search.js";

const f = fixture("multi_message");
const found = {
  txs: [f.tx],
  tx_responses: [
    {
      height: String(f.height),
      txhash: f.tx_hash,
      codespace: f.result!.codespace,
      code: f.result!.code,
      data: "",
      raw_log: "",
      logs: [],
      info: "",
      gas_wanted: f.result!.gas_wanted,
      gas_used: f.result!.gas_used,
      tx: { "@type": "/cosmos.tx.v1beta1.Tx", ...f.tx },
      timestamp: "2023-11-14T22:13:27Z",
      events: f.events,
    },
  ],
  pagination: null,
  total: "1",
};

function stub(reply: () => Response) {
  const { fetch, seen } = stubFetch(reply);
  return { client: new QueryClient("http://node", { fetch }), seen };
}

test("searchTxs sends the query and decodes each result the one way", async () => {
  const { client, seen } = stub(() => json(found));
  const sender = f.signer!.address;
  const result = await searchTxs(client, txQuery.bySender(sender), { limit: 20n });
  const url = new URL(seen[0]!.url);
  assert.equal(url.pathname, "/cosmos/tx/v1beta1/txs");
  assert.equal(url.searchParams.get("query"), `message.sender='${sender}'`);
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("order_by"), "ORDER_BY_DESC");
  assert.equal(result.total, 1n);
  const [item] = result.items;
  assert.ok(item);
  assert.equal(item.hash, f.tx_hash);
  assert.equal(item.height, BigInt(f.height));
  assert.deepEqual(item.outcome, { kind: "ok" });
  assert.deepEqual(
    item.messages.map((m) => m.typeUrl),
    ["/cosmos.bank.v1beta1.MsgSend", "/cosmos.staking.v1beta1.MsgDelegate"],
  );
  assert.equal(item.events.length, f.events!.length);
  assert.equal(item.gasUsed, BigInt(f.result!.gas_used));
  assert.equal(item.timestamp, "2023-11-14T22:13:27Z");
  assert.equal(txQuery.and(txQuery.byRecipient("ark1x"), txQuery.byHeight(7n)), "transfer.recipient='ark1x' AND tx.height=7");
});

test("a message of a type the registry lacks is one unknown message, not a failed page", async () => {
  const future = { "@type": "/ark.future.v1.MsgNew", sender: "ark1x", amount: "5" };
  const tx = structuredClone(f.tx!);
  (tx.body.messages as JsonValue[]).push(future);
  const page = { ...found, txs: [tx], tx_responses: [{ ...found.tx_responses[0], tx: { "@type": "/cosmos.tx.v1beta1.Tx", ...tx } }] };
  const { client } = stub(() => json(page));
  const [item] = (await searchTxs(client, "message.sender='ark1x'")).items;
  assert.ok(item);
  assert.deepEqual(
    item.messages.map((m) => [m.typeUrl, m.known]),
    [
      ["/cosmos.bank.v1beta1.MsgSend", true],
      ["/cosmos.staking.v1beta1.MsgDelegate", true],
      ["/ark.future.v1.MsgNew", false],
    ],
  );
  const unknown = item.messages[2]!;
  assert.equal(unknown.message, undefined);
  // Compared with ===: a schema prints as over a million lines, and a failed assert.equal diffs both sides.
  assert.ok(unknown.schema === undefined);
  assert.deepEqual(unknown.json, future, "the node's own JSON is what is shown for it");
});

test("searchTxs and fetchTx decode with the client's registry unless another is given", async () => {
  const future = { "@type": FUTURE_MSG_URL, sender: "ark1x", amount: "5" };
  const tx = structuredClone(f.tx!);
  (tx.body.messages as JsonValue[]).push(future);
  const response = { ...found.tx_responses[0], tx: { "@type": "/cosmos.tx.v1beta1.Tx", ...tx } };
  const { fetch } = stubFetch(({ url }) =>
    url.includes("/txs/") ? json({ tx, tx_response: response }) : json({ ...found, txs: [tx], tx_responses: [response] }),
  );
  // A client on a newer release's types: its registry knows a message the generated files lack.
  const client = new QueryClient("http://node", { fetch, registry: registryWithFutureTypes() });
  const [item] = (await searchTxs(client, "message.sender='ark1x'")).items;
  assert.equal(item?.messages[2]?.known, true, "the search decodes with the registry the answer was read with");
  assert.deepEqual(item?.messages[2]?.json, future);
  assert.equal((await fetchTx(client, f.tx_hash!))?.messages[2]?.known, true);

  // Another registry, given explicitly, is the one used: the default lacks the type, so the message is unknown with its bytes.
  const [narrow] = (await searchTxs(client, "message.sender='ark1x'", { registry })).items;
  assert.equal(narrow?.messages[2]?.known, false);
  assert.equal((await fetchTx(client, f.tx_hash!, registry))?.messages[2]?.known, false);
});

test("a known message around one the registry lacks is unknown with the node's JSON, whatever registry decodes it", async () => {
  const future = { "@type": FUTURE_MSG_URL, sender: "ark1x", amount: "5" };
  const exec = { "@type": "/cosmos.authz.v1beta1.MsgExec", grantee: "ark1g", msgs: [future] };
  const tx = structuredClone(f.tx!);
  (tx.body.messages as JsonValue[]).push(exec);
  const response = { ...found.tx_responses[0], tx: { "@type": "/cosmos.tx.v1beta1.Tx", ...tx } };
  const { fetch } = stubFetch(({ url }) =>
    url.includes("/txs/") ? json({ tx, tx_response: response }) : json({ ...found, txs: [tx], tx_responses: [response] }),
  );
  // The client's registry knows the exec and lacks what it carries. Decoding with a registry that knows both must
  // not show the inner message under its type with empty members: the answer was read without it.
  const client = new QueryClient("http://node", { fetch });
  const wider = registryWithFutureTypes();
  const items = [
    (await searchTxs(client, "message.sender='ark1x'")).items[0],
    (await searchTxs(client, "message.sender='ark1x'", { registry: wider })).items[0],
    await fetchTx(client, f.tx_hash!),
    await fetchTx(client, f.tx_hash!, wider),
  ];
  for (const item of items) {
    const message = item?.messages[2];
    assert.equal(message?.typeUrl, "/cosmos.authz.v1beta1.MsgExec");
    assert.equal(message?.known, false);
    assert.equal(message?.message, undefined);
    assert.deepEqual(message?.json, exec, "the inner message keeps the sender and amount the node sent");
    assert.equal(item?.messages[0]?.known, true, "the messages beside it decode as before");
  }
});

test("fetchTx returns undefined for a pending hash and the decoded transaction otherwise", async () => {
  const notFound = stub(() => json({ code: 5, message: "tx not found", details: [] }, 404));
  // A found transaction carries its messages' schemas, so this too is compared with ===.
  assert.ok((await fetchTx(notFound.client, f.tx_hash!)) === undefined);
  const ok = stub(() => json({ tx: f.tx, tx_response: found.tx_responses[0] }));
  const item = await fetchTx(ok.client, f.tx_hash!);
  assert.equal(item?.messages.length, 2);
  const broken = stub(() => new Response("<html>", { status: 500 }));
  await assert.rejects(fetchTx(broken.client, f.tx_hash!));
});

test("fetchTx refuses an answer for another transaction, and takes the hash in either case", async () => {
  const answer = stub(() => json({ tx: f.tx, tx_response: found.tx_responses[0] }));
  const other = "AA".repeat(32);
  await assert.rejects(fetchTx(answer.client, other), (err: unknown) => err instanceof WrongTransaction && err.hash === other && err.answered === f.tx_hash);
  assert.equal((await fetchTx(answer.client, f.tx_hash!.toLowerCase()))?.hash, f.tx_hash, "case is not a difference");
  // An answer that names no transaction is refused too: empty, it would read as a success at height zero.
  const unnamed = stub(() => json({ tx: null, tx_response: {} }));
  await assert.rejects(fetchTx(unnamed.client, other), (err: unknown) => err instanceof WrongTransaction && err.hash === other && err.answered === "");
  const [raw] = [await lookUpTx(answer.client, f.tx_hash!)];
  assert.equal(raw?.response.txhash, f.tx_hash, "lookUpTx returns the node's answer undecoded");
  assert.equal(raw?.tx?.body?.messages.length, 2);
});

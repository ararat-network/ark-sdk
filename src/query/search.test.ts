import assert from "node:assert/strict";
import { test } from "node:test";

import { fixture } from "../testing/fixtures.js";
import { QueryClient } from "./client.js";
import { fetchTx, searchTxs, txQuery } from "./search.js";

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
      tx: { "@type": "/cosmos.tx.v1beta1.Tx", ...(f.tx as object) },
      timestamp: "2023-11-14T22:13:27Z",
      events: f.events,
    },
  ],
  pagination: null,
  total: "1",
};

function stub(reply: (url: string) => Response) {
  const urls: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return reply(String(input));
  }) as typeof fetch;
  return { client: new QueryClient("http://node", { fetch: fetchStub }), urls };
}

test("searchTxs sends the query and decodes each result the one way", async () => {
  const { client, urls } = stub(() => new Response(JSON.stringify(found)));
  const sender = f.signer!.address;
  const result = await searchTxs(client, txQuery.bySender(sender), { limit: 20n });
  const url = new URL(urls[0]!);
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

test("fetchTx returns undefined for a pending hash and the decoded transaction otherwise", async () => {
  const notFound = stub(() => new Response(JSON.stringify({ code: 5, message: "tx not found", details: [] }), { status: 404 }));
  assert.equal(await fetchTx(notFound.client, f.tx_hash!), undefined);
  const ok = stub(() => new Response(JSON.stringify({ tx: f.tx, tx_response: found.tx_responses[0] })));
  const item = await fetchTx(ok.client, f.tx_hash!);
  assert.equal(item?.messages.length, 2);
  const broken = stub(() => new Response("<html>", { status: 500 }));
  await assert.rejects(fetchTx(broken.client, f.tx_hash!));
});

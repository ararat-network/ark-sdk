import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { packAny } from "../codec/any.js";
import { GrantKind } from "../gen/ark/disbursement/v1/disbursement_pb.js";
import { Query as DisbursementQuery } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as TreasuryQuery } from "../gen/ark/treasury/v1/query_pb.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { Service as TxService } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import { fixtureKeys } from "../testing/fixtures.js";
import { QueryClient } from "./client.js";
import { EndpointsExhausted, GatewayClient, GrpcCode, QueryError, routeFor, TransportError } from "./gateway.js";

interface Seen {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

function stub(reply: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  return { fetch: fetchStub, seen };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

test("routes come from the http option: path parameters, query parameters, and bodies", () => {
  const member = routeFor(DisbursementQuery.method.member, { address: "ark1abc" });
  assert.deepEqual(member, { verb: "GET", path: "/ark/disbursement/v1/members/ark1abc", body: undefined });

  const grants = routeFor(DisbursementQuery.method.grants, {
    beneficiary: "",
    committee_term: "0",
    registrar_term: "2",
    pagination: { limit: "10", key: "", count_total: true, reverse: false },
    kind: "GRANT_KIND_MEMBER",
  });
  assert.equal(grants.verb, "GET");
  assert.equal(grants.path, "/ark/disbursement/v1/grants?registrar_term=2&pagination.limit=10&pagination.count_total=true&kind=GRANT_KIND_MEMBER");

  const tax = routeFor(TreasuryQuery.method.computeTax, { messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }] });
  assert.equal(tax.verb, "POST");
  assert.equal(tax.path, "/ark/treasury/v1/compute_tax");
  assert.deepEqual(tax.body, { messages: [{ "@type": "/cosmos.bank.v1beta1.MsgSend" }] });

  const getTx = routeFor(TxService.method.getTx, { hash: "ABCD" });
  assert.equal(getTx.path, "/cosmos/tx/v1beta1/txs/ABCD");
  assert.throws(() => routeFor(DisbursementQuery.method.member, {}), /lacks address/);
});

test("a call encodes the request, reads the dialect back, and carries the height", async () => {
  const sheet = {
    gas_prices: [{ denom: "anoah", gas_price: "100000000000.000000000000000000", derived_height: "0" }],
    reference_gas_price: { denom: "axdr", gas_price: "100000000000.000000000000000000", derived_height: "0" },
  };
  const { fetch, seen } = stub(() => json(sheet, { headers: { "grpc-metadata-x-cosmos-block-height": "42" } }));
  const client = new GatewayClient("http://localhost:1317/", { fetch, headers: { authorization: "Bearer x" } });
  const result = await client.call(TreasuryQuery, "gasPrices", {}, { height: 41n });
  assert.equal(result.height, 42n);
  assert.equal(result.value.gasPrices[0]?.gasPrice, "100000000000000000000000000000", "a Dec reads back in its wire form");
  assert.equal(result.value.referenceGasPrice?.denom, "axdr");
  assert.equal(seen[0]?.url, "http://localhost:1317/ark/treasury/v1/gas_prices");
  assert.equal(seen[0]?.headers["x-cosmos-block-height"], "41");
  assert.equal(seen[0]?.headers.authorization, "Bearer x");
});

test("computeTax posts the packed messages as proto JSON", async () => {
  const trader = fixtureKeys().accounts.find((a) => a.name === "trader")!;
  const send = create(MsgSendSchema, { fromAddress: trader.address, toAddress: trader.address, amount: [{ denom: "ausd", amount: "5" }] });
  const { fetch, seen } = stub(() => json({ tax: [{ denom: "ausd", amount: "1" }], tax_base: [{ denom: "ausd", amount: "5" }] }));
  const client = new QueryClient("http://node", { fetch });
  const tax = await client.treasury.computeTax([packAny(MsgSendSchema, send)]);
  assert.deepEqual(
    tax.tax.map((c) => `${c.amount}${c.denom}`),
    ["1ausd"],
  );
  assert.equal(seen[0]?.method, "POST");
  const body = JSON.parse(seen[0]!.body!) as { messages: Record<string, unknown>[] };
  assert.equal(body.messages[0]?.["@type"], "/cosmos.bank.v1beta1.MsgSend");
  assert.equal(body.messages[0]?.from_address, trader.address);
  assert.deepEqual(body.messages[0]?.amount, [{ denom: "ausd", amount: "5" }]);
});

test("gateway errors carry the gRPC code and NotFound is recognisable", async () => {
  const { fetch } = stub(() => json({ code: 5, message: "rpc error: code = NotFound desc = tx not found", details: [] }, { status: 404 }));
  const client = new QueryClient("http://node", { fetch });
  await assert.rejects(client.tx.getTx("ABCD"), (err: unknown) => {
    assert.ok(err instanceof QueryError);
    assert.equal(err.grpcCode, GrpcCode.NotFound);
    assert.ok(err.isNotFound);
    assert.equal(err.httpStatus, 404);
    assert.match(err.message, /tx not found/);
    return true;
  });
});

test("an unreachable node is a transport error, not a query error", async () => {
  const failing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const client = new QueryClient("http://node", { fetch: failing });
  await assert.rejects(client.node.info(), TransportError);
  const notJson = stub(() => new Response("<html>", { status: 502, statusText: "Bad Gateway" }));
  await assert.rejects(
    new QueryClient("http://node", { fetch: notJson.fetch }).node.info(),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 502,
  );
});

test("facades send enum and bigint request fields as the gateway expects", async () => {
  const { fetch, seen } = stub(() => json({ grants: [], pagination: null }));
  const client = new QueryClient("http://node", { fetch });
  await client.disbursement.grants({ kind: GrantKind.MEMBER, pagination: { limit: 5n } });
  assert.equal(seen[0]?.url, "http://node/ark/disbursement/v1/grants?pagination.limit=5&kind=GRANT_KIND_MEMBER");
  await client.disbursement.grant(7n);
  assert.equal(seen[1]?.url, "http://node/ark/disbursement/v1/grants/7");
  await client.tx.simulate(new Uint8Array([1, 2]));
  assert.equal(JSON.parse(seen[2]!.body!).tx_bytes, "AQI=");
});

test("several endpoints: a call moves past one that cannot answer and stays on the one that did", async () => {
  const calls: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("http://a/")) throw new TypeError("fetch failed");
    if (url.startsWith("http://b/")) return json({ code: 13, message: "overloaded", details: [] }, { status: 503 });
    return json({ default_node_info: { network: "localark" }, application_version: null });
  }) as typeof fetch;
  const client = new QueryClient(["http://a", "http://b", "http://c"], { fetch: fetchStub });
  const info = await client.node.info();
  assert.equal(info.defaultNodeInfo?.network, "localark");
  assert.deepEqual(
    calls.map((u) => u.slice(0, 9)),
    ["http://a/", "http://b/", "http://c/"],
  );
  assert.equal(client.gateway.baseUrl, "http://c");
  await client.node.info();
  assert.equal(calls.length, 4, "the next call starts at the endpoint that answered");
  assert.ok(calls[3]!.startsWith("http://c/"));
});

test("a 500 blames the request and stays put; a rate limit or a gateway fault moves on", async () => {
  const simulateFailed = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return json({ code: 2, message: "rpc error: code = Unknown desc = account sequence mismatch, expected 3, got 2", details: [] }, { status: 500 });
  }) as typeof fetch;
  const seen: string[] = [];
  await assert.rejects(
    new QueryClient(["http://a", "http://b"], { fetch: simulateFailed }).tx.simulate(new Uint8Array([1])),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 500,
  );
  assert.equal(seen.length, 1, "a deterministic failure is not replayed on the next endpoint");

  for (const status of [429, 502, 504]) {
    const calls: string[] = [];
    const faulty = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("http://a/")) return json({ code: 14, message: "unavailable", details: [] }, { status });
      return json({ default_node_info: { network: "localark" }, application_version: null });
    }) as typeof fetch;
    const info = await new QueryClient(["http://a", "http://b"], { fetch: faulty }).node.info();
    assert.equal(info.defaultNodeInfo?.network, "localark", `${status} moves on`);
    assert.equal(calls.length, 2, `${status} moves on`);
  }
});

test("a broadcast is sent once, to one endpoint, whatever happens", async () => {
  let attempts = 0;
  const down = (async () => {
    attempts++;
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(new QueryClient(["http://a", "http://b"], { fetch: down }).tx.broadcast(new Uint8Array([1])), TransportError);
  assert.equal(attempts, 1, "the second endpoint never sees the transaction");

  attempts = 0;
  const unavailable = (async () => {
    attempts++;
    return json({ code: 14, message: "unavailable", details: [] }, { status: 503 });
  }) as typeof fetch;
  await assert.rejects(
    new QueryClient(["http://a", "http://b"], { fetch: unavailable }).tx.broadcast(new Uint8Array([1])),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 503,
  );
  assert.equal(attempts, 1);
});

test("a request error does not fail over, and every endpoint at fault names each attempt", async () => {
  const seen: string[] = [];
  const notFound = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return json({ code: 5, message: "no such grant", details: [] }, { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient(["http://a", "http://b"], { fetch: notFound });
  await assert.rejects(client.disbursement.grant(1n), (err: unknown) => err instanceof QueryError && err.isNotFound);
  assert.equal(seen.length, 1);

  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(new QueryClient(["http://a", "http://b"], { fetch: down }).node.info(), (err: unknown) => {
    assert.ok(err instanceof EndpointsExhausted);
    assert.deepEqual(
      err.attempts.map((a) => a.url),
      ["http://a", "http://b"],
    );
    assert.ok(err.attempts.every((a) => a.error instanceof TransportError));
    assert.ok(err.cause instanceof TransportError, "the last attempt's error is the cause");
    assert.match(err.message, /http:\/\/a.*fetch failed.*http:\/\/b/);
    return true;
  });
  await assert.rejects(new QueryClient("http://a", { fetch: down }).node.info(), TransportError, "one endpoint's error is thrown as it is");

  const aborted = new AbortController();
  aborted.abort();
  let attempts = 0;
  const abortFetch = (async () => {
    attempts++;
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;
  await assert.rejects(new QueryClient(["http://a", "http://b"], { fetch: abortFetch }).gateway.call(TreasuryQuery, "params", {}, { signal: aborted.signal }));
  assert.equal(attempts, 1, "an aborted call tries no other endpoint");
  assert.throws(() => new QueryClient([]), /at least one endpoint/);
});

test("a request that hangs past the timeout counts the endpoint as unreachable", async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    })) as typeof fetch;
  const alone = new QueryClient("http://slow", { fetch: hanging, timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(alone.node.info(), TransportError);
  assert.ok(Date.now() - started < 2_000);

  let urls: string[] = [];
  const slowThenFast = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    if (String(input).startsWith("http://slow")) return hanging(input, init);
    return json({ default_node_info: { network: "localark" }, application_version: null });
  }) as typeof fetch;
  const pair = new QueryClient(["http://slow", "http://fast"], { fetch: slowThenFast, timeoutMs: 20 });
  const info = await pair.node.info();
  assert.equal(info.defaultNodeInfo?.network, "localark");
  assert.deepEqual(
    urls.map((u) => u.slice(0, 11)),
    ["http://slow", "http://fast"],
  );
  urls = [];
  await pair.gateway.call(TreasuryQuery, "params", {}, { timeoutMs: 5_000 });
  assert.ok(urls[0]!.startsWith("http://fast"), "the client stays on the endpoint that answered");
});

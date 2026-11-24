import assert from "node:assert/strict";
import { test } from "node:test";

import { create, createRegistry } from "@bufbuild/protobuf";

import { packAny } from "../codec/any.js";
import { registry } from "../codec/registry.js";
import { GatewayClient, QueryClient } from "../defaults.js";
import { GrantKind } from "../gen/ark/disbursement/v1/disbursement_pb.js";
import { Query as DisbursementQuery } from "../gen/ark/disbursement/v1/query_pb.js";
import { Query as TreasuryQuery } from "../gen/ark/treasury/v1/query_pb.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { Query as GovQuery } from "../gen/cosmos/gov/v1/query_pb.js";
import { Service as TxService } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import { amounts, fixtureKey } from "../testing/fixtures.js";
import { json, stubFetch } from "../testing/node.js";
import { EndpointsExhausted, GrpcCode, QueryError, routeFor, TransportError } from "./gateway.js";

const nodeInfo = () => json({ default_node_info: { network: "localark" }, application_version: null });
const unreachable = () => {
  throw new TypeError("fetch failed");
};

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
  const unordered = routeFor(TxService.method.getTxsEvent, { query: "tx.height=7", page: "1", limit: "50", order_by: "ORDER_BY_UNSPECIFIED" });
  assert.equal(unordered.path, "/cosmos/tx/v1beta1/txs?query=tx.height%3D7&page=1&limit=50", "an enum's zero value is not sent");
  const ordered = routeFor(TxService.method.getTxsEvent, { query: "tx.height=7", page: "1", limit: "50", order_by: "ORDER_BY_DESC" });
  assert.ok(ordered.path.endsWith("&order_by=ORDER_BY_DESC"));
  assert.throws(() => routeFor(DisbursementQuery.method.member, {}), /lacks address/);
});

test("a route refuses an empty path parameter, and gov.params names its params type", async () => {
  // An empty value would leave "/cosmos/gov/v1/params/", a path the gateway has no route for.
  for (const params_type of ["", null]) {
    assert.throws(() => routeFor(GovQuery.method.params, { params_type }), /request lacks params_type for the route/);
  }
  assert.throws(() => routeFor(GovQuery.method.params, {}), /request lacks params_type for the route/);
  assert.equal(routeFor(GovQuery.method.proposal, { proposal_id: "0" }).path, "/cosmos/gov/v1/proposals/0", "zero is a value, not an absence");

  const { fetch, seen } = stubFetch(() => json({ voting_params: null, deposit_params: null, tally_params: null, params: null }));
  await new QueryClient("http://node", { fetch }).gov.params("voting");
  assert.equal(seen[0]?.url, "http://node/cosmos/gov/v1/params/voting");
});

test("a call encodes the request, reads the dialect back, and carries the height", async () => {
  const sheet = {
    gas_prices: [{ denom: "anoah", gas_price: "100000000000.000000000000000000", derived_height: "0" }],
    reference_gas_price: { denom: "axdr", gas_price: "100000000000.000000000000000000", derived_height: "0" },
  };
  const { fetch, seen } = stubFetch(() => json(sheet, { headers: { "grpc-metadata-x-cosmos-block-height": "42" } }));
  const client = new GatewayClient("http://localhost:1317/", { fetch, headers: { authorization: "Bearer x" } });
  const result = await client.call(TreasuryQuery, "gasPrices", {}, { height: 41n });
  assert.equal(result.height, 42n);
  assert.equal(result.value.gasPrices[0]?.gasPrice, "100000000000000000000000000000", "a Dec reads back in its wire form");
  assert.equal(result.value.referenceGasPrice?.denom, "axdr");
  assert.equal(seen[0]?.url, "http://localhost:1317/ark/treasury/v1/gas_prices");
  assert.equal(seen[0]?.headers["x-cosmos-block-height"], "41");
  assert.equal(seen[0]?.headers.authorization, "Bearer x");
});

test("the client exposes the registry it resolves types against: every generated type, or the one it was given", () => {
  // Compared with ===: a registry prints as over a million lines, and a failed assert.equal diffs both sides.
  assert.ok(new GatewayClient("http://node").registry === registry);
  const own = createRegistry();
  assert.ok(new QueryClient("http://node", { registry: own }).gateway.registry === own);
});

test("computeTax posts the packed messages as proto JSON", async () => {
  const trader = fixtureKey("trader");
  const send = create(MsgSendSchema, { fromAddress: trader.address, toAddress: trader.address, amount: [{ denom: "ausd", amount: "5" }] });
  const { fetch, seen } = stubFetch(() => json({ tax: [{ denom: "ausd", amount: "1" }], tax_base: [{ denom: "ausd", amount: "5" }] }));
  const client = new QueryClient("http://node", { fetch });
  const tax = await client.treasury.computeTax([packAny(MsgSendSchema, send)]);
  assert.deepEqual(amounts(tax.tax), ["1ausd"]);
  assert.equal(seen[0]?.method, "POST");
  const body = JSON.parse(seen[0]!.body!) as { messages: Record<string, unknown>[] };
  assert.equal(body.messages[0]?.["@type"], "/cosmos.bank.v1beta1.MsgSend");
  assert.equal(body.messages[0]?.from_address, trader.address);
  assert.deepEqual(body.messages[0]?.amount, [{ denom: "ausd", amount: "5" }]);
});

test("gateway errors carry the gRPC code and NotFound is recognisable", async () => {
  const { fetch } = stubFetch(() => json({ code: 5, message: "rpc error: code = NotFound desc = tx not found", details: [] }, 404));
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

test("fetch is called without a receiver, as a browser's requires", async () => {
  // window.fetch throws "Illegal invocation" when `this` is anything but its window or undefined.
  const strict = async function (this: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return json({ default_node_info: { network: "localark" }, application_version: { app_name: "arkd", version: "v1" } });
  } as typeof fetch;
  const client = new QueryClient("http://node", { fetch: strict });
  assert.equal((await client.node.info()).defaultNodeInfo?.network, "localark");
  assert.equal((await new GatewayClient(["http://a", "http://b"], { fetch: strict }).call(TxService, "getTx", { hash: "AB" })).value.txResponse, undefined);
});

test("an unreachable node is a transport error, not a query error", async () => {
  const client = new QueryClient("http://node", { fetch: stubFetch(unreachable).fetch });
  await assert.rejects(client.node.info(), TransportError);
  const notJson = stubFetch(() => new Response("<html>", { status: 502, statusText: "Bad Gateway" }));
  await assert.rejects(
    new QueryClient("http://node", { fetch: notJson.fetch }).node.info(),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 502,
  );
});

test("facades send enum and bigint request fields as the gateway expects", async () => {
  const { fetch, seen } = stubFetch(() => json({ grants: [], pagination: null }));
  const client = new QueryClient("http://node", { fetch });
  await client.disbursement.grants({ kind: GrantKind.MEMBER, pagination: { limit: 5n } });
  assert.equal(seen[0]?.url, "http://node/ark/disbursement/v1/grants?pagination.limit=5&kind=GRANT_KIND_MEMBER");
  await client.disbursement.grant(7n);
  assert.equal(seen[1]?.url, "http://node/ark/disbursement/v1/grants/7");
  await client.tx.simulate(new Uint8Array([1, 2]));
  assert.equal(JSON.parse(seen[2]!.body!).tx_bytes, "AQI=");
});

test("several endpoints: a call moves past one that cannot answer and stays on the one that did", async () => {
  const { fetch, seen } = stubFetch(({ url }) => {
    if (url.startsWith("http://a/")) return unreachable();
    if (url.startsWith("http://b/")) return json({ code: 13, message: "overloaded", details: [] }, 503);
    return nodeInfo();
  });
  const client = new QueryClient(["http://a", "http://b", "http://c"], { fetch });
  const info = await client.node.info();
  assert.equal(info.defaultNodeInfo?.network, "localark");
  assert.deepEqual(
    seen.map((s) => s.url.slice(0, 9)),
    ["http://a/", "http://b/", "http://c/"],
  );
  assert.equal(client.gateway.baseUrl, "http://c");
  await client.node.info();
  assert.equal(seen.length, 4, "the next call starts at the endpoint that answered");
  assert.ok(seen[3]!.url.startsWith("http://c/"));
});

test("calls in flight together each walk the endpoints once: one's move does not shift another's", async () => {
  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sheet = () => json({ gas_prices: [], reference_gas_price: null });
  const unavailable = () => json({ code: 14, message: "unavailable", details: [] }, 503);

  // a is at fault. Its answer to the price sheet arrives after the other call has left it and been answered by b.
  const faulty = stubFetch(async ({ url }) => {
    if (!url.startsWith("http://a/")) return url.includes("gas_prices") ? sheet() : nodeInfo();
    if (url.includes("gas_prices")) await later(20);
    return unavailable();
  });
  const client = new QueryClient(["http://a", "http://b"], { fetch: faulty.fetch });
  const [info, prices] = await Promise.all([client.node.info(), client.treasury.gasPrices()]);
  assert.equal(info.defaultNodeInfo?.network, "localark");
  assert.deepEqual(prices.gasPrices, []);
  assert.deepEqual(
    faulty.seen.map((s) => `${s.url.slice(7, 8)} ${s.url.split("/").pop()}`),
    ["a node_info", "a gas_prices", "b node_info", "b gas_prices"],
    "the second call goes on to b, not back to a",
  );
  assert.equal(client.gateway.baseUrl, "http://b");

  // a answers one call late, after another has left it for b: the late answer does not move the client back.
  const slow = stubFetch(async ({ url }) => {
    if (!url.startsWith("http://a/")) return nodeInfo();
    if (!url.includes("gas_prices")) return unreachable();
    await later(20);
    return sheet();
  });
  const second = new QueryClient(["http://a", "http://b"], { fetch: slow.fetch });
  await Promise.all([second.node.info(), second.treasury.gasPrices()]);
  assert.equal(second.gateway.baseUrl, "http://b", "an answer from where a call began says nothing new");
});

test("a 500 blames the request and stays put; a rate limit or a gateway fault moves on", async () => {
  const failed = stubFetch(() => json({ code: 2, message: "rpc error: code = Unknown desc = account sequence mismatch, expected 3, got 2", details: [] }, 500));
  await assert.rejects(
    new QueryClient(["http://a", "http://b"], { fetch: failed.fetch }).tx.simulate(new Uint8Array([1])),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 500,
  );
  assert.equal(failed.seen.length, 1, "a deterministic failure is not replayed on the next endpoint");

  for (const status of [429, 502, 504]) {
    const faulty = stubFetch(({ url }) => (url.startsWith("http://a/") ? json({ code: 14, message: "unavailable", details: [] }, status) : nodeInfo()));
    const info = await new QueryClient(["http://a", "http://b"], { fetch: faulty.fetch }).node.info();
    assert.equal(info.defaultNodeInfo?.network, "localark", `${status} moves on`);
    assert.equal(faulty.seen.length, 2, `${status} moves on`);
  }
});

test("a broadcast is sent once, to one endpoint, whatever happens", async () => {
  const down = stubFetch(unreachable);
  await assert.rejects(new QueryClient(["http://a", "http://b"], { fetch: down.fetch }).tx.broadcast(new Uint8Array([1])), TransportError);
  assert.equal(down.seen.length, 1, "the second endpoint never sees the transaction");

  const unavailable = stubFetch(() => json({ code: 14, message: "unavailable", details: [] }, 503));
  await assert.rejects(
    new QueryClient(["http://a", "http://b"], { fetch: unavailable.fetch }).tx.broadcast(new Uint8Array([1])),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 503,
  );
  assert.equal(unavailable.seen.length, 1);
});

test("a request error does not fail over, and every endpoint at fault names each attempt", async () => {
  const notFound = stubFetch(() => json({ code: 5, message: "no such grant", details: [] }, 404));
  const client = new QueryClient(["http://a", "http://b"], { fetch: notFound.fetch });
  await assert.rejects(client.disbursement.grant(1n), (err: unknown) => err instanceof QueryError && err.isNotFound);
  assert.equal(notFound.seen.length, 1);

  const down = stubFetch(unreachable).fetch;
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
  const aborting = stubFetch(() => {
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(
    new QueryClient(["http://a", "http://b"], { fetch: aborting.fetch }).gateway.call(TreasuryQuery, "params", {}, { signal: aborted.signal }),
  );
  assert.equal(aborting.seen.length, 1, "an aborted call tries no other endpoint");
  assert.throws(() => new QueryClient([]), /at least one endpoint/);
});

test("a request that hangs past the timeout counts the endpoint as unreachable", async () => {
  const hanging = (signal: AbortSignal | undefined) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
    });
  const alone = new QueryClient("http://slow", { fetch: stubFetch(({ signal }) => hanging(signal)).fetch, timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(alone.node.info(), TransportError);
  assert.ok(Date.now() - started < 2_000);

  const { fetch, seen } = stubFetch(({ url, signal }) => (url.startsWith("http://slow") ? hanging(signal) : nodeInfo()));
  const pair = new QueryClient(["http://slow", "http://fast"], { fetch, timeoutMs: 20 });
  const info = await pair.node.info();
  assert.equal(info.defaultNodeInfo?.network, "localark");
  assert.deepEqual(
    seen.map((s) => s.url.slice(0, 11)),
    ["http://slow", "http://fast"],
  );
  await pair.gateway.call(TreasuryQuery, "params", {}, { timeoutMs: 5_000 });
  assert.equal(seen.length, 3);
  assert.ok(seen[2]!.url.startsWith("http://fast"), "the client stays on the endpoint that answered");
});

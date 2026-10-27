import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { packAny } from "../codec/any.js";
import { Query as DisbursementQuery } from "../gen/ark/disbursement/v1/query_pb.js";
import { GrantKind } from "../gen/ark/disbursement/v1/disbursement_pb.js";
import { Query as TreasuryQuery } from "../gen/ark/treasury/v1/query_pb.js";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { Service as TxService } from "../gen/cosmos/tx/v1beta1/service_pb.js";
import { fixtureKeys } from "../testing/fixtures.js";
import { GatewayClient, GrpcCode, QueryError, TransportError, routeFor } from "./gateway.js";
import { QueryClient } from "./client.js";

interface Seen {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

function stub(reply: (seen: Seen) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined, headers: (init?.headers as Record<string, string>) ?? {} };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  return { fetch: fetchStub, seen };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

test("routes come from the http option: path parameters, query parameters, and bodies", () => {
  const member = routeFor(DisbursementQuery.method.member, { address: "ark1abc" });
  assert.deepEqual(member, { verb: "GET", path: "/ark/disbursement/v1/members/ark1abc", body: undefined });

  const grants = routeFor(DisbursementQuery.method.grants, { beneficiary: "", committee_term: "0", registrar_term: "2", pagination: { limit: "10", key: "", count_total: true, reverse: false }, kind: "GRANT_KIND_MEMBER" });
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
  assert.equal(seen[0]?.headers["authorization"], "Bearer x");
});

test("computeTax posts the packed messages as proto JSON", async () => {
  const trader = fixtureKeys().accounts.find((a) => a.name === "trader")!;
  const send = create(MsgSendSchema, { fromAddress: trader.address, toAddress: trader.address, amount: [{ denom: "ausd", amount: "5" }] });
  const { fetch, seen } = stub(() => json({ tax: [{ denom: "ausd", amount: "1" }], tax_base: [{ denom: "ausd", amount: "5" }] }));
  const client = new QueryClient("http://node", { fetch });
  const tax = await client.treasury.computeTax([packAny(MsgSendSchema, send)]);
  assert.deepEqual(tax.tax.map((c) => `${c.amount}${c.denom}`), ["1ausd"]);
  assert.equal(seen[0]?.method, "POST");
  const body = JSON.parse(seen[0]!.body!) as { messages: Record<string, unknown>[] };
  assert.equal(body.messages[0]?.["@type"], "/cosmos.bank.v1beta1.MsgSend");
  assert.equal(body.messages[0]?.["from_address"], trader.address);
  assert.deepEqual(body.messages[0]?.["amount"], [{ denom: "ausd", amount: "5" }]);
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
  await assert.rejects(new QueryClient("http://node", { fetch: notJson.fetch }).node.info(), (err: unknown) => err instanceof QueryError && err.httpStatus === 502);
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

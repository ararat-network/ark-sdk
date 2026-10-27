import assert from "node:assert/strict";
import { test } from "node:test";

import { QueryClient } from "../query/client.js";
import { QueryError } from "../query/gateway.js";
import { BroadcastRefused, BroadcastUnknown, broadcastAndConfirm, broadcastSync, InclusionTimeout, waitForInclusion } from "./broadcast.js";
import { txHash } from "./signdoc.js";

const HASH = "861F5D4824CECE1A5A1F9FCB43280CD6AB38491D10AFF22939B94FEDE66802B0";

function node(script: ((url: string, body: string | undefined) => Response)[]): { client: QueryClient; calls: string[] } {
  const calls: string[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url.replace("http://node", "")}`);
    const step = script.shift();
    if (!step) throw new Error(`unexpected request ${url}`);
    return step(url, init?.body as string | undefined);
  }) as typeof fetch;
  return { client: new QueryClient("http://node", { fetch: fetchStub }), calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const broadcastOk = () =>
  json({ tx_response: { txhash: HASH, code: 0, codespace: "", raw_log: "", height: "0", gas_wanted: "0", gas_used: "0", events: [], logs: [] } });
const notFound = () => json({ code: 5, message: "tx not found", details: [] }, 404);
const included = () =>
  json({ tx_response: { txhash: HASH, code: 0, codespace: "", raw_log: "", height: "7", gas_wanted: "250000", gas_used: "98227", events: [], logs: [] } });

test("broadcastSync returns CheckTx's verdict with the hash", async () => {
  const { client, calls } = node([broadcastOk]);
  const result = await broadcastSync(client, new Uint8Array([1]));
  assert.deepEqual(result, { hash: HASH, code: 0, codespace: "", rawLog: "", accepted: true, alreadyInMempool: false });
  assert.deepEqual(calls, ["POST /cosmos/tx/v1beta1/txs"]);
});

test("a node that already holds the transaction reports an acceptance", async () => {
  const cached = () =>
    json({
      tx_response: {
        txhash: HASH,
        code: 19,
        codespace: "sdk",
        raw_log: "tx already in mempool",
        height: "0",
        gas_wanted: "0",
        gas_used: "0",
        events: [],
        logs: [],
      },
    });
  const { client } = node([cached, notFound, included]);
  const confirmed = await broadcastAndConfirm(client, new Uint8Array([1]), { sleep: async () => {} });
  assert.equal(confirmed.broadcast.accepted, true);
  assert.equal(confirmed.broadcast.alreadyInMempool, true);
  assert.equal(confirmed.broadcast.code, 19, "the code is kept");
  assert.equal(confirmed.response.height, 7n);
});

test("a broadcast whose answer never arrives, or carries no verdict, is an unknown outcome with the hash", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const lost = node([
    () => {
      throw new TypeError("fetch failed");
    },
  ]);
  await assert.rejects(broadcastSync(lost.client, bytes), (err: unknown) => {
    assert.ok(err instanceof BroadcastUnknown);
    assert.equal(err.hash, txHash(bytes));
    assert.match(err.message, /may have reached the mempool/);
    return true;
  });
  assert.equal(lost.calls.length, 1);
  const silent = node([() => json({ tx_response: null })]);
  await assert.rejects(broadcastSync(silent.client, bytes), (err: unknown) => err instanceof BroadcastUnknown && err.hash === txHash(bytes));
  const refusedByGateway = node([() => json({ code: 3, message: "tx parse error", details: [] }, 400)]);
  await assert.rejects(
    broadcastSync(refusedByGateway.client, bytes),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 400,
    "a verdict on the request is not an unknown outcome",
  );
});

test("polling rides out an endpoint fault, names the last one at the deadline, and stops on the caller's error", async () => {
  const unavailable = () => json({ code: 14, message: "unavailable", details: [] }, 503);
  const flaky = node([
    () => {
      throw new TypeError("fetch failed");
    },
    unavailable,
    notFound,
    included,
  ]);
  const response = await waitForInclusion(flaky.client, HASH, { sleep: async () => {} });
  assert.equal(response.height, 7n);
  assert.equal(flaky.calls.length, 4);

  const down = node([unavailable, unavailable, unavailable]);
  let clock = 0;
  await assert.rejects(
    waitForInclusion(down.client, HASH, {
      timeoutMs: 1000,
      pollMs: 500,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    }),
    (err: unknown) => err instanceof InclusionTimeout && err.cause instanceof QueryError && err.cause.httpStatus === 503,
  );

  const badHash = node([() => json({ code: 3, message: "invalid hash", details: [] }, 400)]);
  await assert.rejects(
    waitForInclusion(badHash.client, "nothex", { sleep: async () => {} }),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 400,
  );
});

test("an aborted signal ends the wait at once", async () => {
  const { client } = node([notFound]);
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(
    waitForInclusion(client, HASH, { pollMs: 10_000, signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.ok(Date.now() - started < 1_000, "no poll interval was waited out");
});

test("waitForInclusion polls through NotFound until the block", async () => {
  const { client, calls } = node([notFound, notFound, included]);
  const slept: number[] = [];
  const response = await waitForInclusion(client, HASH, { pollMs: 250, sleep: async (ms) => void slept.push(ms) });
  assert.equal(response.height, 7n);
  assert.equal(response.gasUsed, 98227n);
  assert.deepEqual(slept, [250, 250]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c === `GET /cosmos/tx/v1beta1/txs/${HASH}`));
});

test("waitForInclusion gives up after the timeout and names the hash", async () => {
  const { client } = node([notFound, notFound, notFound, notFound]);
  let clock = 0;
  await assert.rejects(
    waitForInclusion(client, HASH, {
      timeoutMs: 1000,
      pollMs: 400,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    }),
    (err: unknown) => err instanceof InclusionTimeout && err.hash === HASH,
  );
});

test("broadcastAndConfirm fails on a CheckTx refusal and otherwise returns the block result", async () => {
  const refused = node([
    () =>
      json({
        tx_response: {
          txhash: HASH,
          code: 13,
          codespace: "sdk",
          raw_log: "fee 1anoah does not cover transfer tax 2ausd",
          height: "0",
          gas_wanted: "0",
          gas_used: "0",
          events: [],
          logs: [],
        },
      }),
  ]);
  await assert.rejects(broadcastAndConfirm(refused.client, new Uint8Array([1])), (err: unknown) => {
    assert.ok(err instanceof BroadcastRefused);
    assert.equal(err.result.code, 13);
    assert.equal(err.result.codespace, "sdk");
    assert.match(err.result.rawLog, /transfer tax/);
    return true;
  });
  const ok = node([broadcastOk, notFound, included]);
  const confirmed = await broadcastAndConfirm(ok.client, new Uint8Array([1]), { sleep: async () => {} });
  assert.equal(confirmed.broadcast.accepted, true);
  assert.equal(confirmed.response.height, 7n);
});

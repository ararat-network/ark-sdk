import assert from "node:assert/strict";
import { test } from "node:test";
import { txHash } from "../codec/hash.js";
import { QueryError } from "../query/gateway.js";
import { WrongTransaction } from "../query/search.js";
import { fakeNode, json, txResponse } from "../testing/node.js";
import {
  BroadcastRefused,
  BroadcastUnknown,
  broadcastAndConfirm,
  broadcastSync,
  InclusionTimeout,
  InclusionUnknown,
  TransactionExpired,
  waitForInclusion,
} from "./broadcast.js";

/** The hash of the one-byte transaction the tests broadcast, which an honest node echoes. */
const HASH = txHash(new Uint8Array([1]));

const broadcastOk = () => json({ tx_response: txResponse({ txhash: HASH }) });
const notFound = () => json({ code: 5, message: "tx not found", details: [] }, 404);
const included = () => json({ tx_response: txResponse({ txhash: HASH, height: "7", gas_wanted: "250000", gas_used: "98227" }) });

test("broadcastSync returns CheckTx's verdict with the hash", async () => {
  const { client, calls, requests } = fakeNode([broadcastOk]);
  const result = await broadcastSync(client, new Uint8Array([1]));
  assert.deepEqual(result, { hash: HASH, code: 0, codespace: "", rawLog: "", accepted: true, alreadyInMempool: false });
  assert.deepEqual(calls, ["POST /cosmos/tx/v1beta1/txs"]);
  assert.deepEqual(
    JSON.parse(requests[0]!.body!),
    { tx_bytes: "AQ==", mode: "BROADCAST_MODE_SYNC" },
    "sync mode is asked for: without it the node gives no CheckTx verdict",
  );
});

test("the hash is the bytes' own, and an answer for another transaction is refused", async () => {
  const OTHER = "AA".repeat(32);
  const other = (height: string) => () => json({ tx_response: txResponse({ txhash: OTHER, height }) });
  const echoed = fakeNode([other("0")]);
  assert.equal((await broadcastSync(echoed.client, new Uint8Array([1]))).hash, HASH, "the node's echo does not replace the hash");

  const redirected = fakeNode([other("0"), other("9")]);
  await assert.rejects(broadcastAndConfirm(redirected.client, new Uint8Array([1]), { sleep: async () => {} }), (err: unknown) => {
    assert.ok(err instanceof WrongTransaction);
    assert.equal(err.hash, HASH);
    assert.equal(err.answered, OTHER);
    return true;
  });
  assert.equal(redirected.calls[1], `GET /cosmos/tx/v1beta1/txs/${HASH}`, "the transaction's own hash is what is polled");

  const lower = fakeNode([included]);
  assert.equal((await waitForInclusion(lower.client, HASH.toLowerCase(), { sleep: async () => {} })).height, 7n, "case is not a difference");

  // An answer that names no transaction reads as code zero at height zero: a success for one that may be in no block.
  for (const empty of [{}, { height: "0" }, txResponse()]) {
    const unnamed = fakeNode([() => json({ tx_response: empty })]);
    await assert.rejects(
      waitForInclusion(unnamed.client, HASH, { sleep: async () => {} }),
      (err: unknown) => err instanceof WrongTransaction && err.hash === HASH && err.answered === "" && /no hash/.test(err.message),
    );
  }
  const confirmedEmpty = fakeNode([broadcastOk, () => json({ tx_response: {} })]);
  await assert.rejects(broadcastAndConfirm(confirmedEmpty.client, new Uint8Array([1]), { sleep: async () => {} }), WrongTransaction);
});

test("a node that already holds the transaction reports an acceptance", async () => {
  const cached = () => json({ tx_response: txResponse({ txhash: HASH, code: 19, codespace: "sdk", raw_log: "tx already in mempool" }) });
  const { client } = fakeNode([cached, notFound, included]);
  const confirmed = await broadcastAndConfirm(client, new Uint8Array([1]), { sleep: async () => {} });
  assert.equal(confirmed.broadcast.accepted, true);
  assert.equal(confirmed.broadcast.alreadyInMempool, true);
  assert.equal(confirmed.broadcast.code, 19, "the code is kept");
  assert.equal(confirmed.response.height, 7n);
});

test("a broadcast whose answer never arrives, or carries no verdict, is an unknown outcome with the hash", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const lost = fakeNode([
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
  const silent = fakeNode([() => json({ tx_response: null })]);
  await assert.rejects(broadcastSync(silent.client, bytes), (err: unknown) => err instanceof BroadcastUnknown && err.hash === txHash(bytes));
  const refusedByGateway = fakeNode([() => json({ code: 3, message: "tx parse error", details: [] }, 400)]);
  await assert.rejects(
    broadcastSync(refusedByGateway.client, bytes),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 400,
    "a verdict on the request is not an unknown outcome",
  );
  // A gateway answering in the node's place has lost the node's answer, not refused the transaction; 520 and 524
  // are what a CDN answers with for an origin that did not answer in time.
  for (const status of [502, 503, 504, 520, 524]) {
    const proxied = fakeNode([() => new Response("<html>upstream timed out</html>", { status })]);
    await assert.rejects(broadcastSync(proxied.client, bytes), (err: unknown) => {
      assert.ok(err instanceof BroadcastUnknown, `${status} is an unknown outcome`);
      assert.equal(err.hash, txHash(bytes));
      assert.ok(err.cause instanceof QueryError && err.cause.httpStatus === status, "the gateway's answer is kept as the cause");
      return true;
    });
    assert.equal(proxied.calls.length, 1, "and it is still sent once");
  }
  const limited = fakeNode([() => json({ code: 8, message: "rate limited", details: [] }, 429)]);
  await assert.rejects(
    broadcastSync(limited.client, bytes),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 429,
    "a rate limiter answers before forwarding, so the transaction was not sent on",
  );
  // A 500 and a 501 are the node's own, given before it takes a transaction.
  for (const status of [500, 501]) {
    const own = fakeNode([() => json({ code: 2, message: "tx too large", details: [] }, status)]);
    await assert.rejects(broadcastSync(own.client, bytes), (err: unknown) => err instanceof QueryError && err.httpStatus === status);
  }
  // An answer that arrived and cannot be read settles nothing: the node may hold the transaction, and the hash is what finds it.
  for (const body of ["[]", '{"tx_response":{"height":"tall"}}', '{"tx_response":{"code":"abc"}}', '{"tx_response":"accepted"}']) {
    const unreadable = fakeNode([() => new Response(body)]);
    await assert.rejects(broadcastSync(unreadable.client, bytes), (err: unknown) => {
      assert.ok(err instanceof BroadcastUnknown, `${body} is an unknown outcome`);
      assert.equal(err.hash, txHash(bytes));
      assert.ok(err.cause instanceof Error && !(err.cause instanceof QueryError), "what failed to read it is kept as the cause");
      return true;
    });
    assert.equal(unreadable.calls.length, 1);
  }
});

test("polling rides out an endpoint fault, names the last one at the deadline, and stops on the caller's error", async () => {
  const unavailable = () => json({ code: 14, message: "unavailable", details: [] }, 503);
  const flaky = fakeNode([
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

  const down = fakeNode([unavailable, unavailable, unavailable]);
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

  const badHash = fakeNode([() => json({ code: 3, message: "invalid hash", details: [] }, 400)]);
  await assert.rejects(
    waitForInclusion(badHash.client, "nothex", { sleep: async () => {} }),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 400,
  );
});

const LOOKUP = "GET /cosmos/tx/v1beta1/txs/";
const LATEST = "GET /cosmos/base/tendermint/v1beta1/blocks/latest";
const SYNCING = "GET /cosmos/base/tendermint/v1beta1/syncing";
const latest = (height: string) => () => json({ block_id: null, block: null, sdk_block: { header: { height } } });
const inSync = () => json({ syncing: false });
/** A clock the wait's sleeps advance. */
const clocked = () => {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
};
const count = (calls: string[], prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;

test("past the timeout height the wait says expired only after the grace period, on a node that is not catching up", async () => {
  // The chain is past the height from the first look. Polls at 0, 1, 2, and 3 seconds: the grace of 3 seconds has
  // passed at the fourth, the node is asked whether it is catching up, and one last look is taken.
  const expired = fakeNode([], { [LOOKUP]: notFound, [LATEST]: latest("11"), [SYNCING]: inSync });
  await assert.rejects(
    waitForInclusion(expired.client, HASH, { timeoutHeight: 10n, pollMs: 1000, expiryGraceMs: 3000, ...clocked() }),
    (err: unknown) => err instanceof TransactionExpired && err.timeoutHeight === 10n && err.height === 11n,
  );
  assert.deepEqual([count(expired.calls, LOOKUP), count(expired.calls, LATEST), count(expired.calls, SYNCING)], [5, 4, 1]);

  // The node reports a block before it has indexed the block's transactions: the first looks past the height miss
  // one that the block at the height carried. Within the grace period it is found, and that is the answer.
  let looks = 0;
  const lagging = fakeNode([], { [LOOKUP]: () => (looks++ < 3 ? notFound() : included()), [LATEST]: latest("11"), [SYNCING]: inSync });
  const found = await waitForInclusion(lagging.client, HASH, { timeoutHeight: 10n, pollMs: 1000, ...clocked() });
  assert.equal(found.height, 7n, "the index was behind the block");
  assert.equal(count(lagging.calls, SYNCING), 0, "the default grace period had not passed");

  // A node that is catching up serves blocks ahead of its index, so its not-found is not an expiry: the wait goes on to its deadline.
  const behind = fakeNode([], { [LOOKUP]: notFound, [LATEST]: latest("11"), [SYNCING]: () => json({ syncing: true }) });
  await assert.rejects(
    waitForInclusion(behind.client, HASH, { timeoutHeight: 10n, pollMs: 1000, expiryGraceMs: 2000, timeoutMs: 6000, ...clocked() }),
    (err: unknown) => err instanceof InclusionTimeout && err.hash === HASH,
  );

  // With no grace, the one last look still stands between the height's read and the verdict.
  let once = 0;
  const carried = fakeNode([], { [LOOKUP]: () => (once++ < 1 ? notFound() : included()), [LATEST]: latest("11"), [SYNCING]: inSync });
  const response = await waitForInclusion(carried.client, HASH, { timeoutHeight: 10n, expiryGraceMs: 0, ...clocked() });
  assert.equal(response.height, 7n, "a block at the height carried it between the poll and the read");

  const early = fakeNode([notFound, latest("9"), notFound, latest("10"), included]);
  const slept: number[] = [];
  assert.equal((await waitForInclusion(early.client, HASH, { timeoutHeight: 10n, pollMs: 50, sleep: async (ms) => void slept.push(ms) })).height, 7n);
  assert.deepEqual(slept, [50, 50], "at or below the height the wait continues");

  const plain = fakeNode([notFound, included]);
  await waitForInclusion(plain.client, HASH, { sleep: async () => {} });
  assert.ok(!plain.calls.some((c) => c.includes("blocks/latest")), "without a timeout height no block is read");

  const zero = fakeNode([notFound, included]);
  assert.equal((await waitForInclusion(zero.client, HASH, { timeoutHeight: 0n, sleep: async () => {} })).height, 7n);
  assert.ok(!zero.calls.some((c) => c.includes("blocks/latest")), "height zero is the body's no timeout, not a height the chain is past");
});

test("an aborted signal ends the wait at once", async () => {
  const { client } = fakeNode([notFound]);
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
  const { client, calls } = fakeNode([notFound, notFound, included]);
  const slept: number[] = [];
  const response = await waitForInclusion(client, HASH, { pollMs: 250, sleep: async (ms) => void slept.push(ms) });
  assert.equal(response.height, 7n);
  assert.equal(response.gasUsed, 98227n);
  assert.deepEqual(slept, [250, 250]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c === `GET /cosmos/tx/v1beta1/txs/${HASH}`));
});

test("waitForInclusion gives up after the timeout and names the hash", async () => {
  const { client } = fakeNode([notFound, notFound, notFound, notFound]);
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
  const refused = fakeNode([
    () => json({ tx_response: txResponse({ txhash: HASH, code: 13, codespace: "sdk", raw_log: "fee 1anoah does not cover transfer tax 2ausd" }) }),
  ]);
  await assert.rejects(broadcastAndConfirm(refused.client, new Uint8Array([1])), (err: unknown) => {
    assert.ok(err instanceof BroadcastRefused);
    assert.equal(err.result.code, 13);
    assert.equal(err.result.codespace, "sdk");
    assert.match(err.result.rawLog, /transfer tax/);
    return true;
  });
  const ok = fakeNode([broadcastOk, notFound, included]);
  const confirmed = await broadcastAndConfirm(ok.client, new Uint8Array([1]), { sleep: async () => {} });
  assert.equal(confirmed.broadcast.accepted, true);
  assert.equal(confirmed.response.height, 7n);
});

test("after an acceptance every failure carries the hash: the wait's verdicts as they are, anything else as an unknown inclusion", async () => {
  const bytes = new Uint8Array([1]);
  // A lookup the node answers with an error of its own says nothing of the transaction, which the mempool holds.
  const failing = fakeNode([broadcastOk, () => json({ code: 13, message: "index unavailable", details: [] }, 500)]);
  await assert.rejects(broadcastAndConfirm(failing.client, bytes, { sleep: async () => {} }), (err: unknown) => {
    assert.ok(err instanceof InclusionUnknown);
    assert.equal(err.hash, HASH);
    assert.deepEqual(err.broadcast, { hash: HASH, code: 0, codespace: "", rawLog: "", accepted: true, alreadyInMempool: false });
    assert.ok(err.cause instanceof QueryError && err.cause.httpStatus === 500);
    assert.match(err.message, /accepted by the mempool.*may still be included/);
    return true;
  });

  // The caller's own abort ends the wait, and the transaction it leaves in the mempool is still named.
  const controller = new AbortController();
  controller.abort();
  const aborted = fakeNode([broadcastOk, notFound]);
  await assert.rejects(
    broadcastAndConfirm(aborted.client, bytes, { signal: controller.signal }),
    (err: unknown) => err instanceof InclusionUnknown && err.hash === HASH && err.cause instanceof Error && err.cause.name === "AbortError",
  );

  // The wait's verdicts on the transaction already carry the hash and are thrown as they are.
  const never = fakeNode([broadcastOk, notFound, notFound, notFound, notFound]);
  await assert.rejects(
    broadcastAndConfirm(never.client, bytes, { timeoutMs: 1000, pollMs: 400, ...clocked() }),
    (err: unknown) => err instanceof InclusionTimeout && err.hash === HASH,
  );
  const dead = fakeNode([broadcastOk], { [LOOKUP]: notFound, [LATEST]: latest("11"), [SYNCING]: inSync });
  await assert.rejects(broadcastAndConfirm(dead.client, bytes, { timeoutHeight: 10n, expiryGraceMs: 0, ...clocked() }), TransactionExpired);

  // Before an acceptance nothing is wrapped: a refusal is the refusal, and waitForInclusion alone throws what it met.
  const lookupOnly = fakeNode([() => json({ code: 13, message: "index unavailable", details: [] }, 500)]);
  await assert.rejects(
    waitForInclusion(lookupOnly.client, HASH, { sleep: async () => {} }),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 500,
  );
});

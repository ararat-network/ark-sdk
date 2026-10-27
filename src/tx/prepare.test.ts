import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBinary } from "@bufbuild/protobuf";
import { fromHex, toBase64 } from "../codec/bytes.js";
import { fromProtoJson } from "../codec/protojson.js";
import { AuthInfoSchema, TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { QueryClient } from "../query/client.js";
import { fixture, fixtureKey } from "../testing/fixtures.js";
import { BroadcastRefused } from "./broadcast.js";
import { FeeError } from "./fee.js";
import { PrepareError, prepareAndSign, sendTx } from "./prepare.js";

const f = fixture("bank_send_taxed");
const key = fixtureKey("trader");
const signer = MemorySigner.fromPrivateKey(fromHex(key.private_key_hex));
const body = fromProtoJson(TxBodySchema, (f.tx as { body: never }).body);

const HASH = f.tx_hash!;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

/** A node answering the flow's requests in order, each a route prefix with its reply. */
function node(sequence = "2") {
  const calls: string[] = [];
  const replies: Record<string, () => Response> = {
    "GET /cosmos/auth/v1beta1/account_info/": () => json({ info: { address: signer.address, pub_key: null, account_number: "3", sequence } }),
    "POST /cosmos/tx/v1beta1/simulate": () => json({ gas_info: { gas_wanted: "0", gas_used: "217391" }, result: null }),
    "POST /ark/treasury/v1/compute_tax": () => json({ tax: f.fee!.tax, tax_base: [{ denom: "ausd", amount: "10000000000000000000" }] }),
    "GET /ark/treasury/v1/gas_prices": () =>
      json({
        gas_prices: [f.fee!.gas_price, { denom: "anoah", gas_price: "100000000000.000000000000000000", derived_height: "0" }],
        reference_gas_price: { denom: "axdr", gas_price: "100000000000.000000000000000000", derived_height: "0" },
      }),
  };
  const extra: (() => Response)[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${String(input).replace("http://node", "")}`;
    calls.push(call);
    for (const [prefix, reply] of Object.entries(replies)) if (call.startsWith(prefix)) return reply();
    const next = extra.shift();
    if (!next) throw new Error(`unexpected request ${call}`);
    return next();
  }) as typeof fetch;
  return { client: new QueryClient("http://node", { fetch: fetchStub }), calls, extra, replies };
}

const base = (client: QueryClient) => ({
  client,
  signer,
  address: signer.address,
  chainId: f.chain_id,
  messages: body.messages,
  feeDenom: "ausd",
  headroom: { stable: f.fee!.pad_stable, noah: f.fee!.pad_noah },
  gasAdjustment: 1.15,
});

test("prepareAndSign reproduces a fixture from a node's answers", async () => {
  const { client, calls } = node();
  const prepared = await prepareAndSign(base(client));
  assert.equal(prepared.simulatedGas, 217391n);
  assert.equal(prepared.gasLimit, 250000n, "ceil(217391 × 1.15)");
  assert.deepEqual(
    prepared.quote.declared.map((c) => c.amount + c.denom),
    f.fee!.declared.map((c) => c.amount + c.denom),
  );
  assert.deepEqual(
    prepared.taxBase.map((c) => c.amount + c.denom),
    ["10000000000000000000ausd"],
  );
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes);
  assert.equal(prepared.signed.hash, HASH);
  assert.deepEqual(
    calls.map((c) => c.split("?")[0]),
    [
      `GET /cosmos/auth/v1beta1/account_info/${signer.address}`,
      "POST /cosmos/tx/v1beta1/simulate",
      "POST /ark/treasury/v1/compute_tax",
      "GET /ark/treasury/v1/gas_prices",
    ],
    "the steps run in the contract's order",
  );
});

test("a given gas limit or account skips the query for it, and an unlisted fee denomination is refused", async () => {
  const { client, calls } = node();
  const prepared = await prepareAndSign({ ...base(client), gasLimit: 250000n, account: { accountNumber: 3n, sequence: 2n } });
  assert.equal(prepared.simulatedGas, undefined);
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes);
  assert.ok(!calls.some((c) => c.includes("simulate") || c.includes("account_info")));
  await assert.rejects(prepareAndSign({ ...base(client), feeDenom: "ajpy" }), FeeError);
  const tipped = await prepareAndSign({ ...base(client), gasLimit: 250000n, account: { accountNumber: 3n, sequence: 2n }, tip: 5n });
  assert.equal(tipped.quote.tip?.amount, "5");
  assert.deepEqual(
    fromBinary(AuthInfoSchema, tipped.signed.authInfoBytes).fee?.amount.map((c) => c.amount + c.denom),
    [...f.fee!.declared.map((c) => c.amount + c.denom), "5anoah"],
    "the tip is the last leg of the signed fee",
  );
  const missing = node();
  missing.replies["GET /cosmos/auth/v1beta1/account_info/"] = () => json({ info: null });
  await assert.rejects(prepareAndSign(base(missing.client)), PrepareError);
});

const broadcastOk = () =>
  json({ tx_response: { txhash: HASH, code: 0, codespace: "", raw_log: "", height: "0", gas_wanted: "0", gas_used: "0", events: [], logs: [] } });
const mismatch = () =>
  json({
    tx_response: {
      txhash: HASH,
      code: 32,
      codespace: "sdk",
      raw_log: "account sequence mismatch, expected 3, got 2: incorrect account sequence",
      height: "0",
      gas_wanted: "0",
      gas_used: "0",
      events: [],
      logs: [],
    },
  });
const included = () =>
  json({ tx_response: { txhash: HASH, code: 0, codespace: "", raw_log: "", height: "7", gas_wanted: "250000", gas_used: "98227", events: [], logs: [] } });

test("sendTx broadcasts and confirms, and signs again at the sequence the chain names after a mismatch", async () => {
  const n = node();
  n.extra.push(broadcastOk, included);
  const sent = await sendTx(base(n.client), { sleep: async () => {} });
  assert.equal(sent.response.height, 7n);
  assert.equal(sent.broadcast.hash, HASH);

  // CheckTx names the sequence; the committed account still shows the old one
  // while the earlier transaction is pending, so the log is what is used.
  const r = node();
  r.extra.push(mismatch, broadcastOk, included);
  const retried = await sendTx(base(r.client), { sleep: async () => {} });
  assert.equal(retried.sequence, 3n, "the second attempt signs with the sequence the chain expects");
  assert.equal(r.calls.filter((c) => c.includes("account_info")).length, 2, "the account is read again for its number only");

  // Simulation runs against the mempool's state and names the sequence first.
  const s = node();
  let simulations = 0;
  s.replies["POST /cosmos/tx/v1beta1/simulate"] = () =>
    simulations++ === 0
      ? json(
          { code: 2, message: "rpc error: code = Unknown desc = account sequence mismatch, expected 3, got 2: incorrect account sequence", details: [] },
          500,
        )
      : json({ gas_info: { gas_wanted: "0", gas_used: "217391" }, result: null });
  s.extra.push(broadcastOk, included);
  const resimulated = await sendTx(base(s.client), { sleep: async () => {} });
  assert.equal(resimulated.sequence, 3n);
  assert.equal(simulations, 2);

  const once = node();
  once.extra.push(mismatch);
  await assert.rejects(sendTx(base(once.client), { retryOnSequenceMismatch: false }), BroadcastRefused);
  const given = node();
  given.extra.push(mismatch);
  await assert.rejects(
    sendTx({ ...base(given.client), account: { accountNumber: 3n, sequence: 2n } }),
    BroadcastRefused,
    "a given sequence is the caller's to fix",
  );
});

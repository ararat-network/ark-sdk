import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { aminoSignDocBytes } from "../codec/aminojson.js";
import { fromBase64, fromHex, toBase64, utf8Decode } from "../codec/bytes.js";
import { fromProtoJson, QueryClient } from "../defaults.js";
import { AuthInfoSchema, TxBodySchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { type Signer, SignerError } from "../keys/signer.js";
import { QueryError } from "../query/gateway.js";
import { amounts, fixture, fixtureKey } from "../testing/fixtures.js";
import { accepted, fakeNode, gatewayError, included, json, notFound, stubFetch, txResponse, unavailable } from "../testing/node.js";
import { BroadcastRefused, BroadcastUnknown, InclusionUnknown } from "./broadcast.js";
import { FeeError } from "./fee.js";
import { PrepareError, prepareAndSign, sendTx } from "./prepare.js";

const f = fixture("bank_send_taxed");
const key = fixtureKey("trader");
const signer = MemorySigner.fromPrivateKey(fromHex(key.private_key_hex));
const body = fromProtoJson(TxBodySchema, f.tx!.body);

const HASH = f.tx_hash!;

/** A node answering the flow's requests in order, each a route prefix with its reply; any other request takes the next step of its script. */
function node(sequence = "2") {
  return fakeNode([], {
    "GET /cosmos/auth/v1beta1/account_info/": () => json({ info: { address: signer.address, pub_key: null, account_number: "3", sequence } }),
    "POST /cosmos/tx/v1beta1/simulate": () => json({ gas_info: { gas_wanted: "0", gas_used: "217391" }, result: null }),
    "POST /ark/treasury/v1/compute_tax": () => json({ tax: f.fee!.tax, tax_base: [{ denom: "ausd", amount: "10000000000000000000" }] }),
    "GET /ark/treasury/v1/gas_prices": () =>
      json({
        gas_prices: [f.fee!.gas_price, { denom: "anoah", gas_price: "100000000000.000000000000000000", derived_height: "0" }],
        reference_gas_price: { denom: "axdr", gas_price: "100000000000.000000000000000000", derived_height: "0" },
      }),
  });
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
  assert.deepEqual(amounts(prepared.quote.declared), amounts(f.fee!.declared));
  assert.deepEqual(amounts(prepared.taxBase), ["10000000000000000000ausd"]);
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

test("prepareAndSign asks the signer for its accounts once, and signTx uses the account it is handed", async () => {
  let asked = 0;
  const counting: Signer = {
    accounts: () => {
      asked++;
      return signer.accounts();
    },
    signDirect: (address, doc) => signer.signDirect(address, doc),
    signAmino: (address, doc) => signer.signAmino(address, doc),
  };
  const prepared = await prepareAndSign({ ...base(node().client), signer: counting });
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes);
  assert.equal(asked, 1, "a wallet or a device is asked once per transaction");
});

test("an endpoint that goes bad after the simulation does not strand the tax or the price sheet", async () => {
  const n = node();
  // Two endpoints. a answers the account and the simulation, then 503s the treasury's routes, the sheet's later
  // than the tax's: the two are asked together, and each must go on to b.
  const { fetch, seen } = stubFetch(async (request) => {
    if (request.url.startsWith("http://a/") && request.call.includes("/ark/treasury/")) {
      if (request.call.includes("gas_prices")) await new Promise((resolve) => setTimeout(resolve, 20));
      return unavailable();
    }
    return n.answer(request);
  });
  const prepared = await prepareAndSign(base(new QueryClient(["http://a", "http://b"], { fetch })));
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes);
  assert.deepEqual(
    seen.filter((s) => s.call.includes("/ark/treasury/")).map((s) => `${s.url.slice(7, 8)} ${s.call.split("/").pop()}`),
    ["a compute_tax", "a gas_prices", "b compute_tax", "b gas_prices"],
  );
});

test("a signer that throws where it should reject fails the flow once, with no request left unawaited", async () => {
  const locked: Signer = {
    accounts: () => {
      throw new SignerError("wallet is locked");
    },
    signDirect: (address, doc) => signer.signDirect(address, doc),
    signAmino: (address, doc) => signer.signAmino(address, doc),
  };
  // The account request is sent before the signer is asked, and fails too: its rejection must be handled with the signer's.
  const missing = node();
  missing.replies["GET /cosmos/auth/v1beta1/account_info/"] = () => json({ info: null });
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    await assert.rejects(prepareAndSign({ ...base(missing.client), signer: locked }), /wallet is locked/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", record);
  }
});

test("an address the signer holds no account for is the signer's refusal, as it is in signTx", async () => {
  const stranger = MemorySigner.random().address;
  await assert.rejects(prepareAndSign({ ...base(node().client), address: stranger }), SignerError);
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
    amounts(fromBinary(AuthInfoSchema, tipped.signed.authInfoBytes).fee!.amount),
    [...amounts(f.fee!.declared), "5anoah"],
    "the tip is the last leg of the signed fee",
  );
  const missing = node();
  missing.replies["GET /cosmos/auth/v1beta1/account_info/"] = () => json({ info: null });
  await assert.rejects(prepareAndSign(base(missing.client)), PrepareError);
});

test("an unordered transaction is signed at sequence zero and needs its timeout timestamp", async () => {
  // The ante refuses an unordered transaction that carries a sequence, so the account's is not used.
  const n = node("7");
  const timeoutTimestamp = create(TimestampSchema, { seconds: 1_900_000_000n });
  const prepared = await prepareAndSign({ ...base(n.client), unordered: true, timeoutTimestamp });
  assert.equal(fromBinary(TxBodySchema, prepared.signed.bodyBytes).unordered, true);
  assert.equal(fromBinary(AuthInfoSchema, prepared.signed.authInfoBytes).signerInfos[0]?.sequence, 0n);
  assert.equal(prepared.sequence, 0n, "the sequence reported is the one signed at");
  assert.equal(prepared.accountNumber, 3n, "the account is still read for its number");

  const given = await prepareAndSign({ ...base(n.client), unordered: true, timeoutTimestamp, account: { accountNumber: 3n, sequence: 7n } });
  assert.equal(fromBinary(AuthInfoSchema, given.signed.authInfoBytes).signerInfos[0]?.sequence, 0n, "a given sequence is not signed either");

  const ordered = await prepareAndSign(base(n.client));
  assert.equal(fromBinary(AuthInfoSchema, ordered.signed.authInfoBytes).signerInfos[0]?.sequence, 7n);

  await assert.rejects(prepareAndSign({ ...base(n.client), unordered: true }), PrepareError);
  assert.equal(n.calls.filter((c) => c.includes("account_info")).length, 2, "the refusal comes before any request");
});

const broadcastOk = accepted(HASH);
const mismatch = () =>
  json({
    tx_response: txResponse({
      txhash: HASH,
      code: 32,
      codespace: "sdk",
      raw_log: "account sequence mismatch, expected 3, got 2: incorrect account sequence",
    }),
  });

test("sendTx broadcasts and confirms, and signs again at the sequence the chain names after a mismatch", async () => {
  const n = node();
  n.script.push(broadcastOk, included);
  const sent = await sendTx(base(n.client), { sleep: async () => {} });
  assert.equal(sent.response.height, 7n);
  assert.equal(sent.broadcast.hash, HASH);

  // A timeout height of zero is the body's no timeout: the wait polls on
  // instead of reading the chain as past it.
  const untimed = node();
  untimed.script.push(broadcastOk, notFound, included);
  const landed = await sendTx({ ...base(untimed.client), timeoutHeight: 0n }, { sleep: async () => {} });
  assert.equal(landed.response.height, 7n);
  assert.ok(!untimed.calls.some((c) => c.includes("blocks/latest")));

  // CheckTx names the sequence; the committed account still shows the old one
  // while the earlier transaction is pending, so the log is what is used.
  const r = node();
  r.script.push(mismatch, broadcastOk, included);
  const retried = await sendTx(base(r.client), { sleep: async () => {} });
  assert.equal(retried.sequence, 3n, "the second attempt signs with the sequence the chain expects");
  assert.equal(r.calls.filter((c) => c.includes("account_info")).length, 2, "the account is read again for its number only");

  // Simulation runs against the mempool's state and names the sequence first.
  const s = node();
  let simulations = 0;
  s.replies["POST /cosmos/tx/v1beta1/simulate"] = () =>
    simulations++ === 0
      ? gatewayError(2, "rpc error: code = Unknown desc = account sequence mismatch, expected 3, got 2: incorrect account sequence", 500)
      : json({ gas_info: { gas_wanted: "0", gas_used: "217391" }, result: null });
  s.script.push(broadcastOk, included);
  const resimulated = await sendTx(base(s.client), { sleep: async () => {} });
  assert.equal(resimulated.sequence, 3n);
  assert.equal(simulations, 2);

  const once = node();
  once.script.push(mismatch);
  await assert.rejects(sendTx(base(once.client), { retryOnSequenceMismatch: false }), BroadcastRefused);
  const given = node();
  given.script.push(mismatch);
  await assert.rejects(
    sendTx({ ...base(given.client), account: { accountNumber: 3n, sequence: 2n } }),
    BroadcastRefused,
    "a given sequence is the caller's to fix",
  );
});

test("once a broadcast is accepted, or may have been, sendTx signs nothing again whatever the node then answers", async () => {
  // The text the ante gives for a sequence another transaction took, in an error where the chain never puts it.
  const sequenceText = () => gatewayError(2, "account sequence mismatch, expected 3, got 2: incorrect account sequence", 500);
  const broadcasts = (calls: string[]) => calls.filter((c) => c === "POST /cosmos/tx/v1beta1/txs").length;
  const simulations = (calls: string[]) => calls.filter((c) => c.includes("simulate")).length;

  // The lookup after an accepted broadcast answers with it. Signing again at sequence 3 would pay twice.
  const afterAccepted = node();
  afterAccepted.script.push(broadcastOk, sequenceText);
  await assert.rejects(sendTx(base(afterAccepted.client), { sleep: async () => {} }), (err: unknown) => {
    // The caller holds neither the bytes nor the hash, so the error brings the hash of what the mempool holds.
    assert.ok(err instanceof InclusionUnknown);
    assert.equal(err.hash, HASH);
    assert.equal(err.broadcast.accepted, true);
    assert.ok(err.cause instanceof QueryError && err.cause.httpStatus === 500, "the node's answer is kept as the cause");
    return true;
  });
  assert.equal(broadcasts(afterAccepted.calls), 1, "one transaction reached the mempool");
  assert.equal(simulations(afterAccepted.calls), 1, "and nothing was prepared again");

  // The broadcast itself answers with it: the text is the node's, and the node may have taken the transaction.
  const atBroadcast = node();
  atBroadcast.script.push(sequenceText);
  await assert.rejects(sendTx(base(atBroadcast.client), { sleep: async () => {} }), (err: unknown) => err instanceof QueryError && err.httpStatus === 500);
  assert.equal(broadcasts(atBroadcast.calls), 1);
  assert.equal(simulations(atBroadcast.calls), 1);

  // A broadcast whose outcome is unknown is not sent or signed again either, and its error carries the hash.
  const lost = node();
  lost.script.push(() => new Response("<html>bad gateway</html>", { status: 502 }));
  await assert.rejects(sendTx(base(lost.client), { sleep: async () => {} }), (err: unknown) => err instanceof BroadcastUnknown && err.hash === HASH);
  assert.equal(broadcasts(lost.calls), 1);
  assert.equal(simulations(lost.calls), 1);
});

test("the flow signs in amino mode, encoding the messages through the client's registry", async () => {
  const prepared = await prepareAndSign({ ...base(node().client), mode: "amino" });
  assert.equal(prepared.signed.mode, "amino");
  assert.equal(utf8Decode(aminoSignDocBytes(prepared.signed.aminoSignDoc!)), f.sign_mode_amino!.sign_bytes, "the document a Ledger signs for this fixture");
});

test("the simulation runs over the body that is signed, its memo and timeouts included", async () => {
  const bodyOf = (request: { body: string | undefined }) => fromBinary(TxRawSchema, fromBase64(JSON.parse(request.body!).tx_bytes)).bodyBytes;
  const simulated = (n: ReturnType<typeof node>) => bodyOf(n.requests.find((r) => r.call.startsWith("POST /cosmos/tx/v1beta1/simulate"))!);

  const n = node();
  const prepared = await prepareAndSign({ ...base(n.client), memo: "invoice 7", timeoutHeight: 99n });
  assert.deepEqual(simulated(n), prepared.signed.bodyBytes);
  const signedBody = fromBinary(TxBodySchema, prepared.signed.bodyBytes);
  assert.equal(signedBody.memo, "invoice 7");
  assert.equal(signedBody.timeoutHeight, 99n);

  // An unordered body is refused by the chain at any sequence but zero, so the simulation must carry the flag too.
  const u = node("7");
  const until = create(TimestampSchema, { seconds: 1_900_000_000n });
  const unordered = await prepareAndSign({ ...base(u.client), unordered: true, timeoutTimestamp: until });
  assert.deepEqual(simulated(u), unordered.signed.bodyBytes);
  assert.equal(fromBinary(TxBodySchema, simulated(u)).unordered, true);
});

test("the fee the flow signs has the fee denomination's leg first, before a tax leg that sorts ahead of it", async () => {
  // The messages are taxed in aeur and the gas is paid in ausd: in denomination order the aeur leg would come first,
  // and the ante would take the base fee from its lift.
  const taxedInEur = () => {
    const n = node();
    n.replies["POST /ark/treasury/v1/compute_tax"] = () => json({ tax: [{ denom: "aeur", amount: "5000000000000000000" }], tax_base: [] });
    n.replies["GET /ark/treasury/v1/gas_prices"] = () =>
      json({
        gas_prices: [
          { denom: "aeur", gas_price: "117000000000.000000000000000000", derived_height: "5" },
          { denom: "ausd", gas_price: "137000000000.000000000000000000", derived_height: "5" },
        ],
        reference_gas_price: null,
      });
    return n;
  };
  const signedLegs = (prepared: { signed: { authInfoBytes: Uint8Array } }) => amounts(fromBinary(AuthInfoSchema, prepared.signed.authInfoBytes).fee!.amount);
  const input = (n: ReturnType<typeof node>) => ({ ...base(n.client), gasLimit: 200000n, headroom: { stable: "1.1", noah: "1.05" } });

  const prepared = await prepareAndSign(input(taxedInEur()));
  assert.deepEqual(signedLegs(prepared), ["30140000000000000ausd", "5500000000000000000aeur"]);
  assert.equal(prepared.quote.required.denom, "ausd");

  // The caller's order is signed as given: an empty one is denomination order, as arkd encodes the same fee.
  assert.deepEqual(signedLegs(await prepareAndSign({ ...input(taxedInEur()), legOrder: [] })), ["5500000000000000000aeur", "30140000000000000ausd"]);
});

test("the reference row prices its denomination when the sheet lists a row under the same name", async () => {
  // The chain lists the reference apart from the sheet. Given both, the reference row is the one arkd prices by.
  const n = node();
  n.replies["POST /ark/treasury/v1/compute_tax"] = () => json({ tax: [], tax_base: [] });
  n.replies["GET /ark/treasury/v1/gas_prices"] = () =>
    json({
      gas_prices: [{ denom: "ausd", gas_price: "137000000000.000000000000000000", derived_height: "5" }],
      reference_gas_price: { denom: "ausd", gas_price: "100000000000.000000000000000000", derived_height: "0" },
    });
  const prepared = await prepareAndSign({ ...base(n.client), gasLimit: 200000n });
  assert.deepEqual(amounts([prepared.quote.required]), ["20000000000000000ausd"]);
});

test("a fee denomination left out is said to be missing, before any request", async () => {
  const n = node();
  for (const feeDenom of ["", undefined as unknown as string]) {
    await assert.rejects(prepareAndSign({ ...base(n.client), feeDenom }), (err: unknown) => err instanceof FeeError && /no fee denomination/.test(err.message));
  }
  assert.equal(n.calls.length, 0);
});

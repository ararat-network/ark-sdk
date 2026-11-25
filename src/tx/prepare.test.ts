import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { aminoSignDocBytes } from "../codec/aminojson.js";
import { fromBase64, fromHex, toBase64, utf8Decode } from "../codec/bytes.js";
import { fromProtoJson, QueryClient } from "../defaults.js";
import { AuthInfoSchema, TxBodySchema, TxRawSchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { type Signer, SignerError, secp256k1PublicKey } from "../keys/signer.js";
import { QueryError } from "../query/gateway.js";
import { amounts, fixture, fixtureKey } from "../testing/fixtures.js";
import { accepted, fakeNode, gatewayError, included, json, notFound, stubFetch, txResponse, unavailable } from "../testing/node.js";
import { makeFee } from "./body.js";
import { BroadcastRefused, BroadcastUnknown, broadcastTx, InclusionUnknown } from "./broadcast.js";
import { signTx } from "./builder.js";
import { FeeError } from "./fee.js";
import { PrepareError, type PrepareTxInput, prepareTx, sendTx } from "./prepare.js";

const f = fixture("bank_send_taxed");
const key = fixtureKey("trader");
const signer = MemorySigner.fromPrivateKey(fromHex(key.private_key_hex));
const body = fromProtoJson(TxBodySchema, f.tx.body);

const HASH = f.tx_hash;

/** A node answering the flow's requests in order, each a route prefix with its reply; any other request takes the next step of its script. */
function node(sequence = "2") {
  return fakeNode([], {
    "GET /cosmos/auth/v1beta1/account_info/": () => json({ info: { address: signer.address, pub_key: null, account_number: "3", sequence } }),
    "POST /cosmos/tx/v1beta1/simulate": () => json({ gas_info: { gas_wanted: "0", gas_used: "217391" }, result: null }),
    "POST /ark/treasury/v1/compute_tax": () => json({ tax: f.fee.tax, tax_base: [{ denom: "ausd", amount: "10000000000000000000" }] }),
    "GET /ark/treasury/v1/gas_prices": () =>
      json({
        gas_prices: [f.fee.gas_price, { denom: "anoah", gas_price: "100000000000.000000000000000000", derived_height: "0" }],
        reference_gas_price: { denom: "axdr", gas_price: "100000000000.000000000000000000", derived_height: "0" },
      }),
  });
}

const signerAccount = { address: signer.address, publicKey: secp256k1PublicKey(signer.publicKey) };

const common = (client: QueryClient) => ({
  client,
  chainId: f.chain_id,
  messages: body.messages,
  feeDenom: "ausd",
  headroom: { stable: f.fee.pad_stable, noah: f.fee.pad_noah },
  gasAdjustment: 1.15,
});

/** What prepareTx takes: the account that will sign, and no signer. */
const base = (client: QueryClient) => ({ ...common(client), signerAccount });

/** What sendTx takes: the signer, and the address it signs for. */
const sending = (client: QueryClient) => ({ ...common(client), signer, address: signer.address });

/** The first two steps as a caller runs them: prepared, then signed as prepared. */
async function prepareSigned(input: PrepareTxInput, by: Signer = signer) {
  const prepared = await prepareTx(input);
  return { ...prepared, signed: await signTx(prepared.tx, by) };
}

test("prepareTx prices a transaction with no signer to ask, and signTx signs it as it was priced", async () => {
  const { client, calls } = node();
  let asked = 0;
  let signatures = 0;
  const counting: Signer = {
    accounts: () => {
      asked++;
      return signer.accounts();
    },
    signDirect: (address, doc) => {
      signatures++;
      return signer.signDirect(address, doc);
    },
    signAmino: (address, doc) => {
      signatures++;
      return signer.signAmino(address, doc);
    },
  };
  const prepared = await prepareTx(base(client));
  assert.equal(prepared.simulatedGas, 217391n);
  assert.equal(prepared.gasLimit, 250000n, "ceil(217391 × 1.15)");
  assert.equal(prepared.tx.accountNumber, 3n);
  assert.equal(prepared.tx.sequence, 2n);
  assert.deepEqual(amounts(prepared.quote.declared), amounts(f.fee.declared));
  assert.deepEqual(amounts(prepared.tx.fee.amount), amounts(f.fee.declared), "the fee to be signed is the one the quote declares");
  assert.deepEqual(amounts(prepared.taxBase), ["10000000000000000000ausd"]);
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

  const signed = await signTx(prepared.tx, counting);
  assert.equal(toBase64(signed.txBytes), f.tx_bytes);
  assert.equal(signed.hash, HASH);
  assert.equal(signatures, 1);
  assert.equal(asked, 0, "the account given when it was prepared is the one signed with");
  assert.equal(calls.length, 4, "signing asks the node nothing, so the fee signed is the fee quoted");
});

test("what prepareTx hands on is what signTx takes and nothing else of its input, and a signer of another account refuses it", async () => {
  const prepared = await prepareTx(base(node().client));
  assert.deepEqual(Object.keys(prepared.tx).sort(), [
    "accountNumber",
    "address",
    "chainId",
    "fee",
    "messages",
    "mode",
    "registry",
    "sequence",
    "signerAccount",
  ]);
  await assert.rejects(signTx(prepared.tx, MemorySigner.random()), SignerError);
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
  const prepared = await prepareSigned(base(new QueryClient(["http://a", "http://b"], { fetch })));
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes);
  assert.deepEqual(
    seen.filter((s) => s.call.includes("/ark/treasury/")).map((s) => `${s.url.slice(7, 8)} ${s.call.split("/").pop()}`),
    ["a compute_tax", "a gas_prices", "b compute_tax", "b gas_prices"],
  );
});

test("sendTx asks the signer for its accounts once and first, and fails before any request when the signer does", async () => {
  let asked = 0;
  const counting: Signer = {
    accounts: () => {
      asked++;
      return signer.accounts();
    },
    signDirect: (address, doc) => signer.signDirect(address, doc),
    signAmino: (address, doc) => signer.signAmino(address, doc),
  };
  // Signed twice, the second time at the sequence the chain names, and the signer's accounts are still asked for once.
  const n = node();
  n.script.push(mismatch, broadcastOk, included);
  const sent = await sendTx({ ...sending(n.client), signer: counting }, { retryOnSequenceMismatch: true, sleep: async () => {} });
  assert.equal(sent.tx.sequence, 3n);
  assert.equal(asked, 1, "a wallet or a device is asked once per transaction");

  // A signer that throws where it should reject is a rejection like any other.
  const locked: Signer = {
    accounts: () => {
      throw new SignerError("wallet is locked");
    },
    signDirect: (address, doc) => signer.signDirect(address, doc),
    signAmino: (address, doc) => signer.signAmino(address, doc),
  };
  const untouched = node();
  await assert.rejects(sendTx({ ...sending(untouched.client), signer: locked }), /wallet is locked/);
  // An address the signer holds no account for is the signer's refusal, as it is in signTx.
  await assert.rejects(sendTx({ ...sending(untouched.client), address: MemorySigner.random().address }), SignerError);
  assert.deepEqual(untouched.calls, [], "the node is asked nothing for a transaction no one can sign");
});

test("a given gas limit or account skips the query for it, and an unlisted fee denomination is refused", async () => {
  const { client, calls } = node();
  const prepared = await prepareSigned({ ...base(client), gasLimit: 250000n, account: { accountNumber: 3n, sequence: 2n } });
  assert.equal(prepared.simulatedGas, undefined);
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes);
  assert.ok(!calls.some((c) => c.includes("simulate") || c.includes("account_info")));
  await assert.rejects(prepareSigned({ ...base(client), feeDenom: "ajpy" }), FeeError);
  const tipped = await prepareSigned({ ...base(client), gasLimit: 250000n, account: { accountNumber: 3n, sequence: 2n }, tip: 5n });
  assert.equal(tipped.quote.tip?.amount, "5");
  assert.deepEqual(
    amounts(fromBinary(AuthInfoSchema, tipped.signed.authInfoBytes).fee!.amount),
    [...amounts(f.fee.declared), "5anoah"],
    "the tip is the last leg of the signed fee",
  );
  const missing = node();
  missing.replies["GET /cosmos/auth/v1beta1/account_info/"] = () => json({ info: null });
  await assert.rejects(prepareSigned(base(missing.client)), PrepareError);
});

test("an unordered transaction is signed at sequence zero and needs its timeout timestamp", async () => {
  // The ante refuses an unordered transaction that carries a sequence, so the account's is not used.
  const n = node("7");
  const timeoutTimestamp = create(TimestampSchema, { seconds: 1_900_000_000n });
  const prepared = await prepareSigned({ ...base(n.client), unordered: true, timeoutTimestamp });
  assert.equal(fromBinary(TxBodySchema, prepared.signed.bodyBytes).unordered, true);
  assert.equal(fromBinary(AuthInfoSchema, prepared.signed.authInfoBytes).signerInfos[0]?.sequence, 0n);
  assert.equal(prepared.tx.sequence, 0n, "the sequence prepared is the one signed at");
  assert.equal(prepared.tx.accountNumber, 3n, "the account is still read for its number");

  const given = await prepareSigned({ ...base(n.client), unordered: true, timeoutTimestamp, account: { accountNumber: 3n, sequence: 7n } });
  assert.equal(fromBinary(AuthInfoSchema, given.signed.authInfoBytes).signerInfos[0]?.sequence, 0n, "a given sequence is not signed either");

  const ordered = await prepareSigned(base(n.client));
  assert.equal(fromBinary(AuthInfoSchema, ordered.signed.authInfoBytes).signerInfos[0]?.sequence, 7n);

  await assert.rejects(prepareSigned({ ...base(n.client), unordered: true }), PrepareError);
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

test("sendTx broadcasts and confirms, and, asked to, signs again at the sequence the chain names after a mismatch", async () => {
  const n = node();
  n.script.push(broadcastOk, included);
  const sent = await sendTx(sending(n.client), { sleep: async () => {} });
  assert.equal(sent.response.height, 7n);
  assert.equal(sent.broadcast.hash, HASH);

  // A timeout height of zero is the body's no timeout: the wait polls on
  // instead of reading the chain as past it.
  const untimed = node();
  untimed.script.push(broadcastOk, notFound, included);
  const landed = await sendTx({ ...sending(untimed.client), timeoutHeight: 0n }, { sleep: async () => {} });
  assert.equal(landed.response.height, 7n);
  assert.ok(!untimed.calls.some((c) => c.includes("/tendermint/")));

  // CheckTx names the sequence; the committed account still shows the old one
  // while the earlier transaction is pending, so the log is what is used.
  const r = node();
  r.script.push(mismatch, broadcastOk, included);
  const retried = await sendTx(sending(r.client), { retryOnSequenceMismatch: true, sleep: async () => {} });
  assert.equal(retried.tx.sequence, 3n, "the second attempt signs with the sequence the chain expects");
  assert.equal(r.calls.filter((c) => c.includes("account_info")).length, 2, "the account is read again for its number only");

  // Simulation runs against the mempool's state and names the sequence first.
  const s = node();
  let simulations = 0;
  s.replies["POST /cosmos/tx/v1beta1/simulate"] = () =>
    simulations++ === 0
      ? gatewayError(2, "rpc error: code = Unknown desc = account sequence mismatch, expected 3, got 2: incorrect account sequence", 500)
      : json({ gas_info: { gas_wanted: "0", gas_used: "217391" }, result: null });
  s.script.push(broadcastOk, included);
  const resimulated = await sendTx(sending(s.client), { retryOnSequenceMismatch: true, sleep: async () => {} });
  assert.equal(resimulated.tx.sequence, 3n);
  assert.equal(simulations, 2);

  // Unasked, a mismatch is the refusal it is: signing again is a second signature, which is the caller's to ask for.
  const once = node();
  once.script.push(mismatch);
  await assert.rejects(sendTx(sending(once.client)), BroadcastRefused);
  assert.equal(once.calls.filter((c) => c.includes("simulate")).length, 1, "nothing is prepared again");
  const given = node();
  given.script.push(mismatch);
  await assert.rejects(
    sendTx({ ...sending(given.client), account: { accountNumber: 3n, sequence: 2n } }, { retryOnSequenceMismatch: true }),
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
  await assert.rejects(sendTx(sending(afterAccepted.client), { retryOnSequenceMismatch: true, sleep: async () => {} }), (err: unknown) => {
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
  await assert.rejects(
    sendTx(sending(atBroadcast.client), { retryOnSequenceMismatch: true, sleep: async () => {} }),
    (err: unknown) => err instanceof QueryError && err.httpStatus === 500,
  );
  assert.equal(broadcasts(atBroadcast.calls), 1);
  assert.equal(simulations(atBroadcast.calls), 1);

  // A broadcast whose outcome is unknown is not sent or signed again either, and its error carries the hash.
  const lost = node();
  lost.script.push(() => new Response("<html>bad gateway</html>", { status: 502 }));
  await assert.rejects(
    sendTx(sending(lost.client), { retryOnSequenceMismatch: true, sleep: async () => {} }),
    (err: unknown) => err instanceof BroadcastUnknown && err.hash === HASH,
  );
  assert.equal(broadcasts(lost.calls), 1);
  assert.equal(simulations(lost.calls), 1);
});

test("the three steps apart, prepareTx, signTx, and broadcastTx, ask what sendTx asks and end where it ends", async () => {
  const apart = node();
  apart.script.push(broadcastOk, included);
  const prepared = await prepareTx(base(apart.client));
  const signed = await signTx(prepared.tx, signer);
  const confirmed = await broadcastTx(apart.client, signed, { sleep: async () => {} });
  assert.equal(confirmed.broadcast.hash, HASH);
  assert.equal(confirmed.response.height, 7n);

  const whole = node();
  whole.script.push(broadcastOk, included);
  const sent = await sendTx(sending(whole.client), { sleep: async () => {} });
  assert.equal(toBase64(sent.signed.txBytes), toBase64(signed.txBytes));
  assert.deepEqual(amounts(sent.quote.declared), amounts(prepared.quote.declared));
  assert.deepEqual(apart.calls, whole.calls);
});

test("a signed transaction carries its timeout height, which the wait for its block then reads", async () => {
  const timed = await prepareSigned({ ...base(node().client), timeoutHeight: 10n });
  assert.equal(timed.signed.timeoutHeight, 10n);
  assert.equal((await prepareSigned(base(node().client))).signed.timeoutHeight, undefined);
});

test("the flow signs in amino mode, encoding the messages through the client's registry", async () => {
  const prepared = await prepareSigned({ ...base(node().client), mode: "amino" });
  assert.equal(prepared.signed.mode, "amino");
  assert.equal(utf8Decode(aminoSignDocBytes(prepared.signed.aminoSignDoc!)), f.sign_mode_amino.sign_bytes, "the document a Ledger signs for this fixture");
});

test("the simulation runs over the body that is signed, its memo and timeouts included", async () => {
  const bodyOf = (request: { body: string | undefined }) => fromBinary(TxRawSchema, fromBase64(JSON.parse(request.body!).tx_bytes)).bodyBytes;
  const simulated = (n: ReturnType<typeof node>) => bodyOf(n.requests.find((r) => r.call.startsWith("POST /cosmos/tx/v1beta1/simulate"))!);

  const n = node();
  const prepared = await prepareSigned({ ...base(n.client), memo: "invoice 7", timeoutHeight: 99n });
  assert.deepEqual(simulated(n), prepared.signed.bodyBytes);
  const signedBody = fromBinary(TxBodySchema, prepared.signed.bodyBytes);
  assert.equal(signedBody.memo, "invoice 7");
  assert.equal(signedBody.timeoutHeight, 99n);

  // An unordered body is refused by the chain at any sequence but zero, so the simulation must carry the flag too.
  const u = node("7");
  const until = create(TimestampSchema, { seconds: 1_900_000_000n });
  const unordered = await prepareSigned({ ...base(u.client), unordered: true, timeoutTimestamp: until });
  assert.deepEqual(simulated(u), unordered.signed.bodyBytes);
  assert.equal(fromBinary(TxBodySchema, simulated(u)).unordered, true);
});

test("the simulation carries no fee, whatever the input held beside the members the flow names", async () => {
  // An object wider than the flow's input passes the type check when it is no literal, as a caller's own record of a
  // transaction is not. A fee in it would be simulated with: its gas limit, and its legs for the ante to charge.
  const n = node();
  const wider = { ...base(n.client), fee: makeFee({ amount: [{ denom: "ausd", amount: 999n }], gasLimit: 7n }) };
  const prepared = await prepareSigned(wider);
  const request = n.requests.find((r) => r.call.startsWith("POST /cosmos/tx/v1beta1/simulate"))!;
  const fee = fromBinary(AuthInfoSchema, fromBinary(TxRawSchema, fromBase64(JSON.parse(request.body!).tx_bytes)).authInfoBytes).fee!;
  assert.deepEqual(amounts(fee.amount), []);
  assert.equal(fee.gasLimit, 0n);
  assert.equal(toBase64(prepared.signed.txBytes), f.tx_bytes, "and the fee that is signed is the one the flow priced");
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

  const prepared = await prepareSigned(input(taxedInEur()));
  assert.deepEqual(signedLegs(prepared), ["30140000000000000ausd", "5500000000000000000aeur"]);
  assert.equal(prepared.quote.required.denom, "ausd");

  // The caller's order is signed as given: an empty one is denomination order, as arkd encodes the same fee.
  assert.deepEqual(signedLegs(await prepareSigned({ ...input(taxedInEur()), legOrder: [] })), ["5500000000000000000aeur", "30140000000000000ausd"]);
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
  const prepared = await prepareSigned({ ...base(n.client), gasLimit: 200000n });
  assert.deepEqual(amounts([prepared.quote.required]), ["20000000000000000ausd"]);
});

test("a fee denomination left out is said to be missing, before any request", async () => {
  const n = node();
  for (const feeDenom of ["", undefined as unknown as string]) {
    await assert.rejects(prepareSigned({ ...base(n.client), feeDenom }), (err: unknown) => err instanceof FeeError && /no fee denomination/.test(err.message));
  }
  assert.equal(n.calls.length, 0);
});

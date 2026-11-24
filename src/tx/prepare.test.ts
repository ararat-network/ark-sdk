import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { fromHex, toBase64 } from "../codec/bytes.js";
import { fromProtoJson, type QueryClient } from "../defaults.js";
import { AuthInfoSchema, TxBodySchema } from "../gen/cosmos/tx/v1beta1/tx_pb.js";
import { MemorySigner } from "../keys/memory_signer.js";
import { type Signer, SignerError } from "../keys/signer.js";
import { amounts, fixture, fixtureKey } from "../testing/fixtures.js";
import { fakeNode, json, txResponse } from "../testing/node.js";
import { BroadcastRefused } from "./broadcast.js";
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

const broadcastOk = () => json({ tx_response: txResponse({ txhash: HASH }) });
const mismatch = () =>
  json({
    tx_response: txResponse({
      txhash: HASH,
      code: 32,
      codespace: "sdk",
      raw_log: "account sequence mismatch, expected 3, got 2: incorrect account sequence",
    }),
  });
/** The block's result under the hash the lookup asked for, as an honest node answers. */
const included = (call: string) => json({ tx_response: txResponse({ txhash: call.split("/").pop(), height: "7", gas_wanted: "250000", gas_used: "98227" }) });

test("sendTx broadcasts and confirms, and signs again at the sequence the chain names after a mismatch", async () => {
  const n = node();
  n.script.push(broadcastOk, included);
  const sent = await sendTx(base(n.client), { sleep: async () => {} });
  assert.equal(sent.response.height, 7n);
  assert.equal(sent.broadcast.hash, HASH);

  // A timeout height of zero is the body's no timeout: the wait polls on
  // instead of reading the chain as past it.
  const untimed = node();
  untimed.script.push(broadcastOk, () => json({ code: 5, message: "tx not found", details: [] }, 404), included);
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
      ? json(
          { code: 2, message: "rpc error: code = Unknown desc = account sequence mismatch, expected 3, got 2: incorrect account sequence", details: [] },
          500,
        )
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

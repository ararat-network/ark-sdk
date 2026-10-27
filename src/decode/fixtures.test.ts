// Every fixture through the decoder: the transaction from its bytes, each
// typed event, inside transactions and in blocks, and each result.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { AnySchema } from "@bufbuild/protobuf/wkt";

import { fromBase64 } from "../codec/bytes.js";
import type { JsonObject } from "../codec/json.js";
import { SignMode } from "../gen/cosmos/tx/signing/v1beta1/signing_pb.js";
import { fixtures, type Fixture } from "../testing/fixtures.js";
import { expectedTxJson } from "../testing/gaps.js";
import { decodeEvent, decodeEvents, eventsByMessage } from "./events.js";
import { classifyResult, describeOutcome } from "./result.js";
import { decodeMessage, decodeTx } from "./tx.js";

const all = fixtures();

for (const f of all) {
  if (!f.tx_bytes) continue;
  test(`${f.name}: decodeTx names every message and renders the chain's JSON`, () => {
    const decoded = decodeTx(fromBase64(f.tx_bytes!));
    assert.equal(decoded.hash, f.tx_hash);
    const messages = ((f.tx as JsonObject)["body"] as JsonObject)["messages"] as JsonObject[];
    assert.deepEqual(
      decoded.messages.map((m) => m.typeUrl),
      messages.map((m) => m["@type"]),
    );
    assert.ok(decoded.messages.every((m) => m.known && m.message !== undefined && m.schema !== undefined));
    assert.deepEqual(decoded.json, expectedTxJson(f.name, f.tx));
    assert.equal(decoded.memo, ((f.tx as JsonObject)["body"] as JsonObject)["memo"]);
    assert.equal(decoded.signers.length, 1);
    assert.equal(decoded.signers[0]?.sequence, BigInt(f.signer!.sequence));
    assert.equal(decoded.signers[0]?.mode, SignMode.DIRECT);
    assert.equal(decoded.fee?.gasLimit, BigInt(f.fee!.gas_limit));
    assert.equal(decoded.signatures.length, 1);
  });
}

function checkEvents(f: Fixture, events: NonNullable<Fixture["events"]>, block: boolean): void {
  for (const e of events) {
    const d = decodeEvent(e);
    if (e.typed !== undefined) {
      assert.ok(d.typed, `${f.name}: ${e.type} decodes`);
      assert.deepEqual(d.json, e.typed, `${f.name}: ${e.type}`);
    } else {
      assert.equal(d.typed, undefined, `${f.name}: ${e.type} is not a typed event`);
      assert.equal(d.json, undefined);
    }
    // A block event from BeginBlock or EndBlock names its mode; one from the vote-extension pre-block carries none.
    if (block) assert.ok(d.mode === undefined || d.mode === "BeginBlock" || d.mode === "EndBlock", `${f.name}: ${e.type} mode ${d.mode}`);
    else assert.equal(d.mode, undefined);
    const index = e.attributes.find((a) => a.key === "msg_index");
    assert.equal(d.msgIndex, index ? Number(index.value) : undefined);
  }
}

test("every typed event in every fixture decodes to its pinned form", () => {
  let typedCount = 0;
  for (const f of all) {
    checkEvents(f, f.events ?? [], false);
    checkEvents(f, f.block_events ?? [], true);
    typedCount += (f.events ?? []).filter((e) => e.typed).length + (f.block_events ?? []).filter((e) => e.typed).length;
  }
  assert.ok(typedCount > 50, `typed events seen: ${typedCount}`);
});

test("events group by the message that emitted them", () => {
  const f = all.find((x) => x.name === "multi_message")!;
  const groups = eventsByMessage(decodeEvents(f.events!));
  assert.ok(groups.has(undefined), "transaction-level events");
  assert.ok(groups.has(0) && groups.has(1), "one group per message");
  assert.ok(groups.get(0)!.some((e) => e.type === "message" && e.attributes.some((a) => a.key === "action" && a.value === "/cosmos.bank.v1beta1.MsgSend")));
  assert.ok(groups.get(1)!.some((e) => e.type === "delegate"));
});

test("results classify as ok, SDK refusal, execution failure, or module error", () => {
  const byName = new Map(all.map((f) => [f.name, f]));
  const want: Record<string, string> = {
    bank_send_taxed: "ok",
    refused_fee_short_of_tax: "refused",
    failed_not_registrar: "failed",
    market_settle_refused: "module_error",
    distribution_withdraw_validator_commission_refused: "module_error",
    slashing_unjail_refused: "module_error",
    wasm_migrate_contract_refused: "module_error",
  };
  for (const [name, kind] of Object.entries(want)) {
    const o = classifyResult(byName.get(name)!.result!);
    assert.equal(o.kind, kind, name);
    assert.ok(describeOutcome(o).length > 0);
  }
  const refused = classifyResult(byName.get("refused_fee_short_of_tax")!.result!);
  assert.ok(refused.kind === "refused" && refused.code === 13 && refused.reason === "insufficient fee" && /transfer tax/.test(refused.log));
  const failed = classifyResult(byName.get("failed_not_registrar")!.result!);
  assert.ok(failed.kind === "failed" && failed.messageIndex === 0 && /registrar/.test(failed.log));
  const settle = classifyResult(byName.get("market_settle_refused")!.result!);
  assert.ok(settle.kind === "module_error" && settle.module === "market" && settle.code === 5 && settle.messageIndex === 0);
  assert.equal(all.filter((f) => f.result && f.result.code === 0).length, all.filter((f) => f.result).length - 6, "six fixtures record a refusal");
  assert.equal(classifyResult({ code: 111222, codespace: "undefined", rawLog: "panic" }).kind, "panic");
  assert.equal(classifyResult({ code: 1, codespace: "", rawLog: "x" }).kind, "failed");
});

test("an unknown message is decoded as unknown with its raw bytes", () => {
  const any = create(AnySchema, { typeUrl: "/ark.future.v1.MsgNew", value: new Uint8Array([8, 1]) });
  const d = decodeMessage(any);
  assert.equal(d.known, false);
  assert.equal(d.message, undefined);
  assert.deepEqual(d.json, { "@type": "/ark.future.v1.MsgNew", value: "CAE=" });
});

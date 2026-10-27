import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";

import { LegacyDec } from "../codec/dec.js";
import { GasPriceSchema } from "../gen/ark/treasury/v1/treasury_pb.js";
import { coin } from "./body.js";
import { adjustGas, affordableFeeDenoms, arkdPolicy, FeeError, liftLeg, quoteFee, requiredGasFee, sumCoins } from "./fee.js";

const price = (denom: string, decimal: string, derivedHeight = 2n) =>
  create(GasPriceSchema, { denom, gasPrice: LegacyDec.fromString(decimal).toWire(), derivedHeight });

test("the gas leg is ceil(price × gas) and a lift is ceil(amount × multiplier)", () => {
  assert.equal(requiredGasFee(price("ausd", "72939460247.9941648"), 250000n).amount, "18234865061998542");
  assert.equal(requiredGasFee(price("anoah", "100000000000"), 400000n).amount, "40000000000000000");
  assert.equal(liftLeg(coin("ausd", "3"), "1.1").amount, "4", "ceiling, not rounding");
  assert.equal(liftLeg(coin("ausd", "10"), "1").amount, "10");
  assert.throws(() => liftLeg(coin("ausd", "10"), "0.9"), FeeError);
  assert.throws(() => requiredGasFee(price("ausd", "1"), 0n), FeeError);
});

test("sumCoins merges per denomination in denomination order and drops zero legs", () => {
  const out = sumCoins([coin("ausd", "5"), coin("anoah", "0")], [coin("ausd", "1"), coin("aeur", "2")]);
  assert.deepEqual(
    out.map((c) => c.amount + c.denom),
    ["2aeur", "6ausd"],
  );
  assert.throws(() => sumCoins([coin("ausd", "-1")]), FeeError);
});

test("a quote declares tax plus the gas leg, each lifted by its own headroom", () => {
  const q = quoteFee({
    tax: [coin("ausd", "50000000000000000")],
    gasPrice: price("anoah", "100000000000", 0n),
    gasLimit: 250000n,
    headroom: arkdPolicy.headroom,
  });
  assert.deepEqual(
    q.declared.map((c) => c.amount + c.denom),
    ["26250000000000000anoah", "55000000000000000ausd"],
  );
  assert.equal(q.maxTip?.amount, "1250000000000000", "the NOAH headroom is the most the tip can be");
  assert.equal(q.derivedHeight, 0n);
  const ordered = quoteFee({
    tax: [coin("ausd", "10")],
    gasPrice: price("anoah", "1"),
    gasLimit: 10n,
    headroom: { stable: "1", noah: "1" },
    legOrder: ["ausd"],
  });
  assert.deepEqual(
    ordered.declared.map((c) => c.denom),
    ["ausd", "anoah"],
    "the leg order names the paying leg",
  );
  assert.equal(quoteFee({ tax: [], gasPrice: price("ausd", "1"), gasLimit: 1n, headroom: arkdPolicy.headroom }).maxTip, undefined);
});

test("adjustGas is the ceiling of the simulated gas times the caller's adjustment", () => {
  assert.equal(adjustGas(98227n, 1.15), 112962n);
  assert.equal(adjustGas(100000n, 1), 100000n);
  assert.throws(() => adjustGas(1n, 0.5), FeeError);
});

test("affordable denominations follow arkd's order and net the principal moved", () => {
  const sheet = [price("aeur", "1"), price("anoah", "1"), price("ausd", "1")];
  const tax = [coin("ausd", "10")];
  const taxBase = [coin("ausd", "1000")];
  const headroom = { stable: "1", noah: "1" };
  // ausd pays: 1000 moved + 10 tax + 10 gas; anoah pays 10 gas but the 1010 ausd still leaves.
  assert.deepEqual(
    affordableFeeDenoms({ sheet, tax, taxBase, spendable: [coin("ausd", "1020"), coin("anoah", "10"), coin("aeur", "10")], gasLimit: 10n, headroom }),
    ["ausd", "anoah", "aeur"],
  );
  assert.deepEqual(affordableFeeDenoms({ sheet, tax, taxBase, spendable: [coin("ausd", "1015"), coin("anoah", "10")], gasLimit: 10n, headroom }), ["anoah"]);
  assert.deepEqual(affordableFeeDenoms({ sheet, tax, taxBase, spendable: [coin("ausd", "1000")], gasLimit: 10n, headroom }), []);
});

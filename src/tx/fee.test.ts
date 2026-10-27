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

test("with a stable gas leg, tax plus the gas leg are each lifted and there is no tip", () => {
  const q = quoteFee({
    tax: [coin("ausd", "50000000000000000"), coin("aeur", "1000")],
    gasPrice: price("ausd", "72939460247.9941648"),
    gasLimit: 250000n,
    headroom: arkdPolicy.headroom,
  });
  // ausd: ceil((5e16 tax + 18234865061998542 gas) × 1.1); aeur: ceil(1000 × 1.1).
  assert.deepEqual(
    q.declared.map((c) => c.amount + c.denom),
    ["1100aeur", "75058351568198397ausd"],
  );
  assert.equal(q.tip, undefined);
  assert.equal(q.derivedHeight, 2n);
});

test("with a NOAH gas leg, the tax legs are exact and the lift is the whole tip", () => {
  const q = quoteFee({
    tax: [coin("ausd", "50000000000000000")],
    gasPrice: price("anoah", "100000000000", 0n),
    gasLimit: 250000n,
    headroom: arkdPolicy.headroom,
  });
  assert.deepEqual(
    q.declared.map((c) => c.amount + c.denom),
    ["26250000000000000anoah", "50000000000000000ausd"],
    "a lifted tax leg would pay the base fee itself and leave all of the NOAH leg as tip",
  );
  assert.equal(q.required.amount, "25000000000000000");
  assert.equal(q.tip?.amount, "1250000000000000", "the margin, charged whole");
  assert.equal(q.derivedHeight, 0n);
  const untaxed = quoteFee({ tax: [], gasPrice: price("anoah", "100000000000"), gasLimit: 250000n, headroom: arkdPolicy.headroom });
  assert.deepEqual(
    untaxed.declared.map((c) => c.amount + c.denom),
    ["26250000000000000anoah"],
  );
  assert.equal(untaxed.tip?.amount, "1250000000000000");
});

test("a tip is its own NOAH leg, last, beside a stable gas leg, and part of the NOAH leg when NOAH pays", () => {
  const stable = quoteFee({ tax: [coin("ausd", "10")], gasPrice: price("ausd", "1"), gasLimit: 10n, headroom: { stable: "1.1", noah: "1" }, tip: 7n });
  assert.deepEqual(
    stable.declared.map((c) => c.amount + c.denom),
    ["22ausd", "7anoah"],
    "the stable leg pays the base fee from its lift; the tip is whole",
  );
  assert.equal(stable.tip?.amount, "7");
  const ordered = quoteFee({
    tax: [coin("aeur", "10"), coin("ausd", "10")],
    gasPrice: price("ausd", "1"),
    gasLimit: 10n,
    headroom: { stable: "1", noah: "1" },
    tip: 1n,
    legOrder: ["ausd"],
  });
  assert.deepEqual(
    ordered.declared.map((c) => c.denom),
    ["ausd", "aeur", "anoah"],
    "the paying leg first, the tip after every leg that can pay",
  );
  const noah = quoteFee({ tax: [coin("ausd", "10")], gasPrice: price("anoah", "1"), gasLimit: 100n, headroom: { stable: "1.1", noah: "1.05" }, tip: 7n });
  assert.deepEqual(
    noah.declared.map((c) => c.amount + c.denom),
    ["112anoah", "10ausd"],
    "ceil(100 × 1.05) plus the tip, beside the exact tax",
  );
  assert.equal(noah.tip?.amount, "12", "the margin and the tip, both charged whole");
  const none = quoteFee({ tax: [coin("ausd", "10")], gasPrice: price("ausd", "1"), gasLimit: 10n, headroom: { stable: "1", noah: "1" }, tip: 0n });
  assert.deepEqual(
    none.declared.map((c) => c.denom),
    ["ausd"],
  );
  assert.equal(none.tip, undefined);
  assert.throws(() => quoteFee({ tax: [], gasPrice: price("ausd", "1"), gasLimit: 1n, headroom: { stable: "1", noah: "1" }, tip: -1n }), FeeError);
});

test("a headroom below 1 is refused on either leg, even the one a quote does not use", () => {
  const taxed = { tax: [coin("ausd", "10")], gasLimit: 10n };
  assert.throws(() => quoteFee({ ...taxed, gasPrice: price("anoah", "1"), headroom: { stable: "0.9", noah: "1" } }), FeeError);
  assert.throws(() => quoteFee({ ...taxed, gasPrice: price("ausd", "1"), headroom: { stable: "1", noah: "0.5" } }), FeeError);
});

test("the leg order names the paying leg", () => {
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
  );
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
  // A 5 tip: paying in anoah needs 15 of it; paying in ausd or aeur needs the 5 beside the rest.
  assert.deepEqual(
    affordableFeeDenoms({ sheet, tax, taxBase, spendable: [coin("ausd", "1020"), coin("anoah", "10"), coin("aeur", "10")], gasLimit: 10n, headroom, tip: 5n }),
    ["ausd", "aeur"],
  );
  assert.deepEqual(affordableFeeDenoms({ sheet, tax, taxBase, spendable: [coin("ausd", "1000")], gasLimit: 10n, headroom }), []);
});

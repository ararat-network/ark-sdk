import assert from "node:assert/strict";
import { test } from "node:test";

import { DecError, LegacyDec } from "./dec.js";

test("wire and decimal text round trip", () => {
  const cases: [string, string][] = [
    ["0", "0.000000000000000000"],
    ["", "0.000000000000000000"],
    ["1", "0.000000000000000001"],
    ["100000000000000000", "0.100000000000000000"],
    ["72939460247994164800000000000", "72939460247.994164800000000000"],
    ["-500000000000000000", "-0.500000000000000000"],
    ["1000000000000000000000", "1000.000000000000000000"],
  ];
  for (const [wire, text] of cases) {
    const d = LegacyDec.fromWire(wire);
    assert.equal(d.toString(), text, wire);
    assert.equal(LegacyDec.fromString(text).toWire(), wire === "" ? "0" : wire, text);
  }
  assert.equal(LegacyDec.fromString("1.1").toWire(), "1100000000000000000");
  assert.equal(LegacyDec.fromString("-3").toWire(), "-3000000000000000000");
  assert.throws(() => LegacyDec.fromString("1.0000000000000000001"), DecError);
  assert.throws(() => LegacyDec.fromString("1e3"), DecError);
  assert.throws(() => LegacyDec.fromWire("1.5"), DecError);
});

test("fee arithmetic matches the fixtures' figures", () => {
  // bank_send_taxed: ceil(gas_price × 250000) and ceil(leg × 1.1).
  const price = LegacyDec.fromWire("72939460247994164800000000000");
  assert.equal(price.mulInt(250000n).ceil(), 18234865061998542n);
  const leg = LegacyDec.fromInt(50000000000000000n + 18234865061998542n).mul(LegacyDec.fromString("1.1"));
  assert.equal(leg.ceil(), 75058351568198397n);
  // multi_message: a NOAH leg padded 1.05.
  assert.equal(LegacyDec.fromInt(40000000000000000n).mul(LegacyDec.fromString("1.05")).ceil(), 42000000000000000n);
});

test("mul rounds half to even at the 18th place", () => {
  const tiny = LegacyDec.fromWire("1"); // 1e-18
  const half = LegacyDec.fromString("0.5");
  assert.equal(tiny.mul(half).toWire(), "0", "0.5e-18 rounds to even 0");
  assert.equal(LegacyDec.fromWire("3").mul(half).toWire(), "2", "1.5e-18 rounds to even 2");
  assert.equal(LegacyDec.fromWire("5").mul(half).toWire(), "2", "2.5e-18 rounds to even 2");
  assert.equal(LegacyDec.fromWire("7").mul(LegacyDec.fromString("0.6")).toWire(), "4", "4.2e-18 rounds down");
  assert.equal(LegacyDec.fromWire("-3").mul(half).toWire(), "-2");
});

test("ceil, floor, and truncate on negatives", () => {
  const d = LegacyDec.fromString("-1.5");
  assert.equal(d.ceil(), -1n);
  assert.equal(d.floor(), -2n);
  assert.equal(d.truncateInt(), -1n);
  assert.equal(LegacyDec.fromString("2").ceil(), 2n);
  assert.ok(d.isNegative());
  assert.equal(d.compare(LegacyDec.zero()), -1);
  assert.equal(LegacyDec.one().add(d).toString(), "-0.500000000000000000");
});

test("quo carries 36 places and rounds like Go, roundInt ties to even", () => {
  const third = LegacyDec.fromInt(1n).quo(LegacyDec.fromInt(3n));
  assert.equal(third.toString(), "0.333333333333333333");
  assert.equal(LegacyDec.fromInt(2n).quo(LegacyDec.fromInt(3n)).toString(), "0.666666666666666667");
  assert.equal(LegacyDec.fromInt(1n).quo(LegacyDec.fromString("0.5")).toString(), "2.000000000000000000");
  assert.equal(LegacyDec.fromInt(7n).quoInt(2).toString(), "3.500000000000000000");
  assert.throws(() => LegacyDec.one().quo(LegacyDec.zero()), DecError);
  assert.equal(LegacyDec.fromString("2.5").roundInt(), 2n);
  assert.equal(LegacyDec.fromString("3.5").roundInt(), 4n);
  assert.equal(LegacyDec.fromString("3.4999").roundInt(), 3n);
  assert.equal(LegacyDec.fromString("-2.5").roundInt(), -2n);
  // A continuous vesting seat halfway: 5,000,000 NOAH × (t−start)/(end−start) with the SDK's Dec arithmetic.
  const s = LegacyDec.fromInt(63_072_000n).quo(LegacyDec.fromInt(126_144_000n));
  assert.equal(LegacyDec.fromInt(5_000_000n * 10n ** 18n).mul(s).roundInt(), 2_500_000n * 10n ** 18n);
});

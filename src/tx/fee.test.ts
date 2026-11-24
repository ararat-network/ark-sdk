import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { coin } from "../codec/coins.js";
import { LegacyDec } from "../codec/dec.js";
import { GasPriceSchema } from "../gen/ark/treasury/v1/treasury_pb.js";
import { type Coin, CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { amounts } from "../testing/fixtures.js";
import { adjustGas, affordableFeeDenoms, arkdPolicy, FeeError, liftLeg, quoteFee, requiredGasFee } from "./fee.js";

const price = (denom: string, decimal: string, derivedHeight = 2n) =>
  create(GasPriceSchema, { denom, gasPrice: LegacyDec.fromString(decimal).toWire(), derivedHeight });

test("the gas leg is ceil(price × gas) and a lift is ceil(amount × multiplier)", () => {
  assert.equal(requiredGasFee(price("ausd", "72939460247.9941648"), 250000n).amount, "18234865061998542");
  assert.equal(requiredGasFee(price("anoah", "100000000000"), 400000n).amount, "40000000000000000");
  assert.equal(liftLeg(coin("ausd", "3"), "1.1").amount, "4", "ceiling, not rounding");
  assert.equal(liftLeg(coin("ausd", "10"), "1").amount, "10");
  assert.throws(() => liftLeg(coin("ausd", "10"), "0.9"), FeeError);
  // A leg out of a decoded message carries its sender's text, which the chain reads with the base taken from it.
  assert.equal(liftLeg(create(CoinSchema, { denom: "ausd", amount: "0100" }), "1.5").amount, "96", "64 lifted, not 100");
  assert.throws(() => requiredGasFee(price("ausd", "1"), 0n), FeeError);
});

test("with a stable gas leg, tax plus the gas leg are each lifted and there is no tip", () => {
  const q = quoteFee({
    tax: [coin("ausd", "50000000000000000"), coin("aeur", "1000")],
    gasPrice: price("ausd", "72939460247.9941648"),
    gasLimit: 250000n,
    headroom: arkdPolicy.headroom,
  });
  // ausd: ceil((5e16 tax + 18234865061998542 gas) × 1.1); aeur: ceil(1000 × 1.1). The gas leg's denomination is first.
  assert.deepEqual(amounts(q.declared), ["75058351568198397ausd", "1100aeur"]);
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
    amounts(q.declared),
    ["26250000000000000anoah", "50000000000000000ausd"],
    "a lifted tax leg would pay the base fee itself and leave all of the NOAH leg as tip",
  );
  assert.equal(q.required.amount, "25000000000000000");
  assert.equal(q.tip?.amount, "1250000000000000", "the margin, charged whole");
  assert.equal(q.derivedHeight, 0n);
  const untaxed = quoteFee({ tax: [], gasPrice: price("anoah", "100000000000"), gasLimit: 250000n, headroom: arkdPolicy.headroom });
  assert.deepEqual(amounts(untaxed.declared), ["26250000000000000anoah"]);
  assert.equal(untaxed.tip?.amount, "1250000000000000");
});

test("a tip is its own NOAH leg, last, beside a stable gas leg, and part of the NOAH leg when NOAH pays", () => {
  const stable = quoteFee({ tax: [coin("ausd", "10")], gasPrice: price("ausd", "1"), gasLimit: 10n, headroom: { stable: "1.1", noah: "1" }, tip: 7n });
  assert.deepEqual(amounts(stable.declared), ["22ausd", "7anoah"], "the stable leg pays the base fee from its lift; the tip is whole");
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
  assert.deepEqual(amounts(noah.declared), ["112anoah", "10ausd"], "ceil(100 × 1.05) plus the tip, beside the exact tax");
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

/**
 * The ante's choice of the leg that pays the base fee, as app/ante/fee.go makes it: the stable legs in encoded order,
 * NOAH passed over, and the first whose slack above its tax is positive and covers its own requirement.
 */
function antePays(legs: readonly Coin[], tax: readonly Coin[], required: Record<string, bigint>): string | undefined {
  for (const leg of legs) {
    if (leg.denom === "anoah") continue;
    const slack = BigInt(leg.amount) - BigInt(tax.find((t) => t.denom === leg.denom)?.amount ?? "0");
    const needs = required[leg.denom];
    if (slack > 0n && needs !== undefined && slack >= needs) return leg.denom;
  }
  return undefined;
}

test("a stable gas leg is encoded first, so it is the leg the ante charges and not a tax leg's lift", () => {
  // A send of 1000 EUR taxed 5 EUR, gas paid in ausd: the tax leg's 10% lift is 0.5 EUR, twenty times the base fee.
  const tax = [coin("aeur", 5n * 10n ** 18n)];
  const sheet = { aeur: price("aeur", "117000000000"), ausd: price("ausd", "137000000000") };
  const gasLimit = 200000n;
  const required = { aeur: BigInt(requiredGasFee(sheet.aeur, gasLimit).amount), ausd: BigInt(requiredGasFee(sheet.ausd, gasLimit).amount) };
  const input = { tax, gasPrice: sheet.ausd, gasLimit, headroom: arkdPolicy.headroom };

  const q = quoteFee(input);
  assert.deepEqual(amounts(q.declared), ["30140000000000000ausd", "5500000000000000000aeur"]);
  assert.equal(antePays(q.declared, tax, required), "ausd", "the denomination the quote names as required is the one charged");
  assert.equal(q.required.denom, "ausd");

  // Denomination order, as arkd encodes it, on request: the ante then stops at the tax leg, and aeur pays the base fee.
  const sorted = quoteFee({ ...input, legOrder: [] });
  assert.deepEqual(amounts(sorted.declared), ["5500000000000000000aeur", "30140000000000000ausd"]);
  assert.equal(antePays(sorted.declared, tax, required), "aeur");

  // A caller's order is used as given, and what it does not name follows in denomination order.
  const three = quoteFee({ ...input, tax: [...tax, coin("ajpy", 10n ** 18n)], legOrder: ["ajpy"] });
  assert.deepEqual(
    three.declared.map((c) => c.denom),
    ["ajpy", "aeur", "ausd"],
  );
  // A tip stays last, after the legs that can pay.
  assert.deepEqual(
    quoteFee({ ...input, tip: 7n }).declared.map((c) => c.denom),
    ["ausd", "aeur", "anoah"],
  );
  // The tax and the gas in one denomination are one leg, and it is first.
  assert.deepEqual(
    quoteFee({ ...input, tax: [coin("aeur", 1000n), coin("ausd", 10n), coin("axdr", 5n)] }).declared.map((c) => c.denom),
    ["ausd", "aeur", "axdr"],
  );
  // Beside a NOAH gas leg no stable leg has slack, so the order decides nothing and stays the denominations'.
  const noah = quoteFee({ ...input, tax: [coin("ausd", 10n), coin("aeur", 1000n)], gasPrice: price("anoah", "1") });
  assert.deepEqual(amounts(noah.declared), ["1000aeur", "210000anoah", "10ausd"]);
  assert.equal(antePays(noah.declared, noah.tax, required), undefined, "no stable leg can pay, so NOAH does");
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

test("the reference denomination is offered when its row is given, where arkd ranks it: after NOAH, before the rest", () => {
  const headroom = { stable: "1", noah: "1" };
  const rich = (...denoms: string[]) => denoms.map((d) => coin(d, 10n ** 9n));
  const reference = price("axdr", "1", 0n);
  // The orders are arkd's pickFeeDenom candidates for the same sheets, run at the pinned tag.
  const sheet = [price("ausd", "1"), price("anoah", "1"), price("aeur", "1")];
  const send = { sheet, tax: [coin("ausd", "10")], taxBase: [coin("ausd", "1000")], spendable: rich("ausd", "anoah", "aeur", "axdr"), gasLimit: 10n, headroom };
  assert.deepEqual(affordableFeeDenoms({ ...send, reference }), ["ausd", "anoah", "axdr", "aeur"]);
  assert.deepEqual(affordableFeeDenoms(send), ["ausd", "anoah", "aeur"], "without its row the reference is not priced, so not offered");

  // A send of the reference denomination itself: arkd's first choice, which the sheet's rows alone never offered.
  const others = [price("aeur", "1"), price("akrw", "1"), price("ausd", "1")];
  const xdr = {
    sheet: others,
    tax: [coin("axdr", "10")],
    taxBase: [coin("axdr", "1000")],
    spendable: rich("axdr", "anoah", "aeur", "akrw", "ausd"),
    gasLimit: 10n,
    headroom,
  };
  assert.deepEqual(affordableFeeDenoms({ ...xdr, sheet: [...others, price("anoah", "1")], reference }), ["axdr", "anoah", "aeur", "akrw", "ausd"]);
  // The ausd held covers the 1000 moved and its 10 tax and no gas, and no NOAH is held: of the two left, the reference is first, as arkd picks.
  assert.deepEqual(affordableFeeDenoms({ ...send, reference, spendable: [coin("ausd", "1010"), ...rich("axdr", "aeur")] }), ["axdr", "aeur"]);
});

test("affording a denomination means holding what the chain draws: the gas leg's ceiling, and a tax leg's tax, not its lift", () => {
  // A send of 1000 EUR taxed 5 EUR at arkd's headroom, by a payer holding exactly the two in EUR.
  const sheet = [price("aeur", "117000000000"), price("ausd", "137000000000"), price("anoah", "100000000000")];
  const eur = (amount: string) => coin("aeur", LegacyDec.fromString(amount).scaled);
  const send = { sheet, tax: [eur("5")], taxBase: [eur("1000")], gasLimit: 200000n, headroom: arkdPolicy.headroom };
  const others = [coin("ausd", 10n ** 18n), coin("anoah", 10n ** 18n)];

  // Gas in ausd lifts the EUR tax leg to 5.5, a ceiling the ante does not draw: the 1005 EUR held are enough, and
  // ausd is the denomination this payer needs to be offered. Gas in EUR needs EUR beyond the 1005.
  assert.deepEqual(affordableFeeDenoms({ ...send, spendable: [eur("1005"), ...others] }), ["anoah", "ausd"]);
  // Short of the tax itself, nothing is affordable: the transfer and its tax come out of EUR whatever pays the gas.
  assert.deepEqual(affordableFeeDenoms({ ...send, spendable: [eur("1004.9"), ...others] }), []);

  // The gas leg is still counted at its ceiling, tax and gas lifted together: 5.52574 EUR beside the 1000 moved.
  assert.deepEqual(affordableFeeDenoms({ ...send, spendable: [eur("1005.5")] }), [], "enough for today's gas price, short of the ceiling");
  assert.deepEqual(affordableFeeDenoms({ ...send, spendable: [eur("1005.52574")] }), ["aeur"]);

  // A NOAH leg is drawn whole, its lift included: 0.02 NOAH of gas lifted to 0.021.
  const noah = (amount: string) => coin("anoah", LegacyDec.fromString(amount).scaled);
  assert.deepEqual(affordableFeeDenoms({ ...send, spendable: [eur("1005"), noah("0.0209")] }), []);
  assert.deepEqual(affordableFeeDenoms({ ...send, spendable: [eur("1005"), noah("0.021")] }), ["anoah"]);
  // A tip beside a stable gas leg is NOAH drawn whole too.
  assert.deepEqual(affordableFeeDenoms({ ...send, tip: 10n ** 18n, spendable: [eur("1005"), coin("ausd", 10n ** 18n)] }), []);
  assert.deepEqual(affordableFeeDenoms({ ...send, tip: 10n ** 18n, spendable: [eur("1005"), coin("ausd", 10n ** 18n), noah("1")] }), ["ausd"]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Network } from "../registry/network.js";
import type { ArkJson, AssetListJson, ChainJson } from "../registry/types.js";
import { shortenAddress } from "./address.js";
import {
  AmountError,
  coinFromDisplay,
  coinsToString,
  formatAssetAmount,
  formatCoin,
  formatDecCoin,
  fromDisplayUnits,
  parseCoin,
  parseCoins,
  parseDecCoin,
  toDisplayUnits,
} from "./amount.js";

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../testdata/registry/arklocal/${file}`, import.meta.url), "utf8")) as T;
const network = Network.fromRegistry({ chain: read<ChainJson>("chain.json"), assets: read<AssetListJson>("assetlist.json"), ark: read<ArkJson>("ark.json") });
const usd = network.asset("ausd")!;

test("base and display units convert exactly both ways", () => {
  const cases: [string, number, string][] = [
    ["10000000000000000000", 18, "10"],
    ["75058351568198397", 18, "0.075058351568198397"],
    ["1", 18, "0.000000000000000001"],
    ["0", 18, "0"],
    ["-1500000000000000000", 18, "-1.5"],
    ["123", 0, "123"],
  ];
  for (const [base, exponent, display] of cases) {
    assert.equal(toDisplayUnits(base, exponent), display);
    assert.equal(fromDisplayUnits(display, exponent), BigInt(base));
  }
  assert.equal(fromDisplayUnits("10.50", 18), 10500000000000000000n);
  assert.throws(() => fromDisplayUnits("1.0000000000000000001", 18), AmountError);
  assert.throws(() => fromDisplayUnits("1e3", 18), AmountError);
  assert.throws(() => toDisplayUnits("1.5", 18), AmountError);
});

test("formatting follows the locale and rounds down by default", () => {
  assert.equal(formatAssetAmount("10000000000000000000", usd, { locale: "en-GB" }), "10 arkUSD");
  assert.equal(formatAssetAmount("1234567890123456789012", usd, { locale: "en-GB" }), "1,234.56789 arkUSD");
  assert.equal(formatAssetAmount("1234567890123456789012", usd, { locale: "de-DE", maximumFractionDigits: 2 }), "1.234,56 arkUSD");
  assert.equal(formatAssetAmount("1999999999999999999", usd, { locale: "en-GB", maximumFractionDigits: 2 }), "1.99 arkUSD", "truncated, not rounded up");
  assert.equal(formatAssetAmount("1999999999999999999", usd, { locale: "en-GB", maximumFractionDigits: 2, roundingMode: "halfExpand" }), "2 arkUSD");
  assert.equal(formatAssetAmount("5", usd, { locale: "en-GB", symbol: false, maximumFractionDigits: 18 }), "0.000000000000000005");
  assert.equal(formatCoin({ denom: "anoah", amount: "2000000000000000000000" }, network, { locale: "en-GB" }), "2,000 NOAH");
  assert.equal(formatCoin({ denom: "ausd-venue", amount: "7" }, network), "7ausd-venue", "an unlisted denomination is the chain's coin text");
});

test("coin text parses as the chain writes it", () => {
  assert.deepEqual(
    parseCoins("18234865061998542ausd,1anoah").map((c) => [c.denom, c.amount]),
    [
      ["ausd", "18234865061998542"],
      ["anoah", "1"],
    ],
  );
  assert.equal(parseCoin("7ausd-venue").denom, "ausd-venue");
  assert.deepEqual(parseCoins(""), []);
  assert.throws(() => parseCoin("ausd"), AmountError);
  assert.throws(() => parseCoin("1.5ausd"), AmountError);
  const c = coinFromDisplay("10.5", usd);
  assert.equal(c.denom, "ausd");
  assert.equal(c.amount, "10500000000000000000");
});

test("shortenAddress keeps the prefix and both ends", () => {
  assert.equal(shortenAddress("ark1fec7dnxl3fre9zmc3kyvtt357de3ek9fnlu96j"), "ark1fec7d…lu96j");
  // The separator is the last "1": the data part never contains one.
  assert.equal(shortenAddress("arkvaloper107sn6n6ylxxl6md3wtwy9n4u0j5a3azeu70grj", { head: 4, tail: 4 }), "arkvaloper107sn…0grj");
  assert.equal(shortenAddress("short"), "short");
});

test("coin lists, decimal coins, and their display", () => {
  assert.equal(
    coinsToString([
      { denom: "ausd", amount: "5" },
      { denom: "aeur", amount: 2n },
    ]),
    "2aeur,5ausd",
  );
  assert.equal(coinsToString([]), "");
  const fee = parseDecCoin("1234.5ausd");
  assert.equal(fee.denom, "ausd");
  assert.equal(fee.amount, "1234500000000000000000");
  assert.equal(
    formatDecCoin(fee, network, { locale: "en-GB", maximumFractionDigits: 18 }),
    "0.000000000000001234 arkUSD",
    "truncated at 18 places of the display unit",
  );
  assert.equal(
    formatDecCoin({ denom: "ausd", amount: LegacyDecWire("2500000000000000000.5") }, network, { locale: "en-GB", maximumFractionDigits: 6 }),
    "2.5 arkUSD",
  );
  assert.equal(formatDecCoin({ denom: "ausd-venue", amount: "1500000000000000000" }, network), "1.500000000000000000ausd-venue");
  assert.throws(() => parseDecCoin("1.5"), AmountError);
});

function LegacyDecWire(decimal: string): string {
  const [whole, frac = ""] = decimal.split(".");
  return `${whole}${frac.padEnd(18, "0")}`;
}

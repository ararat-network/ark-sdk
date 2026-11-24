import assert from "node:assert/strict";
import { test } from "node:test";

import { create, fromBinary } from "@bufbuild/protobuf";
import { MsgSendSchema } from "../gen/cosmos/bank/v1beta1/tx_pb.js";
import { CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { amounts } from "../testing/fixtures.js";
import { fromHex } from "./bytes.js";
import { CoinError, coin, coins, intFromWire, sumCoins } from "./coins.js";
import { goIntegerText } from "./fixed.js";

// A bank send from ark1from to ark1to of one ausd coin whose amount text is "0100". The chain's own app executes it
// and credits 64: it reads the text with the base taken from it, and a leading zero is octal.
const SEND_0100 = "0a0861726b3166726f6d120661726b31746f1a0c0a0461757364120430313030";

// What Go's big.Int.UnmarshalText reads from each text, null where it returns an error. Produced by running it
// (math/big, go1.27), not written by hand; the same function over 300,000 generated texts agreed with the port.
const GO_READS: [string, string | null][] = [
  ["0", "0"],
  ["00", "0"],
  ["-0", "0"],
  ["+0", "0"],
  ["7", "7"],
  ["007", "7"],
  ["0100", "64"],
  ["010", "8"],
  ["08", null],
  ["09", null],
  ["018", null],
  ["0_7", "7"],
  ["0_", null],
  ["_0", null],
  ["_1", null],
  ["1_", null],
  ["1_000", "1000"],
  ["1__0", null],
  ["1_0_0", "100"],
  ["0_1_0", "8"],
  ["00_7", "7"],
  ["0__7", null],
  ["+5", "5"],
  ["-5", "-5"],
  ["--5", null],
  ["+-5", null],
  ["+", null],
  ["-", null],
  ["0x10", "16"],
  ["0X10", "16"],
  ["0xff", "255"],
  ["0xFF", "255"],
  ["0xfg", null],
  ["0x", null],
  ["0x_1", "1"],
  ["0x__1", null],
  ["0x1_", null],
  ["0x_", null],
  ["0b11", "3"],
  ["0B101", "5"],
  ["0b_1_0", "2"],
  ["0b12", null],
  ["0b", null],
  ["0o17", "15"],
  ["0O17", "15"],
  ["0o18", null],
  ["0o", null],
  ["-0x10", "-16"],
  ["+0o17", "15"],
  ["-010", "-8"],
  ["1e3", null],
  ["1.5", null],
  [".5", null],
  ["5.", null],
  [" 5", null],
  ["5 ", null],
  ["5\n", null],
  ["abc", null],
  ["0a", null],
  ["1a", null],
  ["\u0661\u0662", null],
  ["5ausd", null],
  ["100", "100"],
  ["-1000000000000000000", "-1000000000000000000"],
  ["0100000000000000000", "2251799813685248"],
  ["03251232723641400000", "60000000000000000"],
];

test("integer text is read as the chain reads it: the base comes from the text", () => {
  for (const [text, value] of GO_READS) assert.equal(goIntegerText(text)?.toString() ?? null, value, JSON.stringify(text));
  assert.equal(goIntegerText(""), undefined);
  assert.equal(intFromWire("0100"), 64n);
  assert.equal(intFromWire("100"), 100n);
  assert.equal(intFromWire(""), 0n, "an Int with no bytes is zero");
  for (const text of ["08", "abc", "1.5", " 5"]) assert.throws(() => intFromWire(text), CoinError, text);
  // math.Int's bound, 256 bits either way.
  const max = 2n ** 256n - 1n;
  assert.equal(intFromWire(`0x${"f".repeat(64)}`), max);
  assert.equal(intFromWire(`-${max}`), -max);
  assert.throws(() => intFromWire((max + 1n).toString()), CoinError);
  assert.throws(() => intFromWire(`0x1${"0".repeat(64)}`), CoinError);
});

test("a coin carries only the text the chain writes: other text and a negative amount are refused, never normalised", () => {
  assert.equal(coin("ausd", "0").amount, "0");
  assert.equal(coin("ausd", "100").amount, "100");
  assert.equal(coin("ausd", 10n ** 18n).amount, "1000000000000000000");
  assert.equal(coin("ausd", 2n ** 256n - 1n).amount, (2n ** 256n - 1n).toString());
  // Each of these the chain would read as another number than its digits say, or refuse.
  for (const text of ["0100", "010", "007", "00", "08", "+5", "0x10", "1_000", " 5", "5 ", "1.0", "1e3", "", "-0", "-1"]) {
    assert.throws(() => coin("ausd", text), CoinError, JSON.stringify(text));
  }
  assert.throws(() => coin("ausd", -1n), CoinError);
  assert.throws(() => coin("ausd", 2n ** 256n), CoinError);
  assert.throws(() => coins([{ denom: "ausd", amount: "010" }]), CoinError);
});

test("sumCoins merges per denomination in denomination order and drops zero legs", () => {
  const out = sumCoins([coin("ausd", "5"), coin("anoah", "0")], [coin("ausd", "1"), coin("aeur", "2")]);
  assert.deepEqual(amounts(out), ["2aeur", "6ausd"]);
  assert.throws(() => sumCoins([create(CoinSchema, { denom: "ausd", amount: "-1" })]), CoinError);
});

test("sumCoins reads a decoded coin's amount as the chain does, not as its decimal digits", () => {
  const sent = fromBinary(MsgSendSchema, fromHex(SEND_0100));
  assert.equal(sent.amount[0]?.amount, "0100", "the message holds the text its sender wrote");
  assert.deepEqual(amounts(sumCoins(sent.amount)), ["64ausd"]);
  assert.deepEqual(amounts(sumCoins(sent.amount, [coin("ausd", 36n)])), ["100ausd"]);
  assert.throws(() => sumCoins([create(CoinSchema, { denom: "ausd", amount: "08" })]), CoinError, "text the chain refuses");
});

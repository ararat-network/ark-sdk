// sdk.Coin values: amounts in base units as decimal text, built from a bigint
// or a string, and summed the way sdk.Coins holds them. The chain does not
// read an amount's text as decimal: the base is taken from the text, so a
// leading zero makes it octal. A coin built here therefore carries only the
// text the chain itself writes, and one read from a message is read through
// intFromWire, as the chain reads it.
import { create } from "@bufbuild/protobuf";
import { ArkSdkError } from "../errors.js";
import { type Coin, CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { CANONICAL_INTEGER_TEXT, goIntegerText } from "./fixed.js";

export class CoinError extends ArkSdkError {
  override readonly name: string = "CoinError";
}

export interface CoinInput {
  denom: string;
  amount: bigint | string;
}

/** math.Int's bound: the chain refuses an integer of more than 256 bits. */
const MAX_INT = 2n ** 256n - 1n;

/**
 * The integer a math.Int's text holds, as the chain reads it; empty reads as
 * zero. A coin's amount in a decoded message is the text its sender wrote, and
 * the chain takes the base from the text: "0100" is 64, "0x10" is 16. Reading
 * it with BigInt gives another number than the chain moved. Text the chain
 * refuses is refused here.
 */
export function intFromWire(text: string): bigint {
  if (text === "") return 0n;
  const value = goIntegerText(text);
  if (value === undefined) throw new CoinError(`not an integer as the chain reads one: ${JSON.stringify(text)}`);
  if (value > MAX_INT || value < -MAX_INT) throw new CoinError(`integer out of range: ${text}`);
  return value;
}

/**
 * A coin. The amount is not negative, and as text it is the integer the way
 * the chain writes it: decimal digits with no leading zero. Other text is
 * refused, never normalised: the chain would read "0100" as 64, and a caller
 * who wrote it meant something else.
 */
export function coin(denom: string, amount: bigint | string): Coin {
  if (typeof amount === "string" && !CANONICAL_INTEGER_TEXT.test(amount)) {
    throw new CoinError(`amount ${JSON.stringify(amount)} of ${denom} is not an integer in decimal digits with no leading zero`);
  }
  const value = BigInt(amount);
  if (value < 0n) throw new CoinError(`negative amount ${value}${denom}`);
  if (value > MAX_INT) throw new CoinError(`amount of ${denom} out of range: ${value}`);
  return create(CoinSchema, { denom, amount: value.toString() });
}

export function coins(inputs: readonly CoinInput[]): Coin[] {
  return inputs.map((c) => coin(c.denom, c.amount));
}

/** Sums coins per denomination in denomination order, dropping zero legs: sdk.Coins. Each amount is read as the chain reads it. */
export function sumCoins(...lists: readonly (readonly Coin[])[]): Coin[] {
  const byDenom = new Map<string, bigint>();
  for (const list of lists) {
    for (const c of list) {
      const amount = intFromWire(c.amount);
      if (amount < 0n) throw new CoinError(`negative amount ${c.amount}${c.denom}`);
      byDenom.set(c.denom, (byDenom.get(c.denom) ?? 0n) + amount);
    }
  }
  return [...byDenom.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([denom, amount]) => coin(denom, amount));
}

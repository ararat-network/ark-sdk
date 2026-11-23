// sdk.Coin values: amounts in base units as decimal text, built from a bigint
// or a string, and summed the way sdk.Coins holds them.
import { create } from "@bufbuild/protobuf";

import { type Coin, CoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";

export class CoinError extends Error {
  override readonly name: string = "CoinError";
}

export interface CoinInput {
  denom: string;
  amount: bigint | string;
}

export function coin(denom: string, amount: bigint | string): Coin {
  return create(CoinSchema, { denom, amount: amount.toString() });
}

export function coins(inputs: readonly CoinInput[]): Coin[] {
  return inputs.map((c) => coin(c.denom, c.amount));
}

/** Sums coins per denomination in denomination order, dropping zero legs: sdk.Coins. */
export function sumCoins(...lists: readonly (readonly Coin[])[]): Coin[] {
  const byDenom = new Map<string, bigint>();
  for (const list of lists) {
    for (const c of list) {
      const amount = BigInt(c.amount);
      if (amount < 0n) throw new CoinError(`negative amount ${c.amount}${c.denom}`);
      byDenom.set(c.denom, (byDenom.get(c.denom) ?? 0n) + amount);
    }
  }
  return [...byDenom.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([denom, amount]) => coin(denom, amount));
}

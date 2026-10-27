// The fee contract (docs/clients/CLIENT_FEES.md) as arithmetic over what the
// chain publishes. The chain says what is true: the tax the messages owe and
// the gas price sheet. The client says what is prudent: the gas adjustment,
// the headroom on each leg, and the denomination. Nothing here applies a
// headroom the caller did not pass; arkd's numbers are exported for a caller
// that wants them. The declaration is a ceiling: a stable leg's slack stays
// with the payer, a NOAH leg is charged whole and its excess is the tip. The
// ante takes the base fee from a stable leg's slack before it lets NOAH pay,
// so beside a NOAH gas leg the tax legs are declared exact, with no slack.
import { LegacyDec } from "../codec/dec.js";
import type { GasPrice } from "../gen/ark/treasury/v1/treasury_pb.js";
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import { coin } from "./body.js";

/** The denomination charged whole, never taxed, whose excess is the tip. */
export const NOAH_DENOM = "anoah";

export interface Headroom {
  /** Multiplier on every stable leg when a stable leg carries the gas; the slack costs nothing. */
  stable: string;
  /** Multiplier on a NOAH gas leg; the excess is paid as tip. */
  noah: string;
}

/** arkd's choices, documented as CLI policy and not protocol: pass them if they suit you. */
export const arkdPolicy = {
  headroom: { stable: "1.1", noah: "1.05" } as Headroom,
  gasAdjustment: 1.15,
} as const;

export class FeeError extends Error {
  override readonly name: string = "FeeError";
}

/** The gas leg one denomination requires: ceil(gas_price × gas_limit), in base units. */
export function requiredGasFee(gasPrice: GasPrice, gasLimit: bigint): Coin {
  if (gasLimit <= 0n) throw new FeeError("gas limit must be positive");
  return coin(gasPrice.denom, LegacyDec.fromWire(gasPrice.gasPrice).mulInt(gasLimit).ceil());
}

/** A headroom multiplier as a decimal, refused below 1. */
function multiplier(headroom: string): LegacyDec {
  const m = LegacyDec.fromString(headroom);
  if (m.compare(LegacyDec.one()) < 0) throw new FeeError(`headroom ${headroom} is below 1`);
  return m;
}

/** ceil(amount × multiplier). */
export function liftLeg(leg: Coin, headroom: string): Coin {
  return coin(leg.denom, LegacyDec.fromInt(BigInt(leg.amount)).mul(multiplier(headroom)).ceil());
}

/** Sums coins per denomination in denomination order, dropping zero legs: sdk.Coins. */
export function sumCoins(...lists: readonly (readonly Coin[])[]): Coin[] {
  const byDenom = new Map<string, bigint>();
  for (const list of lists) {
    for (const c of list) {
      const amount = BigInt(c.amount);
      if (amount < 0n) throw new FeeError(`negative amount ${c.amount}${c.denom}`);
      byDenom.set(c.denom, (byDenom.get(c.denom) ?? 0n) + amount);
    }
  }
  return [...byDenom.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([denom, amount]) => coin(denom, amount));
}

export interface FeeQuoteInput {
  /** The transfer tax the exact messages owe, from Treasury's ComputeTax. */
  tax: readonly Coin[];
  /** The gas price of the denomination that pays the base fee, from the sheet. */
  gasPrice: GasPrice;
  gasLimit: bigint;
  /** Explicit, never defaulted: the client's judgement of price movement before inclusion; both refused below 1. */
  headroom: Headroom;
  /** A tip in NOAH base units: its own leg beside a stable gas leg, part of the NOAH leg when NOAH carries the gas. */
  tip?: bigint;
  nativeDenom?: string;
  /** Denominations first in the declaration, so the ante tries them first for the base fee; the rest follow in denomination order. */
  legOrder?: readonly string[];
}

export interface FeeQuote {
  gasLimit: bigint;
  tax: Coin[];
  gasPrice: GasPrice;
  /** The gas leg before headroom. */
  required: Coin;
  /** What is declared: with a stable gas leg, tax plus the gas leg, each lifted, then any tip; with a NOAH gas leg, the tax exact beside the lifted leg plus the tip. */
  declared: Coin[];
  headroom: Headroom;
  /** What NOAH will charge as tip, exact: the tip given, plus a NOAH gas leg's lift; undefined when there is neither. */
  tip: Coin | undefined;
  /** The block whose rates priced the gas leg; zero for the reference denomination. */
  derivedHeight: bigint;
}

/**
 * Prices one transaction per the fee contract. With a stable gas leg,
 * declared = lift(tax + required) and every lift is free. With a NOAH gas
 * leg, declared = tax + lift(required): a tax leg with slack would pay the
 * base fee itself and leave the whole NOAH leg as tip, so the tax legs carry
 * none, and a tax that rises before inclusion refuses the transaction for a
 * new quote rather than being absorbed. A tip is NOAH on top: its own leg
 * beside a stable gas leg, part of the NOAH leg when NOAH carries the gas.
 */
export function quoteFee(input: FeeQuoteInput): FeeQuote {
  const native = input.nativeDenom ?? NOAH_DENOM;
  multiplier(input.headroom.stable);
  multiplier(input.headroom.noah);
  const tipAmount = input.tip ?? 0n;
  if (tipAmount < 0n) throw new FeeError(`tip ${tipAmount} is negative`);
  const required = requiredGasFee(input.gasPrice, input.gasLimit);
  const noahPays = required.denom === native;
  const legs = sumCoins(input.tax, [required]);
  let declared = legs.map((leg) => {
    if (leg.denom === native) return coin(native, BigInt(liftLeg(leg, input.headroom.noah).amount) + tipAmount);
    return noahPays ? leg : liftLeg(leg, input.headroom.stable);
  });
  if (input.legOrder) {
    const order = input.legOrder;
    declared = [...declared].sort((a, b) => rank(order, a.denom) - rank(order, b.denom));
  }
  // The ante skips NOAH when it picks the paying leg, so a tip leg's place
  // changes nothing; it goes last, after the legs that can pay.
  if (!noahPays && tipAmount > 0n) declared = [...declared, coin(native, tipAmount)];
  const noah = declared.find((c) => c.denom === native);
  const tip = noah ? coin(native, BigInt(noah.amount) - (noahPays ? BigInt(required.amount) : 0n)) : undefined;
  return {
    gasLimit: input.gasLimit,
    tax: [...input.tax],
    gasPrice: input.gasPrice,
    required,
    declared,
    headroom: input.headroom,
    tip,
    derivedHeight: input.gasPrice.derivedHeight,
  };
}

function rank(order: readonly string[], denom: string): number {
  const i = order.indexOf(denom);
  return i < 0 ? order.length : i;
}

/** Gas for the limit: ceil(simulated × adjustment); the adjustment is the caller's. */
export function adjustGas(gasUsed: bigint, adjustment: number): bigint {
  if (!(adjustment >= 1)) throw new FeeError(`gas adjustment ${adjustment} is below 1`);
  return LegacyDec.fromInt(gasUsed)
    .mul(LegacyDec.fromString(adjustment.toFixed(6)))
    .ceil();
}

export interface FeeDenomChoiceInput {
  /** The sheet's non-reference rows. */
  sheet: readonly GasPrice[];
  tax: readonly Coin[];
  /** The principal the tax was computed over: what the messages already move. */
  taxBase: readonly Coin[];
  spendable: readonly Coin[];
  gasLimit: bigint;
  headroom: Headroom;
  tip?: bigint;
  nativeDenom?: string;
}

/**
 * Denominations whose spendable balance covers a declaration priced in them,
 * net of the principal the messages move, in arkd's preference order: the
 * denominations in the tax base, then NOAH, then the rest of the sheet. A
 * convenience for a payer who has not said which to pay in; the chain is the
 * arbiter either way.
 */
export function affordableFeeDenoms(input: FeeDenomChoiceInput): string[] {
  const native = input.nativeDenom ?? NOAH_DENOM;
  const preferred = [...new Set([...input.taxBase.map((c) => c.denom), native])];
  const ordered = [...input.sheet].sort((a, b) => rank(preferred, a.denom) - rank(preferred, b.denom));
  const out: string[] = [];
  for (const price of ordered) {
    const quote = quoteFee({ tax: input.tax, gasPrice: price, gasLimit: input.gasLimit, headroom: input.headroom, tip: input.tip, nativeDenom: native });
    const needed = sumCoins(quote.declared, input.taxBase);
    const covered = needed.every((n) => BigInt(input.spendable.find((s) => s.denom === n.denom)?.amount ?? "0") >= BigInt(n.amount));
    if (covered) out.push(price.denom);
  }
  return out;
}

// The fee contract (docs/clients/CLIENT_FEES.md) as arithmetic over what the
// chain publishes. The chain says what is true: the tax the messages owe and
// the gas price sheet. The client says what is prudent: the gas adjustment,
// the headroom on each leg, and the denomination. Nothing here applies a
// headroom the caller did not pass; arkd's numbers are exported for a caller
// that wants them. The declaration is a ceiling: a stable leg's slack stays
// with the payer, a NOAH leg is charged whole and its excess is the tip. The
// ante takes the base fee from a stable leg's slack before it lets NOAH pay,
// so beside a NOAH gas leg the tax legs are declared exact, with no slack.
// Among stable legs it charges the first, in the order they are encoded,
// whose slack covers the base fee, and a lifted tax leg has slack: the gas
// leg's denomination is therefore encoded first, so that it is the one that pays.
import { coin, intFromWire, sumCoins } from "../codec/coins.js";
import { LegacyDec } from "../codec/dec.js";
import { ArkSdkError } from "../errors.js";
import type { GasPrice } from "../gen/ark/treasury/v1/treasury_pb.js";
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";

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

export class FeeError extends ArkSdkError {
  override readonly name: string = "FeeError";
}

/** The fee denomination a flow was given, refused when empty: none is chosen for the caller. Internal: not exported from the core entry. */
export function requireFeeDenom(feeDenom: string): string {
  if (!feeDenom) throw new FeeError("no fee denomination: feeDenom names the one that pays the base fee, and none is chosen for you");
  return feeDenom;
}

/** A tip in NOAH base units, zero when none is given; a negative one is refused. Internal: not exported from the core entry. */
export function checkedTip(tip: bigint | undefined): bigint {
  const amount = tip ?? 0n;
  if (amount < 0n) throw new FeeError(`tip ${amount} is negative`);
  return amount;
}

/**
 * The rows that price gas, one to a denomination: the sheet's, and the reference row standing for its own. The chain
 * lists the reference apart from the sheet; given both under one name, the reference row is the one that prices, as
 * arkd has it.
 */
function priceRows(sheet: readonly GasPrice[], reference: GasPrice | undefined): GasPrice[] {
  return reference ? [...sheet.filter((row) => row.denom !== reference.denom), reference] : [...sheet];
}

/** The row of the gas price sheet that prices a fee denomination; one the chain does not accept is refused. Internal: not exported from the core entry. */
export function gasPriceFor(sheet: { gasPrices: readonly GasPrice[]; referenceGasPrice?: GasPrice | undefined }, feeDenom: string): GasPrice {
  const price = priceRows(sheet.gasPrices, sheet.referenceGasPrice).find((row) => row.denom === feeDenom);
  if (!price) throw new FeeError(`${feeDenom} is not on the gas price sheet; the chain does not accept it for the base fee`);
  return price;
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
  return coin(leg.denom, LegacyDec.fromInt(intFromWire(leg.amount)).mul(multiplier(headroom)).ceil());
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
  /**
   * Denominations first in the declaration, so the ante tries them first for the base fee; the rest follow in
   * denomination order. Left out, a stable gas leg's denomination goes first: in denomination order a tax leg that
   * sorts before it would pay the base fee from its lift, in the denomination the caller did not choose and may
   * hold none to spare of. An empty list is denomination order, as arkd encodes it.
   */
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
 * A stable gas leg is encoded first unless the caller orders the legs, so the
 * ante reaches it before a tax leg's lift. If its price rises past the
 * headroom before inclusion the ante passes over it, and a tax leg's lift
 * may then pay: the headroom is what bounds that.
 */
export function quoteFee(input: FeeQuoteInput): FeeQuote {
  const native = input.nativeDenom ?? NOAH_DENOM;
  multiplier(input.headroom.stable);
  multiplier(input.headroom.noah);
  const tipAmount = checkedTip(input.tip);
  const required = requiredGasFee(input.gasPrice, input.gasLimit);
  const noahPays = required.denom === native;
  const legs = sumCoins(input.tax, [required]);
  let declared = legs.map((leg) => {
    if (leg.denom === native) return coin(native, intFromWire(liftLeg(leg, input.headroom.noah).amount) + tipAmount);
    return noahPays ? leg : liftLeg(leg, input.headroom.stable);
  });
  // The ante charges the first stable leg, in encoded order, whose slack covers the base fee. The sort is stable,
  // so what the order does not name stays in denomination order. Beside a NOAH gas leg no stable leg has slack and
  // the order decides nothing, so it is left as it is.
  const order = input.legOrder ?? (noahPays ? [] : [required.denom]);
  declared = [...declared].sort((a, b) => rank(order, a.denom) - rank(order, b.denom));
  // The ante skips NOAH when it picks the paying leg, so a tip leg's place
  // changes nothing; it goes last, after the legs that can pay.
  if (!noahPays && tipAmount > 0n) declared = [...declared, coin(native, tipAmount)];
  const noah = declared.find((c) => c.denom === native);
  const tip = noah ? coin(native, intFromWire(noah.amount) - (noahPays ? intFromWire(required.amount) : 0n)) : undefined;
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

/** Gas for the limit: ceil(simulated × adjustment); the adjustment is the caller's, read to six decimal places. */
export function adjustGas(gasUsed: bigint, adjustment: number): bigint {
  if (!(adjustment >= 1)) throw new FeeError(`gas adjustment ${adjustment} is below 1`);
  return LegacyDec.fromInt(gasUsed)
    .mul(LegacyDec.fromString(adjustment.toFixed(6)))
    .ceil();
}

export interface FeeDenomChoiceInput {
  /** The sheet's non-reference rows. */
  sheet: readonly GasPrice[];
  /** The sheet's reference row, to have the reference denomination offered too; arkd ranks it after NOAH. */
  reference?: GasPrice;
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
 * denominations in the tax base, then NOAH, then the reference when its row
 * is given, then the rest of the sheet as it lists them. A convenience for a
 * payer who has not said which to pay in; the chain is the arbiter either way.
 *
 * Covering means holding what the chain draws. The NOAH leg is drawn whole.
 * The gas leg is counted at its ceiling, as arkd counts it, since its price
 * moves every block. A tax leg beside a stable gas leg is counted at the tax
 * itself: the ante draws no more unless the tax rises, and counting its lift
 * would rule out a payer who holds exactly the principal and its tax, the one
 * with most reason to pay gas in another denomination.
 */
export function affordableFeeDenoms(input: FeeDenomChoiceInput): string[] {
  const native = input.nativeDenom ?? NOAH_DENOM;
  const reference = input.reference;
  const rows = priceRows(input.sheet, reference);
  const preferred = [...new Set([...input.taxBase.map((c) => c.denom), native, ...(reference ? [reference.denom] : [])])];
  const ordered = rows.sort((a, b) => rank(preferred, a.denom) - rank(preferred, b.denom));
  const taxed = sumCoins(input.tax);
  const out: string[] = [];
  for (const price of ordered) {
    const quote = quoteFee({ tax: input.tax, gasPrice: price, gasLimit: input.gasLimit, headroom: input.headroom, tip: input.tip, nativeDenom: native });
    const drawn = quote.declared.map((leg) => (leg.denom === native || leg.denom === price.denom ? leg : (taxed.find((t) => t.denom === leg.denom) ?? leg)));
    const needed = sumCoins(drawn, input.taxBase);
    const covered = needed.every((n) => intFromWire(input.spendable.find((s) => s.denom === n.denom)?.amount ?? "0") >= intFromWire(n.amount));
    if (covered) out.push(price.denom);
  }
  return out;
}

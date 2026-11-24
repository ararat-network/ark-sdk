// The largest amount of one denomination a payer can send. A transfer owes a
// tax in the denomination it moves, a share of the amount under a cap, and the
// gas may be paid from the same balance or from another. Sending a whole
// balance therefore means solving for the amount: the amount, its tax, and
// whatever else the chain draws from that balance must fit in it. The tax is
// the chain's to say, so it is asked for, never recomputed here: the answer
// returned is one the chain's own tax was read for, and one base unit more was
// read not to fit.
import { intFromWire } from "../codec/coins.js";
import type { QueryClient } from "../query/client.js";
import { packMessages, type TxMessage } from "./body.js";
import { checkedTip, FeeError, type FeeQuoteInput, gasPriceFor, liftLeg, NOAH_DENOM, requiredGasFee, requireFeeDenom } from "./fee.js";

export interface MaxSendableInput extends Pick<FeeQuoteInput, "headroom" | "nativeDenom"> {
  /** The treasury's client: a QueryClient, or treasuryClient over a gateway. */
  client: Pick<QueryClient, "treasury">;
  /** The denomination being sent. */
  denom: string;
  /** The payer's spendable balance of it, in base units. */
  spendable: bigint;
  /**
   * The messages that move `amount` of the denomination out of the payer's balance, as they will be signed. The
   * chain prices the tax on these, so whatever it taxes or exempts is counted as it will be.
   */
  messages: (amount: bigint) => readonly TxMessage[];
  /** The denomination that pays the base fee, as prepareAndSign takes it. Only a gas leg in `denom` comes out of this balance. */
  feeDenom: string;
  /** The gas limit the transaction will declare: simulate with any amount that fits, and adjust. */
  gasLimit: bigint;
  /** A tip in NOAH base units; it comes out of this balance only when NOAH is what is being sent. */
  tip?: bigint;
}

export interface MaxSendable {
  /** The largest amount that fits, in base units; zero when nothing can be sent. */
  amount: bigint;
  /** The tax the chain computes for that amount, in the same denomination. */
  tax: bigint;
  /**
   * What is kept back from the balance beside the amount and its tax: the gas leg at its ceiling when the gas is
   * paid in this denomination, since its price can rise before inclusion, and a tip when NOAH is being sent.
   */
  reserved: bigint;
  /** How many times the chain was asked for a tax. */
  taxQueries: number;
}

/**
 * The largest amount such that the amount, the tax the chain computes for it,
 * and the reserve fit in the balance. The tax is counted as it is, with no
 * lift: it is a share of the amount, exact for the amount sent. Nothing is
 * signed or sent.
 *
 * The search relies on one property of the chain's tax: it never falls as the
 * amount rises, being a truncated share under a cap. A handful of tax queries
 * settle it for a rate and a cap; a tax that broke the property is refused.
 */
export async function maxSendable(input: MaxSendableInput): Promise<MaxSendable> {
  const native = input.nativeDenom ?? NOAH_DENOM;
  const tip = checkedTip(input.tip);
  if (input.spendable < 0n) throw new FeeError(`spendable balance ${input.spendable} is negative`);
  const feeDenom = requireFeeDenom(input.feeDenom);

  // A NOAH leg is drawn whole, so a tip leaves a NOAH balance in full.
  let reserved = input.denom === native ? tip : 0n;
  if (feeDenom === input.denom) {
    const price = gasPriceFor(await input.client.treasury.gasPrices(), feeDenom);
    const lift = input.denom === native ? input.headroom.noah : input.headroom.stable;
    reserved += intFromWire(liftLeg(requiredGasFee(price, input.gasLimit), lift).amount);
  }

  let taxQueries = 0;
  const taxOn = async (amount: bigint): Promise<bigint> => {
    taxQueries++;
    const { tax } = await input.client.treasury.computeTax(packMessages(input.messages(amount)));
    return tax.filter((c) => c.denom === input.denom).reduce((sum, c) => sum + intFromWire(c.amount), 0n);
  };
  const settled = (amount: bigint, tax: bigint): MaxSendable => ({ amount, tax, reserved, taxQueries });

  const available = input.spendable - reserved;
  if (available <= 0n) return settled(0n, 0n);

  // All of it, when sending all of it owes nothing: an untaxed denomination, or a rate of zero.
  const taxOnAll = await taxOn(available);
  if (taxOnAll === 0n) return settled(available, 0n);

  // The answer lies between an amount that fits and one that does not. `available` does not, by its tax. Less its
  // own tax it does, since a smaller amount owes no more.
  let fits = available - taxOnAll;
  if (fits <= 0n) return settled(0n, 0n);
  let fitsTax = await taxOn(fits);
  let under = available - fits - fitsTax;
  if (under < 0n)
    throw new FeeError(
      `the tax on ${fits}${input.denom} is more than on ${available}${input.denom}: the search needs a tax that does not fall as the amount rises`,
    );
  let exceeds = available;
  let over = taxOnAll;

  // The amount plus its tax is close to a straight line in the amount, so where the line between the two ends
  // crosses the balance is nearly the answer, and a step or two lands on it. A range that fails to halve twice
  // running is halved outright, which bounds the search whatever the tax's shape.
  let stalled = 0;
  while (exceeds - fits > 1n) {
    const range = exceeds - fits;
    let guess = stalled >= 2 ? fits + range / 2n : fits + (under * range) / (under + over);
    if (guess <= fits) guess = fits + 1n;
    if (guess >= exceeds) guess = exceeds - 1n;
    const tax = await taxOn(guess);
    const excess = guess + tax - available;
    if (excess <= 0n) {
      fits = guess;
      fitsTax = tax;
      under = -excess;
    } else {
      exceeds = guess;
      over = excess;
    }
    stalled = stalled >= 2 || (exceeds - fits) * 2n <= range ? 0 : stalled + 1;
  }
  return settled(fits, fitsTax);
}

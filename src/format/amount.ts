// Amounts in display units. The chain holds base units as integers; the
// registry says how many make one display unit. Conversion is exact over
// bigint, and only the final rendering rounds, by the reader's locale, down
// by default so a balance never shows more than it is.
import { create } from "@bufbuild/protobuf";

import { stripTrailing } from "../codec/bytes.js";
import { coin, intFromWire } from "../codec/coins.js";
import { LegacyDec } from "../codec/dec.js";
import { decimalParts, fixedPointText, INTEGER_TEXT, scaleDecimal } from "../codec/fixed.js";
import { ArkSdkError } from "../errors.js";
import { type Coin, type DecCoin, DecCoinSchema } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import type { Asset, Network } from "../registry/network.js";

export class AmountError extends ArkSdkError {
  override readonly name: string = "AmountError";
}

/** Base units to an exact decimal in display units, trailing zeros dropped. */
export function toDisplayUnits(base: bigint | string, exponent: number): string {
  if (typeof base === "string" && !INTEGER_TEXT.test(base)) throw new AmountError(`not an integer amount: ${base}`);
  const value = BigInt(base);
  if (exponent === 0) return value.toString();
  // The zeros go first, and stop at the point; the point goes only when nothing is left after it.
  return stripTrailing(stripTrailing(fixedPointText(value, exponent), "0"), ".");
}

/** A decimal in display units to base units; refuses more places than the exponent allows. */
export function fromDisplayUnits(text: string, exponent: number): bigint {
  const parts = decimalParts(text.trim());
  if (!parts) throw new AmountError(`not a decimal amount: ${text}`);
  if (parts.fraction.length > exponent) throw new AmountError(`${text} has more than ${exponent} decimal places`);
  return scaleDecimal(parts, exponent);
}

export interface FormatOptions {
  /** BCP 47 tag; the runtime's default locale when omitted. */
  locale?: string;
  /** Most fractional digits shown; 6 by default, 20 at most, and never fewer than the least asked for. */
  maximumFractionDigits?: number;
  /** Fewest fractional digits shown, padded with zeros; none by default, 20 at most. */
  minimumFractionDigits?: number;
  /** Rounding of the dropped places; down by default. */
  roundingMode?: "trunc" | "halfExpand" | "ceil" | "floor";
  /** Append the asset's symbol; on by default. */
  symbol?: boolean;
}

/** Formats base units of an asset in its display unit for a locale. */
export function formatAssetAmount(base: bigint | string, asset: Asset, options: FormatOptions = {}): string {
  return formatDecimal(toDisplayUnits(base, asset.exponent), asset, options);
}

function formatDecimal(decimal: string, asset: Asset, options: FormatOptions): string {
  const minimum = Math.min(options.minimumFractionDigits ?? 0, 20);
  const formatter = new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: minimum,
    // The formatter refuses a most below the least: asking for more places than the default most raises the most.
    maximumFractionDigits: Math.max(minimum, Math.min(options.maximumFractionDigits ?? 6, 20)),
    roundingMode: options.roundingMode ?? "trunc",
  });
  // A numeric string is formatted exactly, where a number would round it to a float first.
  const number = formatter.format(decimal as `${number}`);
  return options.symbol === false ? number : `${number} ${asset.symbol}`;
}

/** Formats a coin through the network's asset list; an unlisted denomination is shown as the chain's coin text, in base units. */
export function formatCoin(c: { denom: string; amount: string | bigint }, network: Network, options: FormatOptions = {}): string {
  const asset = network.asset(c.denom);
  // A coin's text is read as the chain reads it, which is not always its decimal value.
  const amount = typeof c.amount === "string" ? intFromWire(c.amount) : c.amount;
  if (!asset) return `${amount}${c.denom}`;
  return formatAssetAmount(amount, asset, options);
}

const COIN = /^(0|[1-9]\d*)([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/;

/** Parses the chain's coin text, such as "1000000000000000000ausd"; the amount as the chain writes it, with no leading zero. */
export function parseCoin(text: string): Coin {
  const m = COIN.exec(text.trim());
  if (!m) throw new AmountError(`not a coin: ${text}`);
  return coin(m[2] as string, m[1] as string);
}

/** Parses a comma-separated coin list, as events carry amounts. */
export function parseCoins(text: string): Coin[] {
  if (text.trim() === "") return [];
  return text.split(",").map(parseCoin);
}

/** The chain's text for a coin list: amounts and denominations in denomination order, comma-separated. */
export function coinsToString(coins: readonly { denom: string; amount: string | bigint }[]): string {
  return [...coins]
    .sort((a, b) => (a.denom < b.denom ? -1 : a.denom > b.denom ? 1 : 0))
    .map((c) => `${typeof c.amount === "string" ? intFromWire(c.amount) : c.amount}${c.denom}`)
    .join(",");
}

const DEC_COIN = /^(\d+(?:\.\d{1,18})?)([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/;

/** Parses decimal coin text such as "1.5ausd", a DecCoin in base units with its amount in wire form. */
export function parseDecCoin(text: string): DecCoin {
  const m = DEC_COIN.exec(text.trim());
  if (!m) throw new AmountError(`not a decimal coin: ${text}`);
  return create(DecCoinSchema, { denom: m[2] as string, amount: LegacyDec.fromString(m[1] as string).toWire() });
}

/** Formats a DecCoin, whose amount is a decimal of base units, in the asset's display unit. */
export function formatDecCoin(c: { denom: string; amount: string }, network: Network, options: FormatOptions = {}): string {
  const asset = network.asset(c.denom);
  const dec = LegacyDec.fromWire(c.amount);
  if (!asset) return `${dec.toString()}${c.denom}`;
  // The wire form is base units × 10^18; display units are base units ÷ 10^exponent.
  return formatDecimal(toDisplayUnits(dec.scaled, 18 + asset.exponent), asset, options);
}

/** Display units of an asset to a coin in its base denomination. */
export function coinFromDisplay(text: string, asset: Asset): Coin {
  return coin(asset.base, fromDisplayUnits(text, asset.exponent));
}

// Amounts in display units. The chain holds base units as integers; the
// registry says how many make one display unit. Conversion is exact over
// bigint, and only the final rendering rounds, by the reader's locale, down
// by default so a balance never shows more than it is.
import type { Coin } from "../gen/cosmos/base/v1beta1/coin_pb.js";
import type { Asset, Network } from "../registry/network.js";
import { coin } from "../tx/body.js";

export class AmountError extends Error {
  override readonly name: string = "AmountError";
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Base units to an exact decimal in display units, trailing zeros dropped. */
export function toDisplayUnits(base: bigint | string, exponent: number): string {
  if (typeof base === "string" && !INTEGER.test(base)) throw new AmountError(`not an integer amount: ${base}`);
  const value = BigInt(base);
  if (exponent === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, "0");
  const point = digits.length - exponent;
  const fraction = digits.slice(point).replace(/0+$/, "");
  return (negative ? "-" : "") + digits.slice(0, point) + (fraction === "" ? "" : "." + fraction);
}

/** A decimal in display units to base units; refuses more places than the exponent allows. */
export function fromDisplayUnits(text: string, exponent: number): bigint {
  const m = DECIMAL.exec(text.trim());
  if (!m) throw new AmountError(`not a decimal amount: ${text}`);
  const fraction = m[3] ?? "";
  if (fraction.length > exponent) throw new AmountError(`${text} has more than ${exponent} decimal places`);
  const scaled = BigInt(m[2] as string) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, "0") || "0");
  return m[1] === "-" ? -scaled : scaled;
}

export interface FormatOptions {
  /** BCP 47 tag; the runtime's default locale when omitted. */
  locale?: string;
  /** Most fractional digits shown; 6 by default, the exponent at most. */
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  /** Rounding of the dropped places; down by default. */
  roundingMode?: "trunc" | "halfExpand" | "ceil" | "floor";
  /** Append the asset's symbol; on by default. */
  symbol?: boolean;
}

/** Formats base units of an asset in its display unit for a locale. */
export function formatAssetAmount(base: bigint | string, asset: Asset, options: FormatOptions = {}): string {
  const exponent = asset.exponent;
  const decimal = toDisplayUnits(base, exponent);
  const formatter = new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
    maximumFractionDigits: Math.min(options.maximumFractionDigits ?? 6, exponent, 20),
    roundingMode: options.roundingMode ?? "trunc",
  });
  const number = formatter.format(decimal as unknown as number);
  return options.symbol === false ? number : `${number} ${asset.symbol}`;
}

/** Formats a coin through the network's asset list; an unlisted denomination is shown in base units as is. */
export function formatCoin(c: { denom: string; amount: string | bigint }, network: Network, options: FormatOptions = {}): string {
  const asset = network.asset(c.denom);
  if (!asset) return `${c.amount.toString()} ${c.denom}`;
  return formatAssetAmount(c.amount, asset, options);
}

const COIN = /^(\d+)([a-zA-Z][a-zA-Z0-9/:._-]{2,127})$/;

/** Parses the chain's coin text, such as "1000000000000000000ausd". */
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

/** Display units of an asset to a coin in its base denomination. */
export function coinFromDisplay(text: string, asset: Asset): Coin {
  return coin(asset.base, fromDisplayUnits(text, asset.exponent));
}

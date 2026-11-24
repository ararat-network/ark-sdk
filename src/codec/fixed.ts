// Fixed-point decimal text and the scaled integer behind it: the one
// conversion LegacyDec's 18 places and an asset's display units share. Each
// caller keeps its own bound on the places and its own error. Internal: not
// re-exported from the package's index.

/** An integer in decimal text, with an optional sign. */
export const INTEGER_TEXT = /^-?\d+$/;

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

export interface DecimalParts {
  negative: boolean;
  whole: string;
  /** The digits after the point; empty when there is none. */
  fraction: string;
}

/** The parts of plain decimal text such as "-3" or "0.025"; undefined for anything else, an exponent included. */
export function decimalParts(text: string): DecimalParts | undefined {
  const m = DECIMAL_TEXT.exec(text);
  return m ? { negative: m[1] === "-", whole: m[2] as string, fraction: m[3] ?? "" } : undefined;
}

/** The decimal times 10^places, as an integer. The caller has checked that the fraction has at most `places` digits. */
export function scaleDecimal(parts: DecimalParts, places: number): bigint {
  const scaled = BigInt(parts.whole) * 10n ** BigInt(places) + BigInt(parts.fraction.padEnd(places, "0") || "0");
  return parts.negative ? -scaled : scaled;
}

/** A scaled integer as decimal text with exactly `places` fractional digits; `places` is at least 1. */
export function fixedPointText(scaled: bigint, places: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, "0");
  const point = digits.length - places;
  return `${negative ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point)}`;
}

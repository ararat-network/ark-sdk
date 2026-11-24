// Fixed-point decimal text and the scaled integer behind it: the one
// conversion LegacyDec's 18 places and an asset's display units share. Each
// caller keeps its own bound on the places and its own error. Internal: not
// exported from the core entry.

import { utf8Decode } from "./bytes.js";

/** The text of an Int or a Dec field: they travel as decimal text, in a string field or as the bytes of one. */
export function numericText(value: unknown): string {
  return value instanceof Uint8Array ? utf8Decode(value) : String(value);
}

/** An integer in decimal text, with an optional sign. */
export const INTEGER_TEXT = /^-?\d+$/;

/** An integer as the chain writes one: decimal digits with no leading zero, a minus sign before a negative one, zero unsigned. */
export const CANONICAL_INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/;

/** A digit's value as Go's math/big scans one, letters in either case counting from ten; 63, past every base, for anything else. */
function goDigit(ch: string): number {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "a" && ch <= "z") return ch.charCodeAt(0) - 87;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55;
  return 63;
}

/**
 * The integer that Go's big.Int.UnmarshalText reads from text, or undefined
 * where it returns an error. This is how the chain reads the text of a
 * math.Int and of a LegacyDec's scaled integer, and it is not decimal: the
 * base is taken from the text. "0x", "0o", and "0b" select 16, 8, and 2, and
 * a leading zero before more characters selects 8, so "0100" is 64. A sign of
 * either kind may lead, and an underscore may sit between a prefix and a
 * digit or between two digits. A line-for-line port of math/big's scanSign
 * and nat.scan with base 0, followed by the rule that all the text is used.
 */
export function goIntegerText(text: string): bigint | undefined {
  let i = 0;
  let negative = false;
  if (text[0] === "-") {
    negative = true;
    i = 1;
  } else if (text[0] === "+") {
    i = 1;
  }
  // What came before: a digit or a prefix "0", a separator, or neither. A separator is valid only after the first.
  let previous: "digit" | "separator" | "none" = "none";
  let misplacedSeparator = false;
  let base = 10;
  let octalPrefix = false;
  let digits = 0;
  let ch = text[i];
  if (ch === "0") {
    previous = "digit";
    digits = 1;
    ch = text[++i];
    if (ch !== undefined) {
      // A zero with anything after it is a prefix, and is not counted as a digit.
      digits = 0;
      if (ch === "b" || ch === "B") base = 2;
      else if (ch === "o" || ch === "O") base = 8;
      else if (ch === "x" || ch === "X") base = 16;
      else {
        base = 8;
        octalPrefix = true;
      }
      if (!octalPrefix) ch = text[++i];
    }
  }
  const radix = BigInt(base);
  let value = 0n;
  while (ch !== undefined) {
    if (ch === "_") {
      if (previous !== "digit") misplacedSeparator = true;
      previous = "separator";
    } else {
      const digit = goDigit(ch);
      // Not a digit of this base: the number ends here, and text is left over.
      if (digit >= base) break;
      previous = "digit";
      digits++;
      value = value * radix + BigInt(digit);
    }
    ch = text[++i];
  }
  if (misplacedSeparator || previous === "separator") return undefined;
  if (digits === 0 && !octalPrefix) return undefined;
  if (ch !== undefined) return undefined;
  return negative ? -value : value;
}

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

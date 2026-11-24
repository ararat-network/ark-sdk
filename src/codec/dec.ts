// cosmossdk.io/math.LegacyDec: a fixed-point decimal with 18 places, held on
// the wire and in generated messages as its scaled integer in decimal text.
// Arithmetic here mirrors the Go type where the fee contract uses it: Mul
// rounds half to even at the 18th place, Ceil and TruncateInt are exact.
import { decimalParts, fixedPointText, INTEGER_TEXT, scaleDecimal } from "./fixed.js";

export const DEC_PRECISION = 18;
const UNIT = 10n ** 18n;
const HALF_UNIT = UNIT / 2n;
/** Go's LegacyDec holds |scaled| up to 2^256 × 10^18 − 1, 316 bits. */
const MAX_SCALED = 2n ** 256n * UNIT - 1n;

export class DecError extends Error {
  override readonly name: string = "DecError";
}

export class LegacyDec {
  /** The value times 10^18. */
  readonly scaled: bigint;

  private constructor(scaled: bigint) {
    if (scaled > MAX_SCALED || scaled < -MAX_SCALED) throw new DecError("decimal out of range");
    this.scaled = scaled;
  }

  static fromScaled(scaled: bigint): LegacyDec {
    return new LegacyDec(scaled);
  }

  /** From the wire form, the scaled integer's decimal text; empty reads as zero. */
  static fromWire(wire: string): LegacyDec {
    if (wire === "") return new LegacyDec(0n);
    if (!INTEGER_TEXT.test(wire)) throw new DecError(`not a scaled decimal integer: ${wire}`);
    return new LegacyDec(BigInt(wire));
  }

  /** From decimal text such as "0.025" or "-3"; at most 18 fractional digits. */
  static fromString(text: string): LegacyDec {
    const parts = decimalParts(text);
    if (!parts || parts.fraction.length > DEC_PRECISION) throw new DecError(`not a decimal: ${text}`);
    return new LegacyDec(scaleDecimal(parts, DEC_PRECISION));
  }

  static fromInt(n: bigint | number): LegacyDec {
    return new LegacyDec(BigInt(n) * UNIT);
  }

  static zero(): LegacyDec {
    return new LegacyDec(0n);
  }

  static one(): LegacyDec {
    return new LegacyDec(UNIT);
  }

  /** The wire form. */
  toWire(): string {
    return this.scaled.toString();
  }

  /** Decimal text with exactly 18 fractional digits, as Go's String(). */
  toString(): string {
    return fixedPointText(this.scaled, DEC_PRECISION);
  }

  isZero(): boolean {
    return this.scaled === 0n;
  }

  isNegative(): boolean {
    return this.scaled < 0n;
  }

  compare(other: LegacyDec): number {
    return this.scaled < other.scaled ? -1 : this.scaled > other.scaled ? 1 : 0;
  }

  add(other: LegacyDec): LegacyDec {
    return new LegacyDec(this.scaled + other.scaled);
  }

  sub(other: LegacyDec): LegacyDec {
    return new LegacyDec(this.scaled - other.scaled);
  }

  /** Exact: an integer multiplier adds no places. */
  mulInt(n: bigint | number): LegacyDec {
    return new LegacyDec(this.scaled * BigInt(n));
  }

  /** Go's Mul: the product rounded half to even at the 18th place. */
  mul(other: LegacyDec): LegacyDec {
    return new LegacyDec(chopPrecisionAndRound(this.scaled * other.scaled));
  }

  /** Go's Quo: the quotient carried to 36 places, truncated, then rounded half to even at the 18th. */
  quo(other: LegacyDec): LegacyDec {
    if (other.scaled === 0n) throw new DecError("division by zero");
    return new LegacyDec(chopPrecisionAndRound((this.scaled * UNIT * UNIT) / other.scaled));
  }

  /** Go's QuoInt: the value divided by an integer, truncated at the 18th place. */
  quoInt(n: bigint | number): LegacyDec {
    const d = BigInt(n);
    if (d === 0n) throw new DecError("division by zero");
    return new LegacyDec(this.scaled / d);
  }

  /** Go's RoundInt: the nearest integer, ties to even. */
  roundInt(): bigint {
    return chopPrecisionAndRound(this.scaled);
  }

  /** The integer part, toward zero. */
  truncateInt(): bigint {
    return this.scaled / UNIT;
  }

  /** The least integer not below the value. */
  ceil(): bigint {
    const quo = this.scaled / UNIT;
    const rem = this.scaled % UNIT;
    return rem > 0n ? quo + 1n : quo;
  }

  /** The greatest integer not above the value. */
  floor(): bigint {
    const quo = this.scaled / UNIT;
    const rem = this.scaled % UNIT;
    return rem < 0n ? quo - 1n : quo;
  }
}

function chopPrecisionAndRound(d: bigint): bigint {
  if (d < 0n) return -chopPrecisionAndRound(-d);
  const quo = d / UNIT;
  const rem = d % UNIT;
  if (rem === 0n) return quo;
  if (rem < HALF_UNIT) return quo;
  if (rem > HALF_UNIT) return quo + 1n;
  return quo % 2n === 0n ? quo : quo + 1n;
}

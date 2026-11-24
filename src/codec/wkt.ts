// Well-known type text forms as the chain renders them: gogoproto's jsonpb for
// proto JSON, Go's time formatting for amino JSON. Both trim fractional
// seconds, but differently, so each has its own function.
import { create } from "@bufbuild/protobuf";
import { type Duration, DurationSchema, type Timestamp, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { ArkSdkError } from "../errors.js";
import { stripTrailing } from "./bytes.js";

const NANOS = 1_000_000_000n;

/** Go's zero time.Time, 0001-01-01T00:00:00Z, which a non-nullable Timestamp holds when unset. */
export const GO_ZERO_TIME_SECONDS = -62135596800n;

export class WktError extends ArkSdkError {
  override readonly name: string = "WktError";
}

/** jsonpb: RFC 3339 with 0, 3, 6, or 9 fractional digits. */
export function timestampToProtoJson(ts: Timestamp): string {
  if (ts.nanos < 0 || ts.nanos >= 1_000_000_000) throw new WktError(`timestamp nanos out of range: ${ts.nanos}`);
  return `${isoSeconds(ts.seconds) + jsonpbFraction(ts.nanos)}Z`;
}

/** Go's time.RFC3339 when nanos are zero, RFC3339Nano otherwise: trailing zeros dropped. */
export function timestampToAmino(ts: Timestamp): string {
  if (ts.nanos < 0) throw new WktError(`timestamp nanos must be non-negative: ${ts.nanos}`);
  const frac = ts.nanos === 0 ? "" : `.${stripTrailing(String(ts.nanos).padStart(9, "0"), "0")}`;
  return `${isoSeconds(ts.seconds) + frac}Z`;
}

function isoSeconds(seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  if (!Number.isSafeInteger(ms)) throw new WktError(`timestamp out of range: ${seconds}`);
  const iso = new Date(ms).toISOString();
  if (iso.length !== 24) throw new WktError(`timestamp out of range: ${seconds}`);
  return iso.slice(0, 19);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Parses RFC 3339 text to a Timestamp, keeping nanoseconds. */
export function timestampFromText(text: string): Timestamp {
  const m = RFC3339.exec(text);
  if (!m) throw new WktError(`not an RFC 3339 timestamp: ${text}`);
  const [, y, mo, d, h, mi, s, frac, zone] = m as unknown as [string, string, string, string, string, string, string, string | undefined, string];
  // Date.UTC reads a two-digit year as 19xx; setUTCFullYear does not.
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi), Number(s), 0);
  let seconds = BigInt(date.getTime() / 1000);
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1n : 1n;
    const offset = BigInt(Number(zone.slice(1, 3)) * 3600 + Number(zone.slice(4, 6)) * 60);
    seconds -= sign * offset;
  }
  const nanos = frac ? Number(frac.padEnd(9, "0")) : 0;
  return create(TimestampSchema, { seconds, nanos });
}

/** jsonpb: seconds with 0, 3, 6, or 9 fractional digits and an "s" suffix. */
export function durationToProtoJson(d: Duration): string {
  const total = d.seconds * NANOS + BigInt(d.nanos);
  const sign = total < 0n ? "-" : "";
  const abs = total < 0n ? -total : total;
  return `${sign}${abs / NANOS}${jsonpbFraction(abs % NANOS)}s`;
}

/** jsonpb's fraction of a second: nothing, or a point and 3, 6, or 9 digits, the fewest that hold the nanoseconds. */
function jsonpbFraction(nanos: number | bigint): string {
  let frac = `.${String(nanos).padStart(9, "0")}`;
  for (const suffix of ["000", "000", ".000"]) if (frac.endsWith(suffix)) frac = frac.slice(0, -suffix.length);
  return frac;
}

/**
 * The seconds the chain's amino encoder accepts: it writes the duration in nanoseconds as a 64-bit integer and refuses
 * more seconds than floor(MaxInt64 / 10^9) − 1. It checks no lower bound and overflows below one; the least whose
 * nanoseconds fit is the bound here.
 */
const MAX_AMINO_DURATION_SECONDS = 9_223_372_035n;
const MIN_AMINO_DURATION_SECONDS = -9_223_372_036n;

/** Amino: the whole duration in nanoseconds, as a quoted integer. */
export function durationToAmino(d: Duration): string {
  if (d.seconds > MAX_AMINO_DURATION_SECONDS || d.seconds < MIN_AMINO_DURATION_SECONDS) {
    throw new WktError(`duration out of range for its nanoseconds as a 64-bit integer: ${d.seconds}s`);
  }
  if (d.nanos <= -1_000_000_000 || d.nanos >= 1_000_000_000) throw new WktError(`duration nanos out of range: ${d.nanos}`);
  if ((d.seconds > 0n && d.nanos < 0) || (d.seconds < 0n && d.nanos > 0)) throw new WktError(`duration sign mismatch: ${d.seconds}s ${d.nanos}ns`);
  return (d.seconds * NANOS + BigInt(d.nanos)).toString();
}

/** Parses "1.5s" to a Duration. */
export function durationFromText(text: string): Duration {
  const m = /^(-?)(\d+)(?:\.(\d{1,9}))?s$/.exec(text);
  if (!m) throw new WktError(`not a duration: ${text}`);
  const negative = m[1] === "-";
  const seconds = BigInt(m[2] as string);
  const nanos = Number((m[3] ?? "").padEnd(9, "0"));
  return create(DurationSchema, { seconds: negative ? -seconds : seconds, nanos: negative ? -nanos : nanos });
}

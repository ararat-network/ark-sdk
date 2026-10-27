// Well-known type text forms as the chain renders them: gogoproto's jsonpb for
// proto JSON, Go's time formatting for amino JSON. Both trim fractional
// seconds, but differently, so each has its own function.
import { create } from "@bufbuild/protobuf";
import { type Duration, DurationSchema, type Timestamp, TimestampSchema } from "@bufbuild/protobuf/wkt";

const NANOS = 1_000_000_000n;

/** Go's zero time.Time, 0001-01-01T00:00:00Z, which a non-nullable Timestamp holds when unset. */
export const GO_ZERO_TIME_SECONDS = -62135596800n;

export class WktError extends Error {
  override readonly name: string = "WktError";
}

function isoSeconds(seconds: bigint): string {
  const ms = Number(seconds) * 1000;
  if (!Number.isSafeInteger(ms)) throw new WktError(`timestamp out of range: ${seconds}`);
  const iso = new Date(ms).toISOString();
  if (iso.length !== 24) throw new WktError(`timestamp out of range: ${seconds}`);
  return iso.slice(0, 19);
}

/** jsonpb: RFC 3339 with 0, 3, 6, or 9 fractional digits. */
export function timestampToProtoJson(ts: Timestamp): string {
  if (ts.nanos < 0 || ts.nanos >= 1_000_000_000) throw new WktError(`timestamp nanos out of range: ${ts.nanos}`);
  let frac = `.${String(ts.nanos).padStart(9, "0")}`;
  for (const suffix of ["000", "000", ".000"]) if (frac.endsWith(suffix)) frac = frac.slice(0, -suffix.length);
  return `${isoSeconds(ts.seconds) + frac}Z`;
}

/** Go's time.RFC3339 when nanos are zero, RFC3339Nano otherwise: trailing zeros dropped. */
export function timestampToAmino(ts: Timestamp): string {
  if (ts.nanos < 0) throw new WktError(`timestamp nanos must be non-negative: ${ts.nanos}`);
  const frac = ts.nanos === 0 ? "" : `.${String(ts.nanos).padStart(9, "0").replace(/0+$/, "")}`;
  return `${isoSeconds(ts.seconds) + frac}Z`;
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
  let frac = `.${String(abs % NANOS).padStart(9, "0")}`;
  for (const suffix of ["000", "000", ".000"]) if (frac.endsWith(suffix)) frac = frac.slice(0, -suffix.length);
  return `${sign}${abs / NANOS}${frac}s`;
}

/** Amino: the whole duration in nanoseconds, as a quoted integer. */
export function durationToAmino(d: Duration): string {
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

import { QR_SERVER_TIME_HEADER } from '@bifrost/shared';

/**
 * The earliest and latest millisecond clock accepted from `X-Server-Time`
 * (v1.38.0): anything outside is not a plausible server clock.
 */
const PLAUSIBLE_FROM_MS = Date.UTC(2020, 0, 1);
const PLAUSIBLE_TO_MS = Date.UTC(2100, 0, 1);

/** A plain run of digits, nothing else (no sign, exponent, point or space). */
const DIGITS = /^\d{1,16}$/;

/**
 * How far a tombstone reaches past the deletion stamp (v1.38.0). Another
 * session's row of the code stamped up to this long after the deletion is
 * still hidden, which covers a server clock that steps between answers and
 * the `Date` header's one-second resolution. This session's own create or
 * update of the code supersedes the tombstone at once, so the margin never
 * hides a code this session re-created.
 */
export const TOMBSTONE_SKEW_MARGIN_MS = 1000;

/** A header from a `Headers` object or a plain record, or undefined. */
function readHeader(headers: unknown, name: string): unknown {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get: (header: string) => unknown }).get(name) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  return record[name] ?? record[name.toLowerCase()];
}

/**
 * The server's clock when it answered, in Unix milliseconds, or undefined
 * (v1.38.0).
 *
 * `X-Server-Time` (QR answers) gives it to the millisecond, read after the
 * server's writes. It is accepted only when it is a safe integer written as
 * plain digits, within a plausible range, and inside the second the answer's
 * `Date` header names (allowing 1,000 ms either side, since the two are read
 * at slightly different moments). Anything else — a missing, malformed,
 * implausible or disagreeing value, or no readable `Date` to check it
 * against — falls back to the `Date` header, taken as the END of its second
 * (every write the server made before answering is at or before it). With
 * neither, undefined: the caller uses its own clock.
 */
export function serverTimeOf(headers: unknown): number | undefined {
  const date = readHeader(headers, 'date');
  const dateMs = typeof date === 'string' ? Date.parse(date) : Number.NaN;
  if (!Number.isFinite(dateMs)) return undefined;
  const precise = readHeader(headers, QR_SERVER_TIME_HEADER);
  if (typeof precise === 'string' && DIGITS.test(precise)) {
    const value = Number(precise);
    if (
      Number.isSafeInteger(value) &&
      value >= PLAUSIBLE_FROM_MS &&
      value < PLAUSIBLE_TO_MS &&
      value >= dateMs - 1000 &&
      value <= dateMs + 999 + 1000
    ) {
      return value;
    }
  }
  return dateMs + 999;
}

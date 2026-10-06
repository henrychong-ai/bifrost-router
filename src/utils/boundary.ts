/**
 * Validate at the boundary (v1.38.0).
 *
 * Data that crosses a trust or storage boundary (KV, R2, D1 JSON columns,
 * remote responses, request bodies, stored strings) is read as `unknown` and
 * validated before use. A type argument on the read (`kv.get<T>(…, 'json')`,
 * `res.json<T>()`) or an `as` cast only tells the compiler; nothing checks it.
 * `scripts/check-boundary-reads.mjs` fails the gate on those forms.
 *
 * The helpers here never throw a parser or schema message: both can quote the
 * stored value (Wi-Fi passwords, contact cards, tokens). A caller gets one of
 * three outcomes and handles `invalid` per site (a route lookup stops with a
 * 404, a QR code is not found, a rate-limit entry resets, an audit cursor
 * restarts its window), logging only {@link logInvalidBoundary}'s fixed line.
 */

import { fitsKvKey } from '../kv/schema';

/** Anything with Zod's `safeParse` shape: a Zod schema, or {@link guard}. */
export interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** A boundary read: absent, valid, or present but not the expected shape. */
export type BoundaryRead<T> =
  | { status: 'missing' }
  | { status: 'ok'; value: T }
  | { status: 'invalid' };

/** A hand-written type guard as a {@link Validator} (hot paths). */
export function guard<T>(test: (value: unknown) => value is T): Validator<T> {
  return {
    safeParse: value => (test(value) ? { success: true, data: value } : { success: false }),
  };
}

/** Validate an already-parsed value. */
export function validateValue<T>(value: unknown, schema: Validator<T>): BoundaryRead<T> {
  const result = schema.safeParse(value);
  return result.success ? { status: 'ok', value: result.data } : { status: 'invalid' };
}

/**
 * Parse and validate a stored JSON string. `null`/`undefined` is missing;
 * text that is not JSON, or JSON of the wrong shape, is invalid. Never throws.
 */
export function readStoredJson<T>(
  text: string | null | undefined,
  schema: Validator<T>,
): BoundaryRead<T> {
  if (text === null || text === undefined) return { status: 'missing' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: 'invalid' };
  }
  return validateValue(value, schema);
}

/**
 * Read a KV value as text and validate it locally. A KV failure (the binding
 * throwing) passes through unchanged for the caller's own error handling.
 *
 * A key over KV's 512-byte key limit (`fitsKvKey`) is `missing`
 * without a KV call: nothing can be stored under it, and KV throws on such a
 * read, so a very long visitor path or QR id would otherwise be a 500.
 */
export async function readKvJson<T>(
  kv: KVNamespace,
  key: string,
  schema: Validator<T>,
): Promise<BoundaryRead<T>> {
  if (!fitsKvKey(key)) return { status: 'missing' };
  return readStoredJson(await kv.get(key, 'text'), schema);
}

/**
 * Read a JSON response body and validate it. A body that is not JSON is
 * invalid; the parser's message (which can quote the body) is dropped.
 */
export async function readResponseJson<T>(
  response: Response,
  schema: Validator<T>,
): Promise<BoundaryRead<T>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { status: 'invalid' };
  }
  return validateValue(value, schema);
}

/**
 * The one log line for an invalid boundary value: a fixed message, the kind
 * of data (`route`, `qr`, `rate-limit`, `audit-cursor`, …) and, for a route
 * or QR code, its key (a route key is a public URL, a QR id is not secret);
 * never the value.
 */
export function logInvalidBoundary(category: string, key?: string): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      message: 'boundary-invalid-value',
      category,
      ...(key === undefined ? {} : { key }),
    }),
  );
}

/** Whether `value` is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Whether `value` is absent (undefined or null) or passes `test`. */
export function isOptional(value: unknown, test: (value: unknown) => boolean): boolean {
  return value === undefined || value === null || test(value);
}

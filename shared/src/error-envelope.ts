import { isRecord, isString } from './guards.js';

/**
 * The one reader of a failed answer's JSON body (v1.38.0), used by the shared
 * API client and the dashboard alike, so both agree on what a coded refusal is.
 *
 * A machine code is an UPPER_SNAKE value only (`QR_NOT_FOUND`,
 * `ROUTE_RECORD_INVALID`, `ROUTE_TARGET_CREDENTIAL`): an explicit `code` field
 * when it is one, else `error` when it is one AND a `message` stands beside it
 * (the coded-refusal shape `{ success: false, error: <code>, message }`).
 * Anything else, such as the 500 answer's `error: 'Internal Server Error'`, is
 * text and never a code. The text is the sentence: the `message`, else
 * `error` (unless `error` is the code itself). An empty or non-string field
 * reads as absent, and only the body's own fields count.
 */

const ERROR_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Whether `value` is a machine code: UPPER_SNAKE (`QR_NOT_FOUND`). */
export function isErrorCode(value: unknown): value is string {
  return isString(value) && ERROR_CODE.test(value);
}

/** A failed answer as {@link readErrorEnvelope} reads it. */
export interface ErrorEnvelope {
  /** The machine code, when the body carries one (UPPER_SNAKE only). */
  code: string | undefined;
  /** The body's `error` text, when it is a non-empty string (it may be the code). */
  error: string | undefined;
  /** The body's `message` text, when it is a non-empty string. */
  message: string | undefined;
  /** The human sentence: the `message`, else `error` unless that is the code. */
  text: string | undefined;
  /** The body's `details`, verbatim (a refusal's own contract). */
  details: unknown;
}

const nonEmpty = (value: unknown): string | undefined =>
  isString(value) && value !== '' ? value : undefined;

/**
 * `body` as an {@link ErrorEnvelope}, or null when it is not a JSON object.
 * The code is decided here and only here; each surface words its own message
 * from the fields (the client writes `code: text`, the dashboard the text).
 */
export function readErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (!isRecord(body)) return null;
  const own = (name: string): unknown => (Object.hasOwn(body, name) ? body[name] : undefined);
  const error = nonEmpty(own('error'));
  const message = nonEmpty(own('message'));
  const explicit = own('code');
  const code = isErrorCode(explicit)
    ? explicit
    : message !== undefined && isErrorCode(error)
      ? error
      : undefined;
  const text = message ?? (error === code ? undefined : error);
  return { code, error, message, text, details: own('details') };
}

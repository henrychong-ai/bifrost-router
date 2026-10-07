/**
 * Plain type guards for values read as `unknown` (v1.38.0): one definition
 * for the Worker (`src/utils/boundary.ts` re-exports them), the dashboard and
 * the shared API client, so "a plain object" means the same thing on every
 * side of a boundary.
 */

/** Whether `value` is a plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Whether `value` is a finite number (not NaN, not ±Infinity). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Whether `value` is absent (undefined or null) or passes `test`. */
export function isOptional(value: unknown, test: (value: unknown) => boolean): boolean {
  return value === undefined || value === null || test(value);
}

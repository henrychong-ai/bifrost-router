import { z } from 'zod';
import { isRecord } from './guards.js';

/**
 * Stored route records: the one tolerant read shape (v1.38.0), used by the
 * Worker on every KV read (`src/kv/stored-route.ts`) and by the dashboard on
 * every route it is sent ({@link StoredRouteSchema}), as `parseStoredQR` is
 * for QR codes.
 *
 * Route lookups run on every request, so {@link isStoredRoute} is a tight
 * hand-written guard, not a Zod parse. It checks the SHAPE the handlers rely
 * on and nothing more: `type` is one of the three route types, `path` and
 * `target` are strings, and every optional field that is present has its
 * declared type. It is deliberately as tolerant as the shared response schema
 * `RouteSchema` without its write rules: an optional field may be absent or
 * `null`, unknown extra fields are kept, `createdAt`/`updatedAt` may be
 * absent, and values (status codes, bucket names) are left to the handlers'
 * own checks. A record written before today's rules (no timestamps, a status
 * code or bucket name no write accepts today) therefore reads, lists and opens
 * everywhere; the write schemas still apply to what a write sets.
 */

const ROUTE_TYPES: ReadonlySet<unknown> = new Set(['redirect', 'proxy', 'r2']);

/** Optional fields by declared type (absent or null is always accepted). */
export const STORED_ROUTE_FIELDS = {
  boolean: ['preserveQuery', 'preservePath', 'forceDownload', 'enabled'],
  number: ['statusCode', 'createdAt', 'updatedAt'],
  string: ['cacheControl', 'hostHeader', 'bucket'],
} as const;

/** Required string fields besides `type`. */
export const STORED_ROUTE_REQUIRED = ['path', 'target'] as const;

/**
 * A stored route as a reader may see it: the declared fields, each optional
 * one possibly absent, and values not narrowed beyond their type (a status
 * code is a number, a bucket a string).
 */
export interface StoredRoute {
  path: string;
  type: 'redirect' | 'proxy' | 'r2';
  target: string;
  statusCode?: number | undefined;
  preserveQuery?: boolean | undefined;
  preservePath?: boolean | undefined;
  cacheControl?: string | undefined;
  hostHeader?: string | undefined;
  forceDownload?: boolean | undefined;
  bucket?: string | undefined;
  enabled?: boolean | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
}

const present = (value: unknown) => value !== undefined && value !== null;

/** Whether `value` has the shape of a stored route record (optional fields may be null). */
export function isStoredRoute(value: unknown): boolean {
  if (!isRecord(value) || !ROUTE_TYPES.has(value['type'])) return false;
  for (const field of STORED_ROUTE_REQUIRED) {
    if (typeof value[field] !== 'string') return false;
  }
  for (const field of STORED_ROUTE_FIELDS.boolean) {
    if (present(value[field]) && typeof value[field] !== 'boolean') return false;
  }
  for (const field of STORED_ROUTE_FIELDS.number) {
    if (present(value[field]) && typeof value[field] !== 'number') return false;
  }
  for (const field of STORED_ROUTE_FIELDS.string) {
    if (present(value[field]) && typeof value[field] !== 'string') return false;
  }
  return true;
}

/**
 * A stored route as a reader receives it, or null when it is not one: the
 * {@link isStoredRoute} check, with null optional fields dropped so every
 * optional field is either its declared type or absent. Unknown extra fields
 * are kept, as the Worker sends them.
 */
export function parseStoredRoute(value: unknown): StoredRoute | null {
  if (!isStoredRoute(value) || !isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if (item !== null && item !== undefined) out[field] = item;
  }
  return out as unknown as StoredRoute;
}

/**
 * {@link parseStoredRoute} as a schema, for response validation in the
 * dashboard: a route the Worker reads and lists is a route the dashboard
 * accepts; anything else fails with one fixed message.
 */
export const StoredRouteSchema = z.unknown().transform((value, ctx): StoredRoute => {
  const route = parseStoredRoute(value);
  if (route === null) {
    ctx.addIssue({ code: 'custom', message: 'Not a route record' });
    return z.NEVER;
  }
  return route;
});

/**
 * A listing row for a stored route record that cannot be read (v1.38.0): its
 * key only (domain and path), flagged `invalid`. Listings include these rows
 * so an operator can find and delete the record (DELETE accepts it); nothing
 * else can be done with one, and a visitor is never served it.
 */
export interface InvalidRouteRow {
  domain: string;
  path: string;
  invalid: true;
}

/** Whether a listing row is an {@link InvalidRouteRow}. */
export function isInvalidRouteRow(row: unknown): row is InvalidRouteRow {
  return (
    isRecord(row) &&
    row['invalid'] === true &&
    typeof row['domain'] === 'string' &&
    typeof row['path'] === 'string'
  );
}

/** {@link isInvalidRouteRow} as a schema (dashboard response validation). */
export const InvalidRouteRowSchema = z.object({
  domain: z.string(),
  path: z.string(),
  invalid: z.literal(true),
});

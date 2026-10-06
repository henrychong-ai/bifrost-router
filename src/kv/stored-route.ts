import type { KVRouteConfig } from '../types';
import {
  type BoundaryRead,
  guard,
  isRecord,
  logInvalidBoundary,
  readKvJson,
} from '../utils/boundary';
import { isRouteKey } from './schema';

/**
 * Stored route records, validated on every read (v1.38.0).
 *
 * Route lookups run on every request, so this is a tight hand-written guard,
 * not a Zod parse. It checks the SHAPE the handlers rely on and nothing more:
 * `type` is one of the three route types, `path` and `target` are strings, and
 * every optional field that is present has its declared type. It is
 * deliberately as tolerant as the shared response schema `RouteSchema`,
 * which carries none of the write caps: an optional field may be absent or
 * `null`, unknown extra fields are kept, `createdAt`/`updatedAt` may be
 * absent, and values (status codes, bucket names) are left to the handlers'
 * own checks, exactly as before. A record that fails is logged once
 * (`boundary-invalid-value`, category `route`, with its public key, never the
 * value). Route lookup then STOPS with a 404 instead of falling through to a
 * broader wildcard (a bad exact record must not hand its path to a wildcard
 * that was never meant to serve it); management reads and listings treat it
 * as missing; delete treats it as present, and every other write refuses it
 * (409 `ROUTE_RECORD_INVALID`).
 *
 * `test/kv/stored-route.test.ts` keeps the field lists in step with the shared
 * `RouteSchema`: every schema field is classified here, and every record the
 * schema accepts passes this guard.
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

const present = (value: unknown) => value !== undefined && value !== null;

/** Whether `value` has the shape of a stored route record. */
export function isStoredRoute(value: unknown): value is KVRouteConfig {
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

const storedRoute = guard(isStoredRoute);

/**
 * One stored route by its exact KV key, as a boundary read: `invalid` is
 * logged once with a fixed line naming the key (route keys are public URLs),
 * never the value; a key that is not route-shaped is never named. KV errors
 * are thrown unchanged; a key over 512 bytes is `missing`.
 */
export async function readRouteState(
  kv: KVNamespace,
  key: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  const read = await readKvJson(kv, key, storedRoute);
  if (read.status === 'invalid') logInvalidBoundary('route', isRouteKey(key) ? key : undefined);
  return read;
}

/**
 * One stored route by its exact KV key: the record, or null when it is absent
 * or invalid (logged). For management reads and listings; route lookup uses
 * readRouteState, so an invalid record fails closed there.
 */
export async function readRouteRecord(kv: KVNamespace, key: string): Promise<KVRouteConfig | null> {
  const read = await readRouteState(kv, key);
  return read.status === 'ok' ? read.value : null;
}

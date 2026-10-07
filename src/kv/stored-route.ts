import { isStoredRoute as isStoredRouteShape } from '@bifrost/shared';
import type { KVRouteConfig } from '../types';
import { type BoundaryRead, guard, logInvalidBoundary, readKvJson } from '../utils/boundary';
import { isRouteKey } from './schema';

/**
 * Stored route records, validated on every read (v1.38.0).
 *
 * The guard is `isStoredRoute` in `@bifrost/shared` (`stored-route.ts`): a
 * tight hand-written shape check for the hot path, the same one the
 * dashboard's response schema uses, so a record the Worker reads is a record
 * the dashboard lists. It is as tolerant as the shared response schema
 * `RouteSchema` without its write rules (optional fields absent or `null`,
 * extra fields kept, timestamps optional, status codes and bucket names left
 * to the handlers). A record that fails is logged once
 * (`boundary-invalid-value`, category `route`, with its public key, never the
 * value). Every reader gets the three-state answer (`missing`, `ok`,
 * `invalid`), never a null for an unreadable record. Route lookup STOPS with a
 * 404 instead of falling through to a broader wildcard (a bad exact record
 * must not hand its path to a wildcard that was never meant to serve it);
 * listings show it as a minimal `invalid` row; a single-route read and every
 * write except delete answer 409 `ROUTE_RECORD_INVALID`; delete removes it.
 *
 * `test/kv/stored-route.test.ts` keeps the field lists in step with the
 * shared `RouteSchema`: every schema field is classified, and every record
 * the schema accepts passes the guard.
 */

export { STORED_ROUTE_FIELDS, STORED_ROUTE_REQUIRED } from '@bifrost/shared';

/** Whether `value` has the shape of a stored route record (the shared guard, typed for the Worker). */
export function isStoredRoute(value: unknown): value is KVRouteConfig {
  return isStoredRouteShape(value);
}

const storedRoute = guard(isStoredRoute);

/**
 * One stored route by its exact KV key, as a boundary read, WITHOUT the log
 * line: route lookup reads every candidate and logs only the one it selects
 * ({@link logInvalidRoute}). KV errors are thrown unchanged; a key over 512
 * bytes is `missing`.
 */
export function readStoredRoute(
  kv: KVNamespace,
  key: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  return readKvJson(kv, key, storedRoute);
}

/**
 * The fixed log line for a stored route that cannot be read: its key when
 * the key is route-shaped (route keys are public URLs), never the value.
 */
export function logInvalidRoute(key: string): void {
  logInvalidBoundary('route', isRouteKey(key) ? key : undefined);
}

/**
 * One stored route by its exact KV key, as a boundary read (`missing`, `ok`
 * or `invalid`, never collapsed): `invalid` is logged once
 * ({@link logInvalidRoute}). KV errors are thrown unchanged; a key over 512
 * bytes is `missing`.
 */
export async function readRouteState(
  kv: KVNamespace,
  key: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  const read = await readStoredRoute(kv, key);
  if (read.status === 'invalid') logInvalidRoute(key);
  return read;
}

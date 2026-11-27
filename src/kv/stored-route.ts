import { isStoredRoute as isStoredRouteShape } from '@bifrost/shared';
import { KV_BULK_GET_MAX_KEYS } from '../backup/kv';
import type { KVRouteConfig } from '../types';
import {
  type BoundaryRead,
  guard,
  logInvalidBoundary,
  readKvJson,
  readStoredJson,
} from '../utils/boundary';
import { errorName } from '../utils/error-name';
import { fitsKvKey, isRouteKey } from './schema';

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
 * ({@link logInvalidServedRoute}). KV errors are thrown unchanged; a key over
 * 512 bytes is `missing`.
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
 * The fixed line for an unreadable stored route met while serving (v1.47.0):
 * the domain and which candidate decided the request (`exact` or
 * `wildcard`), never the key. The exact key is the visitor's normalised path,
 * and a wildcard candidate is built from its segments. Management reads keep
 * {@link logInvalidRoute}, which names the key.
 */
export function logInvalidServedRoute(domain: string, match: 'exact' | 'wildcard'): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      message: 'boundary-invalid-value',
      category: 'route',
      domain,
      match,
    }),
  );
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

/**
 * Many stored routes by their exact KV keys (v1.48.0): what
 * {@link readRouteState} gives for each key, read in bulk, one KV operation
 * per KV_BULK_GET_MAX_KEYS (100) keys instead of one per key, the reading the
 * backup uses (`src/backup/kv.ts`). KV allows 1,000 operations per
 * invocation and counts a bulk read as one, so a route scan of about 1,000
 * routes no longer fails for that reason. Each value goes through the same
 * boundary check (`readStoredJson` with the stored-route guard), an invalid
 * record is logged once with the same line, and a key over 512 bytes is
 * `missing` without a read. The map holds every key asked for.
 *
 * A bulk call that fails for any reason (KV answers 413 when one call's
 * values add up to more than 25 MB, which large old records can reach) is
 * retried for that chunk one key at a time, through {@link readRouteState}
 * itself: such a chunk costs 1 + its keys, never less than before bulk reads,
 * and a KV error on a single read is thrown unchanged, exactly as before.
 */
export async function readRouteStates(
  kv: KVNamespace,
  keys: readonly string[],
): Promise<Map<string, BoundaryRead<KVRouteConfig>>> {
  const reads = new Map<string, BoundaryRead<KVRouteConfig>>();
  const readable: string[] = [];
  for (const key of keys) {
    if (fitsKvKey(key)) readable.push(key);
    else reads.set(key, { status: 'missing' });
  }
  const chunks: string[][] = [];
  for (let start = 0; start < readable.length; start += KV_BULK_GET_MAX_KEYS) {
    chunks.push(readable.slice(start, start + KV_BULK_GET_MAX_KEYS));
  }
  const results = await Promise.all(chunks.map(chunk => readRouteChunk(kv, chunk)));
  for (const result of results) {
    for (const [key, read] of result) reads.set(key, read);
  }
  return reads;
}

/** One chunk of {@link readRouteStates}: one bulk call, else one read per key. */
async function readRouteChunk(
  kv: KVNamespace,
  chunk: readonly string[],
): Promise<Array<[string, BoundaryRead<KVRouteConfig>]>> {
  let texts: Map<string, string | null>;
  try {
    texts = await kv.get([...chunk], 'text');
  } catch (error) {
    // The class and the chunk size only: never a key or the error's text
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'route-bulk-read-fallback',
        errorName: errorName(error),
        keys: chunk.length,
      }),
    );
    return Promise.all(
      chunk.map(
        async (key): Promise<[string, BoundaryRead<KVRouteConfig>]> => [
          key,
          await readRouteState(kv, key),
        ],
      ),
    );
  }
  return chunk.map(key => {
    const read = readStoredJson(texts.get(key), storedRoute);
    if (read.status === 'invalid') logInvalidRoute(key);
    return [key, read];
  });
}

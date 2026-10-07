import {
  type InvalidRouteRow,
  MAX_CACHE_CONTROL_LENGTH,
  MAX_HOST_HEADER_LENGTH,
  MAX_ROUTE_RECORD_BYTES,
  MAX_ROUTE_TARGET_LENGTH,
} from '@bifrost/shared';
import { HTTPException } from 'hono/http-exception';
import type { KVRouteConfig, SupportedDomain } from '../types';
import { isValidDomain } from '../types';
import type { BoundaryRead } from '../utils/boundary';
import { CodedHTTPException } from '../utils/coded-http-exception';
import { KVDeleteError, KVReadError, KVWriteError } from '../utils/kv-errors';
import { normalizePath } from './lookup';
import {
  type CreateRouteInput,
  domainPrefix,
  fitsKvKey,
  isRouteKey,
  parseRouteKey,
  routeKey,
} from './schema';
import { readRouteState } from './stored-route';

/** The fixed refusals of a route write that would store too much (v1.37.2). */
export const ROUTE_WRITE_REFUSALS = {
  keyTooLong: 'Route path is too long for this domain',
  recordTooLarge: 'Route record is too large',
  target: `Target must be at most ${MAX_ROUTE_TARGET_LENGTH} characters`,
  hostHeader: `Host header must be at most ${MAX_HOST_HEADER_LENGTH} characters`,
  cacheControl: `Cache-Control must be at most ${MAX_CACHE_CONTROL_LENGTH} characters`,
} as const;

/**
 * A route write refused before any KV write: a 400 whose JSON body,
 * `{ success: false, error }`, carries one fixed {@link ROUTE_WRITE_REFUSALS}
 * message, which the dashboard shows as it is (v1.37.2). A seed refusal also
 * names the offending input path, as `path`.
 */
export class RouteWriteRefusedError extends HTTPException {
  constructor(
    readonly refusal: (typeof ROUTE_WRITE_REFUSALS)[keyof typeof ROUTE_WRITE_REFUSALS],
    readonly path?: string,
  ) {
    super(400, {
      message: refusal,
      res: Response.json(
        { success: false, error: refusal, ...(path === undefined ? {} : { path }) },
        { status: 400 },
      ),
    });
    this.name = 'RouteWriteRefusedError';
  }
}

/** The fixed message of {@link InvalidStoredRouteError}. */
export const ROUTE_RECORD_INVALID_MESSAGE =
  'This route is stored in a shape that cannot be read. Delete it and create it again.';

/**
 * A read of, or a write over, a stored route record that cannot be read
 * (v1.38.0): a fixed 409 `{ success: false, error: 'ROUTE_RECORD_INVALID',
 * message }` instead of answering it as absent or merging with, moving or
 * overwriting unreadable data. The recovery is to delete the route (DELETE
 * accepts an invalid record) and create it again.
 */
export class InvalidStoredRouteError extends CodedHTTPException {
  constructor() {
    super(409, 'ROUTE_RECORD_INVALID', ROUTE_RECORD_INVALID_MESSAGE);
    this.name = 'InvalidStoredRouteError';
  }
}

const utf8 = new TextEncoder();

/**
 * Refuse a route key over KV's 512-byte key limit (v1.37.2): the path field
 * itself has no cap, so a long path, or a long domain, would otherwise reach
 * KV and fail there as a 500.
 */
export function assertRouteKeyFits(key: string): void {
  if (!fitsKvKey(key)) {
    throw new RouteWriteRefusedError(ROUTE_WRITE_REFUSALS.keyTooLong);
  }
}

/**
 * The serialised form of the EXACT record about to be stored at `key`, after
 * its key and its whole size are checked (v1.37.2): the guarantee every route
 * writer runs immediately before its `kv.put`, on the record as stored (merged,
 * path normalised, timestamps set), and the string it returns is what is
 * written, so what was measured is what is stored. Throws
 * {@link RouteWriteRefusedError} (a fixed 400) before anything is written.
 */
export function serializeStoredRoute(
  key: string,
  record: KVRouteConfig,
  { checkSize = true }: { checkSize?: boolean } = {},
): string {
  assertRouteKeyFits(key);
  const serialized = JSON.stringify(record);
  if (checkSize && utf8.encode(serialized).byteLength > MAX_ROUTE_RECORD_BYTES) {
    throw new RouteWriteRefusedError(ROUTE_WRITE_REFUSALS.recordTooLarge);
  }
  return serialized;
}

/**
 * Refuse a field being WRITTEN over its cap (v1.37.2). Only the fields a write
 * sets are checked: a create sets every field, an update only those in its
 * patch, so a legacy record whose stored target is over the cap can still be
 * toggled or have another field edited.
 */
export function assertWrittenFieldsFit(fields: {
  target?: string | undefined;
  hostHeader?: string | undefined;
  cacheControl?: string | undefined;
}): void {
  if ((fields.target?.length ?? 0) > MAX_ROUTE_TARGET_LENGTH) {
    throw new RouteWriteRefusedError(ROUTE_WRITE_REFUSALS.target);
  }
  if ((fields.hostHeader?.length ?? 0) > MAX_HOST_HEADER_LENGTH) {
    throw new RouteWriteRefusedError(ROUTE_WRITE_REFUSALS.hostHeader);
  }
  if ((fields.cacheControl?.length ?? 0) > MAX_CACHE_CONTROL_LENGTH) {
    throw new RouteWriteRefusedError(ROUTE_WRITE_REFUSALS.cacheControl);
  }
}

/**
 * serializeStoredRoute plus the field caps on every field, for the writers
 * that set a whole record (create, seed). Update checks only its patch
 * fields; migrate, transfer and normalize-case move a record unedited, so
 * they check only its key and size.
 */
export function serializeCheckedRoute(key: string, record: KVRouteConfig): string {
  assertWrittenFieldsFit(record);
  return serializeStoredRoute(key, record);
}

/** A new route record as createRoute stores it. */
function buildNewRoute(
  input: CreateRouteInput,
  normalizedPath: string,
  now: number,
): KVRouteConfig {
  return {
    ...input,
    path: normalizedPath,
    preserveQuery: input.preserveQuery ?? true,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

/** A route's stored state by its exact key; a KV failure is a KVReadError. */
async function readStateOrThrow(
  kv: KVNamespace,
  key: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  try {
    return await readRouteState(kv, key);
  } catch (error) {
    throw new KVReadError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * A single route by domain and path, as a boundary read (v1.38.0): `missing`,
 * `ok` with the record, or `invalid` (a record is stored but cannot be read,
 * logged once). Never a null for an unreadable record: every caller decides
 * what an unreadable route means for it. Throws KVReadError on a KV failure.
 *
 * ⚠️ The path is NORMALISED to the storage format, because every mutation
 * normalises before it writes. A read that built its key from the RAW path
 * missed on any alias of a stored path — `/Promo`, `/promo/`, `//promo`,
 * `/pro%6do` — and a miss here is SILENT: the admin handlers use this to fetch
 * the record they are about to guard, audit or refuse as a duplicate, so a miss
 * let a re-enable skip the credential-target guard, let a transfer skip it, let
 * a create overwrite an existing route instead of answering 409, and let a
 * delete audit the wrong before-state. A key over KV's limit reads as missing
 * (no route is stored there, and KV refuses such a key even on read).
 *
 * Callers that have ALREADY normalised must use {@link getRouteByNormalizedPath}
 * instead — `normalizePath()` is not idempotent, so normalising twice resolves a
 * different key again in the other direction.
 */
export async function getRoute(
  kv: KVNamespace,
  domain: string,
  path: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  return readStateOrThrow(kv, routeKey(domain, normalizePath(path)));
}

/**
 * Read a route by a path that has ALREADY been normalised — builds the key
 * without normalising again. The same three-state answer as {@link getRoute}.
 *
 * ⚠️ `normalizePath()` is NOT idempotent. It strips `?`/`#` BEFORE percent-
 * decoding, so a second pass eats anything the first decode produced:
 * `/p%3Fx` → `/p?x` → `/p`. Every mutating function below normalises once, so
 * it must NOT then read through {@link getRoute}, which normalises again — the
 * read would resolve a different key from the write. `PUT ?path=%2Fp%253Fx`
 * would read the record at `/p` and write the merged result under `/p?x`,
 * publishing a second, enabled copy of a route the guard never examined. Read
 * and write must use ONE key.
 *
 * The mirror-image hazard is a read that does not normalise AT ALL while the
 * write does — see the warning on {@link getRoute}.
 */
export async function getRouteByNormalizedPath(
  kv: KVNamespace,
  domain: string,
  normalizedPath: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  return readStateOrThrow(kv, routeKey(domain, normalizedPath));
}

/**
 * Read the route stored at EXACTLY `{domain}:{storedPath}` (v1.38.0): the
 * path is the stored key's own text, as a listing shows it, and is never
 * normalised, so a legacy key that does not round-trip (`/Promo`, `/p?x`,
 * `/promo/`) names itself and no other record. The same three-state answer
 * as {@link getRoute}. Used by the recovery of an unreadable record
 * ({@link recoverInvalidRoute}); every other caller takes a route path and
 * reads through {@link getRoute}.
 */
export async function getRouteAtExactKey(
  kv: KVNamespace,
  domain: string,
  storedPath: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  return readStateOrThrow(kv, routeKey(domain, storedPath));
}

/**
 * The record of a route that is present, null when absent; an unreadable
 * record is refused (409 ROUTE_RECORD_INVALID) rather than treated as absent.
 */
export function presentRoute(read: BoundaryRead<KVRouteConfig>): KVRouteConfig | null {
  if (read.status === 'invalid') throw new InvalidStoredRouteError();
  return read.status === 'ok' ? read.value : null;
}

/**
 * A listing of stored routes (v1.38.0): the readable records, and a minimal
 * row (`{ domain, path, invalid: true }`) for each record that cannot be read,
 * so an operator can find and delete it. Nothing but the listing API shows
 * the invalid rows; every other reader takes `routes` only.
 */
export interface RouteListing<T> {
  routes: T[];
  invalid: InvalidRouteRow[];
}

/** The invalid-row for an unreadable record at `key` (logged by the read already). */
function invalidRow(key: string): InvalidRouteRow {
  const [domain, path] = parseRouteKey(key);
  return { domain, path, invalid: true };
}

/**
 * Every stored route of a domain, by prefix listing (v1.38.0: with a row for
 * each record that cannot be read). Throws KVReadError on failure.
 */
export async function listDomainRoutes(
  kv: KVNamespace,
  domain: string,
): Promise<RouteListing<KVRouteConfig>> {
  try {
    const prefix = domainPrefix(domain);
    const listing: RouteListing<KVRouteConfig> = { routes: [], invalid: [] };
    let cursor: string | undefined;

    // List all keys with domain prefix
    do {
      const result = await kv.list({ prefix, ...(cursor !== undefined && { cursor }) });

      // Fetch route values for each route-shaped key: nothing else is read
      const keys = result.keys.map(key => key.name).filter(isRouteKey);
      const reads = await Promise.all(keys.map(key => readRouteState(kv, key)));
      for (const [index, read] of reads.entries()) {
        if (read.status === 'ok') listing.routes.push(read.value);
        else if (read.status === 'invalid') listing.invalid.push(invalidRow(keys[index] ?? ''));
      }

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return listing;
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError(
      `list:${domain}`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Route configuration with domain field (for all-domains queries)
 */
export type KVRouteConfigWithDomain = KVRouteConfig & {
  domain: SupportedDomain;
};

/**
 * Every stored route of every supported domain (no prefix; the domain is
 * parsed from each key and added), with a row for each record that cannot be
 * read (v1.38.0). Throws KVReadError on failure.
 */
export async function listAllDomainRoutes(
  kv: KVNamespace,
): Promise<RouteListing<KVRouteConfigWithDomain>> {
  try {
    const listing: RouteListing<KVRouteConfigWithDomain> = { routes: [], invalid: [] };
    let cursor: string | undefined;

    // List all keys (no prefix = all domains)
    do {
      const result = await kv.list({ ...(cursor !== undefined && { cursor }) });

      // Only route-shaped keys `{domain}:/…` of a supported domain are read
      // (v1.38.0). The namespace also holds `qr:` records and, with the
      // optional rate limiter, `ratelimit:` entries (client IP addresses):
      // none of them may be read, or logged by the invalid-record line, as a
      // route. A KV read failure for any key fails the whole listing, as the
      // one-domain listing does: a route is never silently left out.
      const keys: Array<{ key: string; domain: SupportedDomain }> = [];
      for (const { name } of result.keys) {
        if (!isRouteKey(name)) continue;
        const [domain] = parseRouteKey(name);
        if (isValidDomain(domain)) keys.push({ key: name, domain });
      }
      const reads = await Promise.all(keys.map(({ key }) => readRouteState(kv, key)));
      // Told apart by the read's own status, never by a field of the record
      for (const [index, read] of reads.entries()) {
        const entry = keys[index];
        if (entry === undefined) continue;
        if (read.status === 'ok') listing.routes.push({ ...read.value, domain: entry.domain });
        else if (read.status === 'invalid') listing.invalid.push(invalidRow(entry.key));
      }

      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return listing;
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError('list:all', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Create a new route
 * Throws KVWriteError on failure
 */
export async function createRoute(
  kv: KVNamespace,
  domain: string,
  input: CreateRouteInput,
): Promise<KVRouteConfig> {
  const normalizedPath = normalizePath(input.path);
  const key = routeKey(domain, normalizedPath);
  const route = buildNewRoute(input, normalizedPath, Date.now());
  const serialized = serializeCheckedRoute(key, route);

  try {
    await kv.put(key, serialized);
    return route;
  } catch (error) {
    throw new KVWriteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The fields an update may carry. Each one may be left out, or be present with
 * the value `undefined`: Zod's output type for an optional field allows both,
 * even though a parsed JSON body only ever produces the first.
 */
type RoutePatch = { [K in keyof CreateRouteInput]?: CreateRouteInput[K] | undefined };

/**
 * Update an existing route
 * Returns null if not found, throws KVWriteError on failure
 */
export async function updateRoute(
  kv: KVNamespace,
  domain: string,
  path: string,
  updates: RoutePatch,
): Promise<KVRouteConfig | null> {
  const normalizedPath = normalizePath(path);
  const key = routeKey(domain, normalizedPath);
  // Never merged with a record that cannot be read: 409, delete and recreate
  const existing = presentRoute(await readStateOrThrow(kv, key));
  if (!existing) return null;

  const updated: KVRouteConfig = {
    ...existing,
    ...updates,
    // A stored route always has a type and a target. A patch that leaves either
    // out keeps the stored value, as the spread alone already did; writing them
    // out also keeps it when the key is present but `undefined`.
    type: updates.type ?? existing.type,
    target: updates.target ?? existing.target,
    path: normalizedPath, // Path cannot be changed
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  // The patch's own fields against their caps; the merged record as it will
  // be stored against the key and size limits, checked as it is written
  assertWrittenFieldsFit(updates);
  // A patch that only enables or disables the route skips the size check, so
  // an oversized legacy route can always be switched off (v1.37.2)
  const onlyEnabled = Object.entries(updates).every(
    ([field, value]) => field === 'enabled' || field === 'path' || value === undefined,
  );
  const serialized = serializeStoredRoute(key, updated, { checkSize: !onlyEnabled });

  try {
    await kv.put(key, serialized);
    return updated;
  } catch (error) {
    throw new KVWriteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Delete a route, also one whose stored record cannot be read (v1.38.0):
 * deleting it is how an operator recovers it. Answers the state it found, read
 * once: `missing` (nothing deleted), or the `ok` record or `invalid` state it
 * deleted, for the caller's audit row and cache purge. Throws KVReadError or
 * KVDeleteError on a KV failure.
 */
export async function deleteRoute(
  kv: KVNamespace,
  domain: string,
  path: string,
): Promise<BoundaryRead<KVRouteConfig>> {
  const key = routeKey(domain, normalizePath(path));
  const state = await readStateOrThrow(kv, key);
  if (state.status === 'missing') return state;

  try {
    await kv.delete(key);
    return state;
  } catch (error) {
    throw new KVDeleteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The outcome of {@link recoverInvalidRoute}: the exact key held nothing,
 * held a readable route (refused: the ordinary delete is for those), or held
 * a record that could not be read, which is now deleted.
 */
export type RouteRecovery = 'missing' | 'readable' | 'deleted';

/**
 * Delete the record stored at EXACTLY `{domain}:{storedPath}`, and only when
 * it cannot be read (v1.38.0): the recovery for an unreadable record a
 * listing showed. The path is the stored key's own text and is never
 * normalised, so a legacy key that does not round-trip (`/Promo`, `/p?x`,
 * `/promo/`) names itself, and the ordinary delete's normalisation can never
 * resolve it to another, valid route and delete that one instead. A readable
 * record is refused, never deleted. Throws KVReadError or KVDeleteError on a
 * KV failure.
 */
export async function recoverInvalidRoute(
  kv: KVNamespace,
  domain: string,
  storedPath: string,
): Promise<RouteRecovery> {
  const state = await getRouteAtExactKey(kv, domain, storedPath);
  if (state.status === 'missing') return 'missing';
  if (state.status === 'ok') return 'readable';
  const key = routeKey(domain, storedPath);
  try {
    await kv.delete(key);
    return 'deleted';
  } catch (error) {
    throw new KVDeleteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Seed routes from an array (useful for migration)
 */
export async function seedRoutes(
  kv: KVNamespace,
  domain: string,
  routes: CreateRouteInput[],
): Promise<{ created: number; skipped: number; createdPaths: string[] }> {
  let created = 0;
  let skipped = 0;
  // The input paths that were actually written, so a caller can audit what it
  // changed rather than what it submitted.
  const createdPaths: string[] = [];

  // Every record is built and checked before anything is written, so one
  // that is too large refuses the whole batch with nothing stored, naming its
  // path (v1.37.2). Entries that normalise to a key already queued in this
  // batch are skipped, the first winning, exactly like an existing key.
  const now = Date.now();
  const queued = new Set<string>();
  const built: Array<{ inputPath: string; key: string; serialized: string }> = [];
  for (const route of routes) {
    const normalizedPath = normalizePath(route.path);
    const key = routeKey(domain, normalizedPath);
    let serialized: string;
    try {
      serialized = serializeCheckedRoute(key, buildNewRoute(route, normalizedPath, now));
    } catch (error) {
      if (error instanceof RouteWriteRefusedError) {
        throw new RouteWriteRefusedError(error.refusal, route.path);
      }
      throw error;
    }
    if (queued.has(key)) {
      skipped++;
      continue;
    }
    queued.add(key);
    built.push({ inputPath: route.path, key, serialized });
  }

  // Each existence check reads exactly the key about to be written, so an
  // alias of a stored path is SKIPPED rather than silently overwriting the
  // record it aliases; a record that cannot be read is present too, and is
  // never overwritten (v1.38.0). The reads are independent.
  const existing = await Promise.all(built.map(entry => readStateOrThrow(kv, entry.key)));

  for (const [index, { inputPath, key, serialized }] of built.entries()) {
    if (existing[index]?.status !== 'missing') {
      skipped++;
      continue;
    }
    try {
      await kv.put(key, serialized);
    } catch (error) {
      throw new KVWriteError(key, error instanceof Error ? error : new Error(String(error)));
    }
    created++;
    createdPaths.push(inputPath);
  }

  return { created, skipped, createdPaths };
}

/**
 * What {@link migrateRoute} may do besides the move (v1.38.0): `patch` is an
 * update applied to the moved record, written ONCE at the new key (KV takes
 * one write per key per second, so a move followed by an update of the same
 * key could lose the update), and `beforeWrite` sees the merged record before
 * anything is written and may throw to refuse the whole move (the credential
 * guard), so nothing moves when it refuses.
 */
export interface MigrateOptions {
  patch?: RoutePatch | undefined;
  beforeWrite?: ((merged: KVRouteConfig, existing: KVRouteConfig) => void) | undefined;
}

/**
 * Migrate a route from one path to another, optionally applying an update in
 * the same single write at the new key ({@link MigrateOptions}).
 * Preserves createdAt timestamp for audit trail continuity
 * Returns the migrated route config, or null if oldPath not found (`beforeWrite`
 * receives the record as it was)
 * Throws error if newPath already exists or paths are the same; a patch over
 * its field caps, or a merged record over the key or size limit, is refused
 * (RouteWriteRefusedError) before anything is written
 */
export async function migrateRoute(
  kv: KVNamespace,
  domain: string,
  oldPath: string,
  newPath: string,
  { patch, beforeWrite }: MigrateOptions = {},
): Promise<KVRouteConfig | null> {
  const normalizedOldPath = normalizePath(oldPath);
  const normalizedNewPath = normalizePath(newPath);

  // Validate paths are different
  if (normalizedOldPath === normalizedNewPath) {
    throw new Error('Old path and new path cannot be the same');
  }

  // Get existing route at oldPath; an unreadable record is never moved
  const existing = presentRoute(await readStateOrThrow(kv, routeKey(domain, normalizedOldPath)));
  if (!existing) {
    return null;
  }

  // Check if newPath already exists; an unreadable record there is present
  // too, and is never overwritten
  const atNew = await readStateOrThrow(kv, routeKey(domain, normalizedNewPath));
  if (atNew.status === 'invalid') throw new InvalidStoredRouteError();
  if (atNew.status === 'ok') {
    throw new Error(`Route already exists at path: ${normalizedNewPath}`);
  }

  const oldKey = routeKey(domain, normalizedOldPath);
  const newKey = routeKey(domain, normalizedNewPath);

  // The moved record, with the patch merged as an update merges it, preserved
  // createdAt; the patch's own fields against their caps, the merged record
  // against the key and size limits, all before anything is written
  const migratedRoute: KVRouteConfig = {
    ...existing,
    ...patch,
    type: patch?.type ?? existing.type,
    target: patch?.target ?? existing.target,
    path: normalizedNewPath,
    createdAt: existing.createdAt, // Preserve original
    updatedAt: Date.now(),
  };
  if (patch) assertWrittenFieldsFit(patch);
  const serialized = serializeStoredRoute(newKey, migratedRoute);
  beforeWrite?.(migratedRoute, existing);

  try {
    // Write to new key first
    await kv.put(newKey, serialized);
    // Delete old key
    await kv.delete(oldKey);
    return migratedRoute;
  } catch (error) {
    // Attempt rollback
    try {
      await kv.delete(newKey);
    } catch {
      /* ignore rollback errors */
    }
    throw new KVWriteError(
      `migrate:${oldKey}->${newKey}`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Transfer a route from one domain to another
 *
 * Preserves all route configuration and original createdAt timestamp.
 * Non-atomic: writes to new domain first, then deletes from old domain.
 */
export async function transferRoute(
  kv: KVNamespace,
  fromDomain: string,
  toDomain: string,
  path: string,
): Promise<KVRouteConfig | null> {
  const normalizedPath = normalizePath(path);

  if (fromDomain === toDomain) {
    throw new Error('Source and destination domains cannot be the same');
  }

  // An unreadable record is never moved, and never overwritten at the target
  const existing = presentRoute(await readStateOrThrow(kv, routeKey(fromDomain, normalizedPath)));
  if (!existing) {
    return null;
  }

  const atTarget = await readStateOrThrow(kv, routeKey(toDomain, normalizedPath));
  if (atTarget.status === 'invalid') throw new InvalidStoredRouteError();
  if (atTarget.status === 'ok') {
    throw new Error(`Route already exists at ${toDomain}:${normalizedPath}`);
  }

  const oldKey = routeKey(fromDomain, normalizedPath);
  const newKey = routeKey(toDomain, normalizedPath);

  const transferredRoute: KVRouteConfig = {
    ...existing,
    path: normalizedPath,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  const serialized = serializeStoredRoute(newKey, transferredRoute);

  try {
    await kv.put(newKey, serialized);
    await kv.delete(oldKey);
    return transferredRoute;
  } catch (error) {
    throw new KVWriteError(newKey, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Find all R2-type routes that serve a specific R2 object.
 * Used by storage edit dialog (associated routes) and cache purge.
 * Returns routes with domain field included. A record that cannot be read has
 * no target anyone can know, so it serves no object and is not returned; a
 * KV read failure throws (KVReadError), never a shorter answer.
 *
 * Performance: O(n) full KV scan via listAllDomainRoutes(). Acceptable for
 * admin-frequency operations (edit popup, cache purge). If route count grows to
 * thousands, consider a D1 reverse index or KV metadata-based filtering.
 */
export async function findRoutesByR2Target(
  kv: KVNamespace,
  bucket: string,
  target: string,
): Promise<KVRouteConfigWithDomain[]> {
  const { routes } = await listAllDomainRoutes(kv);
  return routes.filter(
    route => route.type === 'r2' && route.target === target && (route.bucket || 'files') === bucket,
  );
}

// Re-export parseRouteKey for use by migration scripts
export { parseRouteKey };

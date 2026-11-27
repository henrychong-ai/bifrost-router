import {
  canonicalJson,
  type InvalidRouteRow,
  isPreviewImageBucket,
  MAX_CACHE_CONTROL_LENGTH,
  MAX_HOST_HEADER_LENGTH,
  MAX_ROUTE_RECORD_BYTES,
  MAX_ROUTE_TARGET_LENGTH,
  r2ObjectId,
  routeR2ObjectId,
} from '@bifrost/shared';
import { HTTPException } from 'hono/http-exception';
import type { KVRouteConfig, SupportedDomain } from '../types';
import { isValidDomain } from '../types';
import type { BoundaryRead } from '../utils/boundary';
import { CodedHTTPException } from '../utils/coded-http-exception';
import { KVDeleteError, KVReadError, KVWriteError } from '../utils/kv-errors';
import { kvListingPage, nextCursor } from '../utils/list-cursor';
import { normalizePath } from './lookup';
import {
  applyPreviewPatch,
  normalizeNewPreview,
  type PreviewImageSize,
  type PreviewWriteFields,
} from './route-preview';
import {
  type CreateRouteInput,
  domainPrefix,
  fitsKvKey,
  isRouteKey,
  parseRouteKey,
  routeKey,
} from './schema';
import { readRouteState, readRouteStates } from './stored-route';

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

/** The fixed message of {@link RouteSourceChangedError}. */
export const ROUTE_SOURCE_CHANGED_MESSAGE =
  'The route changed while this request was running. Nothing was moved; read it again and retry.';

/**
 * A migrate or transfer whose source record is no longer the record its
 * handler checked (v1.38.0): a fixed 409 `{ success: false, error:
 * 'ROUTE_SOURCE_CHANGED', message }`. KV has no compare-and-set, so a source
 * replaced between the handler's read and the write is refused, never re-read
 * and moved in place of the record the guard and the audit row examined.
 */
export class RouteSourceChangedError extends CodedHTTPException {
  constructor(message: string = ROUTE_SOURCE_CHANGED_MESSAGE) {
    super(409, 'ROUTE_SOURCE_CHANGED', message);
    this.name = 'RouteSourceChangedError';
  }
}

/**
 * The fixed message of a {@link RouteSourceChangedError} for an edit
 * (v1.39.0); it quotes no route field.
 */
export const ROUTE_CHANGED_DURING_EDIT_MESSAGE =
  'This route changed while it was being edited, so nothing was saved. Reload it and try again.';

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

/**
 * A new route's fields: the create input plus, when it names a preview
 * image, the size the handler read from that image (v1.48.0).
 */
export type NewRouteRecord = CreateRouteInput & Partial<PreviewImageSize>;

/** A new route record as createRoute stores it. */
function buildNewRoute(input: NewRouteRecord, normalizedPath: string, now: number): KVRouteConfig {
  return {
    // Link-preview fields (v1.48.0): sanitised, empty values dropped, the
    // image size kept only beside an image
    ...normalizeNewPreview(input),
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

/** A readable route a scan found: its exact KV key, the key's domain, and the record. */
export interface ScannedRoute {
  key: string;
  domain: string;
  route: KVRouteConfig;
}

/**
 * Every stored route of `domain`, or of every supported domain when it is
 * undefined (no prefix; the domain is parsed from each key), with a row for
 * each record that cannot be read (v1.38.0). Each page's route keys are read
 * in bulk, one KV operation per 100 keys (`readRouteStates`, v1.48.0), so a
 * scan of 1,000 routes costs about 11 KV operations instead of about 1,001.
 * Only route-shaped keys `{domain}:/…` are read, and in the all-domains scan
 * only those of a supported domain: the namespace also holds `qr:` records and, with the optional rate limiter,
 * `ratelimit:` entries (client IP addresses), none of which may be read, or
 * logged by the invalid-record line, as a route. A KV read failure for any
 * key fails the whole scan (KVReadError): a route is never silently left out.
 */
export async function scanRoutes(
  kv: KVNamespace,
  domain?: string,
): Promise<{ routes: ScannedRoute[]; invalid: InvalidRouteRow[] }> {
  try {
    const scan: { routes: ScannedRoute[]; invalid: InvalidRouteRow[] } = {
      routes: [],
      invalid: [],
    };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const result = await kv.list({
        ...(domain !== undefined && { prefix: domainPrefix(domain) }),
        ...(cursor !== undefined && { cursor }),
      });
      const keys: Array<{ key: string; domain: string }> = [];
      for (const { name } of result.keys) {
        if (!isRouteKey(name)) continue;
        const [keyDomain] = parseRouteKey(name);
        if (domain !== undefined || isValidDomain(keyDomain)) {
          keys.push({ key: name, domain: keyDomain });
        }
      }
      const reads = await readRouteStates(
        kv,
        keys.map(({ key }) => key),
      );
      // Told apart by the read's own status, never by a field of the record,
      // in listing order
      for (const entry of keys) {
        const read = reads.get(entry.key);
        if (read?.status === 'ok') scan.routes.push({ ...entry, route: read.value });
        else if (read?.status === 'invalid') scan.invalid.push(invalidRow(entry.key));
      }
      cursor = nextCursor(kvListingPage(result), seenCursors);
    } while (cursor);
    return scan;
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError(
      domain === undefined ? 'list:all' : `list:${domain}`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Every stored route of a domain, by prefix listing (v1.38.0: with a row for
 * each record that cannot be read), each record as stored. Throws
 * KVReadError on failure.
 */
export async function listDomainRoutes(
  kv: KVNamespace,
  domain: string,
): Promise<RouteListing<KVRouteConfig>> {
  const scan = await scanRoutes(kv, domain);
  return { routes: scan.routes.map(({ route }) => route), invalid: scan.invalid };
}

/**
 * Route configuration with domain field (for all-domains queries)
 */
export type KVRouteConfigWithDomain = KVRouteConfig & {
  domain: SupportedDomain;
};

/**
 * Every stored route of every supported domain (no prefix; the domain is
 * parsed from each key and added), each record as stored, with a row for each
 * record that cannot be read (v1.38.0). Throws KVReadError on failure.
 */
export async function listAllDomainRoutes(
  kv: KVNamespace,
): Promise<RouteListing<KVRouteConfigWithDomain>> {
  const scan = await scanRoutes(kv);
  return {
    // The all-domains scan keeps supported domains only
    routes: scan.routes.map(({ domain, route }) => ({
      ...route,
      domain: domain as SupportedDomain,
    })),
    invalid: scan.invalid,
  };
}

/**
 * A scanned route as a listing shows it (v1.48.0): named by the path of its
 * KV key, where it is served, never by the record's own `path` field, which a
 * record written outside the API could hold differently.
 */
export function routeAtKeyPath(entry: ScannedRoute): KVRouteConfig {
  return { ...entry.route, path: parseRouteKey(entry.key)[1] };
}

/**
 * Create a new route
 * Throws KVWriteError on failure
 */
export async function createRoute(
  kv: KVNamespace,
  domain: string,
  input: NewRouteRecord,
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
type RouteFieldPatch = {
  [K in Exclude<keyof CreateRouteInput, keyof PreviewWriteFields>]?:
    | CreateRouteInput[K]
    | undefined;
};

/**
 * A route patch as the write paths apply it: the update fields, the
 * link-preview fields (a video size that `null` clears) and the
 * server-derived preview image size (v1.48.0).
 */
export type RoutePatch = RouteFieldPatch & PreviewWriteFields;

/**
 * A stored route with an update merged in (v1.38.0): the ONE merge behind
 * {@link updateRoute} and {@link migrateRoute}, so a PUT and a path-change
 * edit store the same record. The patch's fields replace the stored ones;
 * every field it leaves out (or carries as `undefined`) keeps its stored
 * value, the type and target included. `path` is the record's key path,
 * `createdAt` is kept and `updatedAt` is now. The patch's own fields are
 * checked against their caps ({@link RouteWriteRefusedError}); the caller
 * checks the merged record's size as it serialises it.
 */
export function mergeRoutePatch(
  existing: KVRouteConfig,
  patch: RoutePatch,
  path: string,
): KVRouteConfig {
  assertWrittenFieldsFit(patch);
  return {
    ...applyRoutePatch(existing, patch),
    path,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
}

/**
 * A stored route with a patch's fields applied, path and timestamps
 * unchanged (v1.48.0): the one definition the update and migrate handlers
 * check the preview rules on, and {@link mergeRoutePatch} writes. The patch's
 * fields replace the stored ones; every field it leaves out (or carries as
 * `undefined`) keeps its stored value. Preview fields:
 * {@link applyPreviewPatch} (sanitised; an empty title clears them all, an
 * empty image bucket or key the whole image, `null` a video size).
 */
export function applyRoutePatch(existing: KVRouteConfig, patch: RoutePatch): KVRouteConfig {
  const updated = {
    ...existing,
    ...patch,
    // A stored route always has a type and a target. A patch that leaves either
    // out keeps the stored value, as the spread alone already did; writing them
    // out also keeps it when the key is present but `undefined`.
    type: patch.type ?? existing.type,
    target: patch.target ?? existing.target,
  } as KVRouteConfig;
  applyPreviewPatch(updated, patch);
  return updated;
}

/**
 * Update an existing route
 * Returns null if not found, throws KVWriteError on failure
 *
 * `checked` (v1.39.0, the migrate/transfer pattern) is the record the caller
 * read and checked (its credential guard, its audit "before"): the patch is
 * merged into IT, and a stored record that is no longer it is refused
 * ({@link RouteSourceChangedError}, 409 `ROUTE_SOURCE_CHANGED`, nothing
 * written), so the write never carries a record no check saw. Best effort,
 * not a lock: KV has no compare-and-set, and the second read is usually
 * served from the same edge cache as the first, so a concurrent change is
 * seen only when it has reached this location; one that lands after this
 * read is not seen at all. Without `checked`, the patch merges into whatever
 * is stored.
 */
export async function updateRoute(
  kv: KVNamespace,
  domain: string,
  path: string,
  updates: RoutePatch,
  checked?: KVRouteConfig,
): Promise<KVRouteConfig | null> {
  const normalizedPath = normalizePath(path);
  const key = routeKey(domain, normalizedPath);
  // Never merged with a record that cannot be read: 409, delete and recreate
  const stored = presentRoute(await readStateOrThrow(kv, key));
  if (!stored) return null;
  if (checked !== undefined && canonicalJson(stored) !== canonicalJson(checked)) {
    throw new RouteSourceChangedError(ROUTE_CHANGED_DURING_EDIT_MESSAGE);
  }
  const existing = checked ?? stored;

  // Path cannot be changed. The patch's own fields against their caps; the
  // merged record as it will be stored against the key and size limits,
  // checked as it is written
  const updated = mergeRoutePatch(existing, updates, normalizedPath);
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

/** What {@link seedRoutes} did: the routes it wrote and the entries it skipped. */
export interface SeedResult {
  created: number;
  skipped: number;
  /** The input path of each route written, in write order (the API answer's list). */
  createdPaths: string[];
  /**
   * The stored (normalised) path of each route written, in write order
   * (v1.47.0): the seed audit row lists exactly these.
   */
  createdStoredPaths: string[];
}

/**
 * A write that failed part-way through a seed (v1.47.0): `error` is the
 * failure as thrown (the caller answers with it unchanged) and `partial` what
 * the seed had done by then, the routes already written included, so the
 * caller can still record them.
 */
export class SeedWriteFailure extends Error {
  constructor(
    readonly error: Error,
    readonly partial: SeedResult,
  ) {
    super('A seed write failed part-way');
    this.name = 'SeedWriteFailure';
  }
}

/**
 * Seed routes from an array (useful for migration). Returns the counts and
 * the paths of the routes it wrote, in write order. A write that fails throws
 * {@link SeedWriteFailure}, carrying the original error (a `KVWriteError`)
 * and the routes written before it.
 *
 * `checkWrites`, when given, runs ONCE on exactly the entries that will be
 * written (after the dedupe and the existence reads, before any write), in
 * write order; it refuses the whole seed by throwing, with nothing written
 * (v1.47.0: the credential-target acknowledgement covers only the routes a
 * seed creates). It is never given a skipped entry. It answers the records to
 * write, in the same order: the ones it was given, or the same records
 * completed (v1.48.0: the preview rules are checked and each preview image
 * measured on exactly this set), each checked again against the key and size
 * limits before anything is written.
 *
 * Known limit: the check and the writes are decided by the same single
 * existence read per key. KV has no compare-and-set, so a route created
 * elsewhere after that read, before this seed's write, is overwritten, and
 * the check never saw it as existing.
 */
export async function seedRoutes(
  kv: KVNamespace,
  domain: string,
  routes: NewRouteRecord[],
  checkWrites?: (toWrite: NewRouteRecord[]) => NewRouteRecord[] | Promise<NewRouteRecord[]>,
): Promise<SeedResult> {
  let created = 0;
  let skipped = 0;
  // The paths that were actually written, so a caller can audit what it
  // changed rather than what it submitted.
  const createdPaths: string[] = [];
  const createdStoredPaths: string[] = [];

  // Every record is built and checked before anything is written, so one
  // that is too large refuses the whole batch with nothing stored, naming its
  // path (v1.37.2). Entries that normalise to a key already queued in this
  // batch are skipped, the first winning, exactly like an existing key.
  const now = Date.now();
  const queued = new Set<string>();
  const built: Array<{
    route: NewRouteRecord;
    storedPath: string;
    key: string;
    serialized: string;
  }> = [];
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
    built.push({ route, storedPath: normalizedPath, key, serialized });
  }

  // Each existence check reads exactly the key about to be written, so an
  // alias of a stored path is SKIPPED rather than silently overwriting the
  // record it aliases; a record that cannot be read is present too, and is
  // never overwritten (v1.38.0). The reads are independent.
  const existing = await Promise.all(built.map(entry => readStateOrThrow(kv, entry.key)));
  const toWrite = built.filter((_entry, index) => existing[index]?.status === 'missing');
  skipped += built.length - toWrite.length;
  if (checkWrites) {
    // The check may complete the records it is given (v1.48.0: the measured
    // preview image size), in the same order; each is checked again exactly
    // as it will be stored
    const prepared = await checkWrites(toWrite.map(entry => entry.route));
    for (const [index, entry] of toWrite.entries()) {
      const route = prepared[index];
      if (route === undefined || route === entry.route) continue;
      try {
        entry.serialized = serializeCheckedRoute(
          entry.key,
          buildNewRoute(route, entry.storedPath, now),
        );
      } catch (error) {
        if (error instanceof RouteWriteRefusedError) {
          throw new RouteWriteRefusedError(error.refusal, route.path);
        }
        throw error;
      }
      entry.route = route;
    }
  }

  for (const { route, storedPath, key, serialized } of toWrite) {
    try {
      await kv.put(key, serialized);
    } catch (error) {
      throw new SeedWriteFailure(
        new KVWriteError(key, error instanceof Error ? error : new Error(String(error))),
        {
          created,
          skipped,
          createdPaths: [...createdPaths],
          createdStoredPaths: [...createdStoredPaths],
        },
      );
    }
    created++;
    createdPaths.push(route.path);
    createdStoredPaths.push(storedPath);
  }

  return { created, skipped, createdPaths, createdStoredPaths };
}

/**
 * The source record a move was checked against (v1.38.0): its handler's own
 * read, the record the credential guard, the merge and the audit row used.
 * The KV layer only confirms it, never reads a replacement in its place:
 * `missing` when it has gone (the caller answers 404), or a throw when it is
 * unreadable ({@link InvalidStoredRouteError}) or no longer the same record,
 * compared as canonical JSON ({@link RouteSourceChangedError}). Without a
 * `source`, the record read here is the one moved.
 */
async function confirmSource(
  kv: KVNamespace,
  key: string,
  source: KVRouteConfig | undefined,
): Promise<KVRouteConfig | null> {
  const found = presentRoute(await readStateOrThrow(kv, key));
  if (found === null || source === undefined) return found;
  if (canonicalJson(found) !== canonicalJson(source)) throw new RouteSourceChangedError();
  return source;
}

/**
 * What {@link migrateRoute} may do besides the move (v1.38.0): `source` is
 * the record the caller checked (confirmed before anything is written, see
 * {@link confirmSource}), and `patch` an update applied to the moved record
 * with {@link mergeRoutePatch}, written ONCE at the new key (KV takes one
 * write per key per second, so a move followed by an update of the same key
 * could lose the update).
 */
export interface MigrateOptions {
  source?: KVRouteConfig | undefined;
  patch?: RoutePatch | undefined;
}

/**
 * Migrate a route from one path to another, optionally applying an update in
 * the same single write at the new key ({@link MigrateOptions}).
 * Preserves createdAt timestamp for audit trail continuity
 * Returns the migrated route config, or null if oldPath not found (or the
 * checked `source` has gone)
 * Throws error if newPath already exists or paths are the same (before any
 * read); a source replaced since the caller read it is refused
 * (RouteSourceChangedError), and a patch over its field caps, or a merged
 * record over the key or size limit (RouteWriteRefusedError), before anything
 * is written
 */
export async function migrateRoute(
  kv: KVNamespace,
  domain: string,
  oldPath: string,
  newPath: string,
  { source, patch }: MigrateOptions = {},
): Promise<KVRouteConfig | null> {
  const normalizedOldPath = normalizePath(oldPath);
  const normalizedNewPath = normalizePath(newPath);

  // Validate paths are different
  if (normalizedOldPath === normalizedNewPath) {
    throw new Error('Old path and new path cannot be the same');
  }

  const oldKey = routeKey(domain, normalizedOldPath);
  const newKey = routeKey(domain, normalizedNewPath);

  // The record at oldPath, confirmed as the caller's; an unreadable record is
  // never moved
  const existing = await confirmSource(kv, oldKey, source);
  if (!existing) {
    return null;
  }

  // Check if newPath already exists; an unreadable record there is present
  // too, and is never overwritten
  const atNew = await readStateOrThrow(kv, newKey);
  if (atNew.status === 'invalid') throw new InvalidStoredRouteError();
  if (atNew.status === 'ok') {
    throw new Error(`Route already exists at path: ${normalizedNewPath}`);
  }

  // The moved record, with the patch merged as an update merges it, preserved
  // createdAt; the merged record against the key and size limits, all before
  // anything is written
  const migratedRoute = mergeRoutePatch(existing, patch ?? {}, normalizedNewPath);
  const serialized = serializeStoredRoute(newKey, migratedRoute);

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
 * `source` is the record the caller checked, confirmed as for a migrate
 * ({@link confirmSource}); null when it has gone.
 */
export async function transferRoute(
  kv: KVNamespace,
  fromDomain: string,
  toDomain: string,
  path: string,
  source?: KVRouteConfig,
): Promise<KVRouteConfig | null> {
  const normalizedPath = normalizePath(path);

  if (fromDomain === toDomain) {
    throw new Error('Source and destination domains cannot be the same');
  }

  const oldKey = routeKey(fromDomain, normalizedPath);
  const newKey = routeKey(toDomain, normalizedPath);

  // An unreadable record is never moved, and never overwritten at the target
  const existing = await confirmSource(kv, oldKey, source);
  if (!existing) {
    return null;
  }

  const atTarget = await readStateOrThrow(kv, newKey);
  if (atTarget.status === 'invalid') throw new InvalidStoredRouteError();
  if (atTarget.status === 'ok') {
    throw new Error(`Route already exists at ${toDomain}:${normalizedPath}`);
  }

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
 * A route that uses an R2 object: as the file it serves (`file`), or as its
 * link-preview image (`preview-image`, v1.48.0). `previewImage: true` marks
 * every route that shows the object as its link-preview image, including one
 * that also serves it (`usage: 'file'`).
 */
export type R2TargetRoute = KVRouteConfigWithDomain & {
  usage: 'file' | 'preview-image';
  previewImage?: true;
};

/**
 * Every readable route, named by the domain AND path of its KV key, where it
 * is served (v1.48.0), never by the record's own `path` field: the list
 * {@link findRoutesByR2Target} matches over. One scan. Throws KVReadError on
 * failure.
 */
export async function scanRoutesByKey(kv: KVNamespace): Promise<KVRouteConfigWithDomain[]> {
  return (await scanRoutes(kv)).routes.map(entry => ({
    ...routeAtKeyPath(entry),
    // The all-domains scan keeps supported domains only
    domain: entry.domain as SupportedDomain,
  }));
}

/**
 * The routes of `allRoutes` (from {@link scanRoutesByKey}) that use the
 * object `target` in `bucket`, labelled by `usage`, as
 * {@link findRoutesByR2Target} answers; a caller that already holds a scan
 * (the R2 event consumer, one scan per batch) matches without a second one.
 *
 * Serving: one definition of "serves this object" with the dashboard
 * (`routeR2ObjectId`, v1.41.1). The preview image: the route's image bucket
 * is one that may hold a preview image (`isPreviewImageBucket`), with the
 * same bucket and key: the ONE rule the preview-image refusal and Storage's
 * associated routes share. A stored `previewImage` field (written outside the
 * API) never reaches the answer: the flag is derived, never read.
 */
export function matchRoutesByR2Target(
  allRoutes: readonly KVRouteConfigWithDomain[],
  bucket: string,
  target: string,
): R2TargetRoute[] {
  const wanted = r2ObjectId(bucket, target);
  const found: R2TargetRoute[] = [];
  for (const stored of allRoutes) {
    if (stored.type !== 'r2') continue;
    const { previewImage: _storedFlag, ...route } = stored as KVRouteConfigWithDomain & {
      previewImage?: unknown;
    };
    const namesImage =
      typeof route.previewImageBucket === 'string' &&
      route.previewImageBucket === bucket &&
      isPreviewImageBucket(route.previewImageBucket) &&
      route.previewImageKey === target;
    const flag = namesImage ? { previewImage: true as const } : {};
    if (routeR2ObjectId(route) === wanted) {
      found.push({ ...route, usage: 'file', ...flag });
    } else if (namesImage) {
      found.push({ ...route, usage: 'preview-image', ...flag });
    }
  }
  return found;
}

/**
 * Find all R2-type routes that use a specific R2 object: those serving it
 * and those showing it as their link-preview image (v1.48.0), each labelled
 * with its `usage` and named by the domain and path of its KV key. Used by
 * Storage's associated routes, the cache purge (which keeps `usage: 'file'`
 * only) and the preview-image refusal. A record that cannot be read has no
 * target anyone can know, so it uses no object and is not returned; a KV read
 * failure throws (KVReadError), never a shorter answer.
 *
 * Performance: O(n) full KV scan, read in bulk. Acceptable for
 * admin-frequency operations (edit popup, cache purge). If route count grows to
 * thousands, consider a D1 reverse index or KV metadata-based filtering.
 */
export async function findRoutesByR2Target(
  kv: KVNamespace,
  bucket: string,
  target: string,
): Promise<R2TargetRoute[]> {
  return matchRoutesByR2Target(await scanRoutesByKey(kv), bucket, target);
}

// Re-export parseRouteKey for use by migration scripts
export { parseRouteKey };

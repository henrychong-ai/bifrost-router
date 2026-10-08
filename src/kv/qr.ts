import {
  type InvalidQRRow,
  MAX_QR_RECORD_BYTES,
  matchesSearchFields,
  parseSearchQuery,
  parseStoredQR as parseSharedStoredQR,
  type QRCode,
  type QRListQuery,
  qrMatchesListFilters,
  StoredQRCodeSchema,
} from '@bifrost/shared';
import { HTTPException } from 'hono/http-exception';
import { type BoundaryRead, logInvalidBoundary, readKvJson } from '../utils/boundary';
import { errorName } from '../utils/error-name';
import { KVDeleteError, KVReadError, KVWriteError } from '../utils/kv-errors';
import { kvListingPage, nextCursor } from '../utils/list-cursor';
import { readRecentQRWrites } from './qr-recent';
import { qrDomainPrefix, qrKey } from './schema';

/**
 * KV CRUD for QR code records.
 *
 * Key format `qr:{domain}:{id}` — see schema.ts. Mirrors src/kv/routes.ts:
 * mechanical storage operations only; existence conflicts, payload validation,
 * type immutability, and audit logging are the route handlers' concern
 * (src/routes/qr.ts).
 */

/** The fixed refusal of a QR write over {@link MAX_QR_RECORD_BYTES} (v1.37.2). */
export const QR_RECORD_TOO_LARGE = 'QR record is too large';

/**
 * A stored QR record validated and normalised, or null (v1.38.0). The one
 * read shape lives in `@bifrost/shared` (`parseStoredQR`), so the Worker and
 * the dashboard accept exactly the same records: the write schemas minus
 * their length and count caps (formats, types and ranges as on write),
 * keeping only the fields a record defines. Re-exported here for the Worker's
 * callers. `test/kv/qr-boundary.test.ts` checks that every record the write
 * schema produces passes.
 */
export const parseStoredQR = parseSharedStoredQR;

/**
 * Read one QR value as text and validate it locally (v1.38.0; KV's `'json'`
 * read threw the parser's SyntaxError, which can quote the value, Wi-Fi
 * passwords and contact cards included). A value that is not JSON or not a QR
 * record is `invalid`, with one fixed log line (category `qr`, naming the key;
 * ids are not secret), never the value. KV errors pass through.
 */
async function readQRState(kv: KVNamespace, key: string): Promise<BoundaryRead<QRCode>> {
  // The shared read schema itself, no wrapper: the normalised record, or invalid
  const read = await readKvJson(kv, key, StoredQRCodeSchema);
  if (read.status === 'invalid') logInvalidBoundary('qr', key);
  return read;
}

/**
 * A QR code's stored state (v1.38.0): `missing`, `ok` with the record, or
 * `invalid` (a record is stored but cannot be read, logged once), never
 * collapsed: a read or an update answers 409 `QR_RECORD_INVALID` for it, a
 * create with its id 409 too, and delete removes it. Throws KVReadError on a
 * KV failure.
 */
export async function getQR(
  kv: KVNamespace,
  domain: string,
  id: string,
): Promise<BoundaryRead<QRCode>> {
  const key = qrKey(domain, id);
  try {
    return await readQRState(kv, key);
  } catch (error) {
    throw new KVReadError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Persist a QR record. The caller has already checked for an existing id
 * (QR_ALREADY_EXISTS is a handler-level concern) and built the full record
 * (timestamps, defaults applied via the shared schemas).
 * Throws KVWriteError on failure.
 */
export async function putQR(kv: KVNamespace, record: QRCode): Promise<QRCode> {
  const key = qrKey(record.domain, record.id);
  // The exact record, checked immediately before it is written (v1.37.2): a
  // record over the cap would stop every nightly backup
  const serialized = JSON.stringify(record);
  if (new TextEncoder().encode(serialized).byteLength > MAX_QR_RECORD_BYTES) {
    throw new HTTPException(400, { message: QR_RECORD_TOO_LARGE });
  }
  try {
    await kv.put(key, serialized);
  } catch (error) {
    throw new KVWriteError(key, error instanceof Error ? error : new Error(String(error)));
  }
  return record;
}

/**
 * Delete a QR record, also one that cannot be read (deleting it is the
 * recovery). Answers the state it found, read once: `missing` (nothing
 * deleted), or the `ok` record or `invalid` state it deleted, for the
 * caller's audit row. Throws KVReadError or KVDeleteError on a KV failure.
 */
export async function deleteQR(
  kv: KVNamespace,
  domain: string,
  id: string,
): Promise<BoundaryRead<QRCode>> {
  const state = await getQR(kv, domain, id);
  if (state.status === 'missing') return state;

  const key = qrKey(domain, id);
  try {
    await kv.delete(key);
    return state;
  } catch (error) {
    throw new KVDeleteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Result shape for {@link listQRs} — total reflects the FILTERED count, before
 * the offset/limit slice (mirrors GET /api/routes meta semantics).
 */
export interface QRListResult {
  items: Array<QRCode | InvalidQRRow>;
  total: number;
}

/**
 * List QR records for a domain with in-memory filtering + offset/limit paging.
 *
 * Prefix scan over `qr:{domain}:` with a cursor loop (the routes listing's
 * pattern). QR volumes are small (tens per domain), so fetch-then-filter is
 * fine — the same trade-off the routes listing makes.
 *
 * Filters: `type` exact; `tag` exact membership; `search` the shared matcher
 * (case and separators ignored, words in any order, v1.38.0) over description
 * AND id — `qrMatchesListFilters`, the predicate the dashboard's QR store
 * applies too, with the query parsed once for the list. Sorted by updatedAt
 * descending for a stable, recency-first listing. When `limit` is undefined,
 * returns ALL filtered items (offset still applies) — mirroring the routes
 * listing's paginate-only-when-limit-provided semantics.
 *
 * A record that cannot be read is listed as a minimal row (`{ domain, id,
 * invalid: true }`, v1.38.0) so it can be found and deleted: it matches a
 * search by its id only, matches no type or tag filter, and sorts last.
 */
export async function listQRs(
  kv: KVNamespace,
  domain: string,
  query: Pick<QRListQuery, 'type' | 'tag' | 'search' | 'offset' | 'limit'> = { offset: 0 },
): Promise<QRListResult> {
  const prefix = qrDomainPrefix(domain);
  const records: QRCode[] = [];
  const invalid: InvalidQRRow[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  try {
    do {
      const result = await kv.list({ prefix, ...(cursor !== undefined && { cursor }) });
      const keys = result.keys.map(key => key.name);
      const fetched = await Promise.all(keys.map(key => readQRState(kv, key)));
      for (const [index, read] of fetched.entries()) {
        if (read.status === 'ok') records.push(read.value);
        else if (read.status === 'invalid') {
          invalid.push({ domain, id: (keys[index] ?? prefix).slice(prefix.length), invalid: true });
        }
      }
      cursor = nextCursor(kvListingPage(result), seenCursors);
    } while (cursor);
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError(
      `list:${prefix}`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // Codes written in the last two minutes that the lagging listing lacks
  // (v1.40.0): read by key, which sees a write at once at this location. Best
  // effort, outside the listing's own error handling: an id whose read fails
  // is skipped and logged by error class, so a transient KV failure here
  // never fails the listing (the code shows once KV's listing catches up)
  const listed = new Set([...records.map(qr => qr.id), ...invalid.map(row => row.id)]);
  const unlisted = (await readRecentQRWrites(kv, domain))
    .map(write => write.id)
    .filter(id => !listed.has(id));
  const recent = await Promise.all(
    unlisted.map(async id => {
      try {
        return await readQRState(kv, qrKey(domain, id));
      } catch (error) {
        console.warn(`[QR] A recent code could not be read: ${errorName(error)}`);
        return { status: 'missing' } as const;
      }
    }),
  );
  for (const [index, read] of recent.entries()) {
    if (read.status === 'ok') records.push(read.value);
    else if (read.status === 'invalid') {
      invalid.push({ domain, id: unlisted[index] ?? '', invalid: true });
    }
  }

  // Same predicate as the dashboard's QR store (shared), the query parsed once
  const filters = { ...query, search: parseSearchQuery(query.search) };
  const filtered = records.filter(qr => qrMatchesListFilters(qr, filters));
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  const unreadable =
    query.type || query.tag
      ? []
      : invalid.filter(row => matchesSearchFields([row.id], filters.search));
  const rows: Array<QRCode | InvalidQRRow> = [...filtered, ...unreadable];

  const offset = query.offset ?? 0;
  const items =
    query.limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + query.limit);

  return { items, total: rows.length };
}

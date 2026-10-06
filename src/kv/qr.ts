import {
  MAX_QR_RECORD_BYTES,
  parseStoredQR as parseSharedStoredQR,
  type QRCode,
  type QRListQuery,
  qrMatchesListFilters,
} from '@bifrost/shared';
import { HTTPException } from 'hono/http-exception';
import {
  type BoundaryRead,
  logInvalidBoundary,
  readKvJson,
  type Validator,
} from '../utils/boundary';
import {
  KVDeleteError,
  KVReadError,
  type KVResult,
  KVWriteError,
  withKVErrorHandling,
} from '../utils/kv-errors';
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
 * the dashboard accept exactly the same records: a structural check of every
 * field a reader consumes, tolerant of records written under earlier limits,
 * keeping only the fields a record defines. Re-exported here for the Worker's
 * callers. `test/kv/qr-boundary.test.ts` checks that every record the write
 * schema produces passes.
 */
export const parseStoredQR = parseSharedStoredQR;

/** Whether `value` is a stored QR record (parseStoredQR accepts it). */
export function isStoredQR(value: unknown): boolean {
  return parseStoredQR(value) !== null;
}

/** The validator readKvJson takes: the normalised record, or invalid. */
const storedQR: Validator<QRCode> = {
  safeParse: value => {
    const record = parseStoredQR(value);
    return record === null ? { success: false } : { success: true, data: record };
  },
};

/**
 * Read one QR value as text and validate it locally (v1.38.0; KV's `'json'`
 * read threw the parser's SyntaxError, which can quote the value, Wi-Fi
 * passwords and contact cards included). A value that is not JSON or not a QR
 * record is `invalid`, with one fixed log line (category `qr`, naming the key;
 * ids are not secret), never the value. KV errors pass through.
 */
async function readQRState(kv: KVNamespace, key: string): Promise<BoundaryRead<QRCode>> {
  const read = await readKvJson(kv, key, storedQR);
  if (read.status === 'invalid') logInvalidBoundary('qr', key);
  return read;
}

async function readQRValue(kv: KVNamespace, key: string): Promise<QRCode | null> {
  const read = await readQRState(kv, key);
  return read.status === 'ok' ? read.value : null;
}

/**
 * A QR code's stored state (v1.38.0): `missing`, `ok` with the record, or
 * `invalid` (a record that cannot be read). Delete and create use it, so an
 * unreadable record is present: it can be deleted, and a create never
 * overwrites it. Throws KVReadError on failure.
 */
export async function getQRState(
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
 * Get a single QR record by domain and id. Returns null if not found.
 * Throws KVReadError on failure.
 */
export async function getQR(kv: KVNamespace, domain: string, id: string): Promise<QRCode | null> {
  const key = qrKey(domain, id);
  try {
    return await readQRValue(kv, key);
  } catch (error) {
    throw new KVReadError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Non-throwing variant of {@link getQR} (mirrors getRouteSafe).
 */
export async function getQRSafe(
  kv: KVNamespace,
  domain: string,
  id: string,
): Promise<KVResult<QRCode | null>> {
  const key = qrKey(domain, id);
  return withKVErrorHandling(
    () => readQRValue(kv, key),
    cause => new KVReadError(key, cause),
  );
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
    return record;
  } catch (error) {
    throw new KVWriteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Delete a QR record. Returns false if it did not exist.
 * Throws KVDeleteError on failure.
 */
export async function deleteQR(kv: KVNamespace, domain: string, id: string): Promise<boolean> {
  // An unreadable record is present: deleting it is the recovery
  if ((await getQRState(kv, domain, id)).status === 'missing') return false;

  const key = qrKey(domain, id);
  try {
    await kv.delete(key);
    return true;
  } catch (error) {
    throw new KVDeleteError(key, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Result shape for {@link listQRs} — total reflects the FILTERED count, before
 * the offset/limit slice (mirrors GET /api/routes meta semantics).
 */
export interface QRListResult {
  items: QRCode[];
  total: number;
}

/**
 * List QR records for a domain with in-memory filtering + offset/limit paging.
 *
 * Prefix scan over `qr:{domain}:` with a cursor loop (same pattern as
 * getAllRoutes). QR volumes are small (tens per domain), so fetch-then-filter
 * is fine — the same trade-off the routes listing makes.
 *
 * Filters: `type` exact; `tag` exact membership; `search` the shared matcher
 * (case and separators ignored, words in any order, v1.38.0) over description
 * AND id — `qrMatchesListFilters`, the predicate the dashboard's QR store
 * applies too. Sorted by updatedAt descending for a stable,
 * recency-first listing. When `limit` is undefined, returns ALL filtered items
 * (offset still applies) — mirroring the routes listing's
 * paginate-only-when-limit-provided semantics.
 */
export async function listQRs(
  kv: KVNamespace,
  domain: string,
  query: Pick<QRListQuery, 'type' | 'tag' | 'search' | 'offset' | 'limit'> = { offset: 0 },
): Promise<QRListResult> {
  const prefix = qrDomainPrefix(domain);
  const records: QRCode[] = [];
  let cursor: string | undefined;

  try {
    do {
      const result = await kv.list({ prefix, ...(cursor !== undefined && { cursor }) });
      const fetched = await Promise.all(result.keys.map(key => readQRValue(kv, key.name)));
      records.push(...fetched.filter((r): r is QRCode => r !== null));
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
  } catch (error) {
    if (error instanceof KVReadError) throw error;
    throw new KVReadError(
      `list:${prefix}`,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // Same predicate as the dashboard's create reconciliation (shared)
  const filtered = records.filter(qr => qrMatchesListFilters(qr, query));

  filtered.sort((a, b) => b.updatedAt - a.updatedAt);

  const offset = query.offset ?? 0;
  const items =
    query.limit === undefined
      ? filtered.slice(offset)
      : filtered.slice(offset, offset + query.limit);

  return { items, total: filtered.length };
}

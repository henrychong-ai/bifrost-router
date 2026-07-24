import type { QRCode, QRListQuery } from '@bifrost/shared';
import { qrKey, qrDomainPrefix } from './schema';
import {
  KVReadError,
  KVWriteError,
  KVDeleteError,
  type KVResult,
  withKVErrorHandling,
} from '../utils/kv-errors';

/**
 * KV CRUD for QR code records (v1.54.0).
 *
 * Key format `qr:{domain}:{id}` — see schema.ts. Mirrors src/kv/routes.ts:
 * mechanical storage operations only; existence conflicts, payload validation,
 * type immutability, and audit logging are the route handlers' concern
 * (src/routes/qr.ts).
 */

/**
 * Get a single QR record by domain and id. Returns null if not found.
 * Throws KVReadError on failure.
 */
export async function getQR(kv: KVNamespace, domain: string, id: string): Promise<QRCode | null> {
  const key = qrKey(domain, id);
  try {
    return await kv.get<QRCode>(key, 'json');
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
    () => kv.get<QRCode>(key, 'json'),
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
  try {
    await kv.put(key, JSON.stringify(record));
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
  const existing = await getQR(kv, domain, id);
  if (!existing) return false;

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
 * Filters: `type` exact; `tag` exact membership; `search` case-insensitive
 * substring over description AND id. Sorted by updatedAt descending for a stable,
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
      const result = await kv.list({ prefix, cursor });
      const fetched = await Promise.all(result.keys.map(key => kv.get<QRCode>(key.name, 'json')));
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

  const search = query.search?.toLowerCase();
  const filtered = records.filter(qr => {
    if (query.type && qr.type !== query.type) return false;
    if (query.tag && !(qr.tags ?? []).includes(query.tag)) return false;
    if (search) {
      const haystack = [qr.description ?? '', qr.id].map(s => s.toLowerCase());
      if (!haystack.some(field => field.includes(search))) return false;
    }
    return true;
  });

  filtered.sort((a, b) => b.updatedAt - a.updatedAt);

  const offset = query.offset ?? 0;
  const items =
    query.limit === undefined
      ? filtered.slice(offset)
      : filtered.slice(offset, offset + query.limit);

  return { items, total: filtered.length };
}

import {
  MAX_QR_RECORD_BYTES,
  QR_TYPES,
  type QRCode,
  QRDesignSchema,
  type QRListQuery,
  qrMatchesListFilters,
} from '@bifrost/shared';
import { HTTPException } from 'hono/http-exception';
import {
  type BoundaryRead,
  isOptional,
  isRecord,
  isString,
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

const QR_TYPE_SET: ReadonlySet<unknown> = new Set(QR_TYPES);

const isOptionalString = (value: unknown) => isOptional(value, isString);
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/**
 * The payload fields each type's readers use (the serializer and the
 * renderer), with their types: a field a reader needs is required, the rest
 * optional. Structural, not the write schema, so records written under
 * earlier limits stay readable.
 */
const PAYLOAD_SHAPES: Readonly<Record<string, (payload: Record<string, unknown>) => boolean>> = {
  url: payload => isString(payload['url']),
  text: payload => isString(payload['text']),
  wifi: payload =>
    isString(payload['ssid']) &&
    ['auth', 'password', 'eapMethod', 'phase2', 'identity', 'anonymousIdentity'].every(field =>
      isOptionalString(payload[field]),
    ) &&
    isOptional(payload['hidden'], item => typeof item === 'boolean'),
  vcard: payload =>
    isString(payload['name']) &&
    ['phone', 'email', 'org', 'title', 'url'].every(field => isOptionalString(payload[field])),
};

/** The design fields the renderer reads, each of its declared type when present. */
function isDesignShape(design: Record<string, unknown>): boolean {
  return (
    ['fg', 'bg', 'errorCorrection', 'logoDataUri'].every(field =>
      isOptionalString(design[field]),
    ) && ['size', 'margin', 'logoAspectRatio'].every(field => isOptional(design[field], isNumber))
  );
}

/** A stored link: `{domain, path}` with a non-empty domain and a path starting `/`. */
function isLinkShape(link: unknown): boolean {
  return (
    isRecord(link) &&
    isString(link['domain']) &&
    link['domain'] !== '' &&
    isString(link['path']) &&
    link['path'].startsWith('/')
  );
}

/** The default design, computed once. */
const DEFAULT_QR_DESIGN: Readonly<Record<string, unknown>> = QRDesignSchema.parse({});

/**
 * A stored QR record validated and normalised into the shape every reader
 * expects, or null when it is not one (v1.38.0). A structural check, not
 * `QRCodeSchema`: the schema applies today's write limits, which would refuse
 * records written under earlier ones. It checks every field a reader
 * consumes, nested ones included: string `id` and `domain`, a known `type`,
 * numeric `createdAt`/`updatedAt`, the payload fields of that type, the
 * design fields the renderer reads, the linked route's `domain` and `path`,
 * and the optional `description`, `tags` and `createdBy`. Supported legacy
 * forms are normalised: a missing or null `design` becomes the default
 * design (missing or null design fields take their defaults), a Wi-Fi payload
 * without `auth` reads as the write default `WPA`, a linked route keeps only
 * `domain` and `path`, and null optional fields are dropped. The result is
 * returned only after all of that; nothing is written back.
 * `test/kv/qr-boundary.test.ts` checks that every record the write schema
 * produces passes.
 */
export function parseStoredQR(value: unknown): QRCode | null {
  if (!isRecord(value)) return null;
  const { payload, design, linkedRoute } = value;
  if (
    !isString(value['id']) ||
    !isString(value['domain']) ||
    !QR_TYPE_SET.has(value['type']) ||
    !isNumber(value['createdAt']) ||
    !isNumber(value['updatedAt']) ||
    !isRecord(payload) ||
    !(PAYLOAD_SHAPES[String(value['type'])]?.(payload) ?? false) ||
    !isOptional(design, item => isRecord(item) && isDesignShape(item)) ||
    !isOptional(linkedRoute, isLinkShape) ||
    !isOptionalString(value['description']) ||
    !isOptionalString(value['createdBy']) ||
    !isOptional(value['tags'], item => Array.isArray(item) && item.every(isString))
  ) {
    return null;
  }
  const out: Record<string, unknown> = { ...value };
  for (const field of ['description', 'tags', 'createdBy', 'linkedRoute']) {
    if (out[field] === null) delete out[field];
  }
  if (isRecord(linkedRoute)) {
    out['linkedRoute'] = { domain: linkedRoute['domain'], path: linkedRoute['path'] };
  }
  // Missing or null design fields take their defaults (a null spread over a
  // default would replace it)
  const normalisedDesign: Record<string, unknown> = { ...DEFAULT_QR_DESIGN };
  if (isRecord(design)) {
    for (const [field, fieldValue] of Object.entries(design)) {
      if (fieldValue !== null && fieldValue !== undefined) normalisedDesign[field] = fieldValue;
    }
  }
  out['design'] = normalisedDesign;
  if (value['type'] === 'wifi' && !isString(payload['auth'])) {
    out['payload'] = { ...payload, auth: 'WPA' };
  }
  // Every field a reader consumes was checked above
  return out as unknown as QRCode;
}

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

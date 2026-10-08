/**
 * Recently created QR codes, per domain (v1.40.0; D1 rows since v1.41.0).
 *
 * KV's `list` lags a write by about 60 seconds, so a code just created was
 * missing from every listing (MCP `list_qrs`, the REST API, another dashboard
 * tab) except the dashboard that created it, which merges its own. A create
 * records its id here, and `listQRs` reads any recent id its listing lacks by
 * its own KV key, so every client gets the same list.
 *
 * The record is the D1 table `qr_recent` (migration 0013). v1.40.0 kept one
 * shared KV key per domain (`qr-recent:{domain}`) and read-modified-wrote it,
 * so two creates at the same moment could each write a list without the
 * other's id, and KV's one-write-per-key-per-second limit could refuse the
 * second write. The old key is no longer read or written; it expires on its
 * own, and it was never listed or backed up (it is outside `qr:{domain}:` and
 * every route key).
 *
 * **One row per incarnation, and no clock ever orders two writes.** A
 * deleted code and a code re-created later with the same id are different
 * incarnations, told apart by the record's own `createdAt` (set once, on the
 * creating isolate's clock, and kept by every update; the identity the
 * dashboard's tombstones use). Different isolates' clocks disagree, so
 * `createdAt` is compared only for EQUALITY, never as an order: the row's key
 * is `(domain, id, created_at)`.
 *   - A create inserts its incarnation's row and never touches an existing
 *     one ({@link noteRecentQr}, `ON CONFLICT DO NOTHING`), so a create write
 *     that lands after its own delete cannot revive it.
 *   - A delete marks its incarnation's row deleted, inserting it already
 *     deleted when the create's write has not landed yet
 *     ({@link forgetRecentQr}), so it wins in either order.
 *   - Another incarnation is another row, so a re-create is listed whatever
 *     its clock says, even behind the deleted one's.
 * The writes are best effort, after the answer, so they can land in any
 * order; every order ends the same way.
 *
 * **The listing checks the incarnation too.** A live row is only a hint that
 * an id may be missing from KV's listing. `listQRs` merges the id when the
 * record it then reads from KV is readable AND is one of the id's live
 * incarnations, so a KV location still serving a deleted incarnation (KV
 * converges in about a minute; D1 is one database for every location) merges
 * nothing; a record that cannot be read is listed as its minimal row, as KV's
 * own listing lists it.
 *
 * **`noted_at` is for the window only**: the writer's clock when the row was
 * first written. The read takes rows noted within the window plus
 * {@link QR_RECENT_SKEW_MARGIN_MS} (no upper bound, for a writer whose clock
 * runs ahead), and the write path prunes, a bounded batch per create and per
 * delete, rows noted before that. A disagreeing clock can only make a row
 * show a little longer or shorter, never show a deleted incarnation.
 *
 * Best effort throughout: a failed write is logged by error class and never
 * fails the create or delete (callers run it after the answer), and a failed
 * read is no recent codes. A listing's wait for the read is bounded
 * ({@link awaitRecentQrs}): a read that has not answered within
 * {@link QR_RECENT_READ_TIMEOUT_MS} of the listing needing it is no recent
 * codes too, so a slow D1 never holds a listing up. A missing table (migration 0013 not applied) is
 * named in the log: once per write, and once per isolate on the read path,
 * which every listing takes. Listing is read-only.
 */
import { z } from 'zod';
import { isRecord } from '../utils/boundary';
import { errorName } from '../utils/error-name';

/** How long a created code is merged into listings: past KV's listing lag, with room. */
export const QR_RECENT_WINDOW_MS = 120_000;

/**
 * How far apart two isolates' clocks may be for the window to still cover a
 * code: the read reaches this much further back, and pruning waits this much
 * longer. Correctness never rests on it: the listing merges a row only for an
 * incarnation KV serves, and a delete is a row of its own.
 */
export const QR_RECENT_SKEW_MARGIN_MS = 5_000;

/**
 * How long a listing waits for the recent-rows read (v1.41.0 review): every
 * QR listing awaits it after its KV listing, so a read that has not answered
 * by then is taken as no recent codes (logged as a timeout), and a code just
 * created shows once KV's listing catches up.
 */
export const QR_RECENT_READ_TIMEOUT_MS = 300;

/** At most this many recent rows are merged per listing (the newest noted). */
export const QR_RECENT_MAX = 100;

/** At most this many expired rows are pruned per create or delete. */
export const QR_RECENT_PRUNE_BATCH = 100;

/**
 * A row as D1 returns it, validated at the boundary: the table is this
 * Worker's own, but a row that does not fit is skipped, never trusted.
 */
const RecentQrRowSchema = z.object({
  id: z.string().min(1).max(512),
  created_at: z.number().int(),
});

/** A live recent row: the id and the incarnation (createdAt, whole ms) it records. */
export interface RecentQr {
  id: string;
  createdAt: number;
}

/**
 * An incarnation as the table stores it: whole milliseconds (rounded up), or
 * null when not a finite number. The listing compares a record's createdAt
 * through it with a row's `created_at`, for equality only.
 */
export function incarnationTime(createdAt: number): number | null {
  return Number.isFinite(createdAt) ? Math.ceil(createdAt) : null;
}

/** Whether a D1 batch answered `success: true` for a statement. */
function succeeded(result: unknown): boolean {
  return isRecord(result) && result['success'] === true;
}

/**
 * Whether a D1 failure is the `qr_recent` table missing (migration 0013 not
 * applied). The message is matched, never logged; the word boundary keeps a
 * table whose name merely starts with `qr_recent` out. The cause chain is
 * followed a few levels, since D1 can wrap the SQLite error.
 */
function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    if (/\bno such table: qr_recent\b/.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/** The earliest `noted_at` the window (and its skew margin) still reads at `now`. */
function windowStart(now: number): number {
  return now - QR_RECENT_WINDOW_MS - QR_RECENT_SKEW_MARGIN_MS;
}

/**
 * The statement that deletes up to one batch of this domain's rows noted
 * before the window and its skew margin, live or deleted. A deleted row is
 * kept as long as a live one: its create's write lands within seconds, while
 * the row is still there to refuse it.
 */
function pruneExpired(db: D1Database, domain: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      'DELETE FROM qr_recent WHERE rowid IN (SELECT rowid FROM qr_recent WHERE domain = ? ' +
        'AND noted_at < ? LIMIT ?)',
    )
    .bind(domain, windowStart(now), QR_RECENT_PRUNE_BATCH);
}

/**
 * Write one row and prune expired rows of its domain in ONE `db.batch`, the
 * row first. D1 runs a batch as one transaction, so a failing prune rolls the
 * row back with it: when the batch fails, or answers without the row's
 * statement succeeding, the row is written again on its own (both writes are
 * idempotent, so writing twice is harmless). A missing table is logged once
 * and not retried, since the lone write would fail the same way. A prune that
 * fails is retried by the next write. Never throws.
 */
async function writeAndPrune(
  db: D1Database,
  domain: string,
  now: number,
  kind: 'create' | 'delete',
  write: () => D1PreparedStatement,
): Promise<void> {
  let results: unknown;
  try {
    results = await db.batch([write(), pruneExpired(db, domain, now)]);
  } catch (error) {
    if (isMissingTable(error)) {
      console.warn(`[QR] Recent ${kind} not recorded: table qr_recent is missing`);
      return;
    }
    console.warn(
      `[QR] Recent ${kind} and prune failed together, writing the ${kind} alone: ${errorName(error)}`,
    );
  }
  const answered: readonly unknown[] = Array.isArray(results) ? results : [];
  if (succeeded(answered[0])) {
    if (!succeeded(answered[1])) console.warn('[QR] Expired recent rows were not pruned');
    return;
  }
  try {
    await write().run();
  } catch (error) {
    console.warn(`[QR] Recent ${kind} could not be recorded: ${errorName(error)}`);
  }
}

/**
 * Record a created code: `createdAt` is the record's own createdAt (its
 * incarnation). Inserts that incarnation's row, noted at `now`; an existing
 * row of it, live or deleted, is left as it is (`ON CONFLICT DO NOTHING`), so
 * a create write landing after its own delete stays hidden. The same round
 * trip prunes up to {@link QR_RECENT_PRUNE_BATCH} expired rows of the domain.
 * Never throws.
 */
export async function noteRecentQr(
  db: D1Database,
  domain: string,
  id: string,
  createdAt: number,
  now: number = Date.now(),
): Promise<void> {
  const created = incarnationTime(createdAt);
  if (created === null) {
    console.warn('[QR] Recent create not recorded: no valid createdAt');
    return;
  }
  await writeAndPrune(db, domain, now, 'create', () =>
    db
      .prepare(
        'INSERT INTO qr_recent (domain, id, created_at, deleted, noted_at) VALUES (?, ?, ?, 0, ?) ' +
          'ON CONFLICT(domain, id, created_at) DO NOTHING',
      )
      .bind(domain, id, created, now),
  );
}

/**
 * Record a deleted code, so a recent row cannot bring it back while KV
 * converges (another location's KV `get` can still serve the deleted value
 * for about a minute, and D1 is one database for every location).
 * `deletedCreatedAt` is the deleted record's createdAt, read before its KV
 * delete: exactly that incarnation's row is marked deleted, and inserted
 * already deleted when the create's write has not landed yet, so the delete
 * wins in either order. Any other incarnation, a re-create included, is
 * another row and is left alone. The same round trip prunes, so a domain
 * that only sees deletes does not grow either.
 *
 * Always written, however old the incarnation (v1.41.0 review): whether its
 * create's row is still in a reader's window would compare the creating
 * isolate's clock with this one's, and no clock orders two writes. The row is
 * noted at `now`, so the prune removes it once it leaves the window. Never
 * throws.
 */
export async function forgetRecentQr(
  db: D1Database,
  domain: string,
  id: string,
  deletedCreatedAt: number,
  now: number = Date.now(),
): Promise<void> {
  const deleted = incarnationTime(deletedCreatedAt);
  if (deleted === null) {
    console.warn('[QR] Recent delete not recorded: no valid createdAt');
    return;
  }
  await writeAndPrune(db, domain, now, 'delete', () =>
    db
      .prepare(
        'INSERT INTO qr_recent (domain, id, created_at, deleted, noted_at) VALUES (?, ?, ?, 1, ?) ' +
          'ON CONFLICT(domain, id, created_at) DO UPDATE SET deleted = 1',
      )
      .bind(domain, id, deleted, now),
  );
}

/** Whether this isolate has logged the read path's missing table (logged once per isolate). */
let missingTableReadLogged = false;

/**
 * The live rows of `domain` noted within the window (and its skew margin)
 * before `now`, each with the incarnation it records, oldest noted first, at
 * most the newest {@link QR_RECENT_MAX}. An id can appear once per live
 * incarnation. There is no upper bound: a row a writer with a clock ahead of
 * this one noted is still read. These are hints only; the caller merges an id
 * only for an incarnation KV serves. Read-only. Never throws: a failed read
 * is no recent codes. A listing waits for it through
 * {@link awaitRecentQrs}, which bounds the wait.
 */
export async function recentQrs(
  db: D1Database,
  domain: string,
  now: number = Date.now(),
): Promise<RecentQr[]> {
  let rows: unknown;
  try {
    const read = await db
      .prepare(
        'SELECT id, created_at FROM qr_recent WHERE domain = ? AND noted_at >= ? AND deleted = 0 ' +
          'ORDER BY noted_at DESC, id DESC LIMIT ?',
      )
      .bind(domain, windowStart(now), QR_RECENT_MAX)
      .all();
    rows = read.results;
  } catch (error) {
    if (!isMissingTable(error)) {
      console.warn(`[QR] Recent creates could not be read: ${errorName(error)}`);
    } else if (!missingTableReadLogged) {
      missingTableReadLogged = true;
      console.warn('[QR] Recent creates not read: table qr_recent is missing');
    }
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const recent: RecentQr[] = [];
  let invalid = 0;
  for (const row of rows) {
    const parsed = RecentQrRowSchema.safeParse(row);
    if (parsed.success) recent.push({ id: parsed.data.id, createdAt: parsed.data.created_at });
    else invalid += 1;
  }
  if (invalid > 0) console.warn(`[QR] Recent create rows skipped as unreadable: ${invalid}`);
  return recent.toReversed();
}

/**
 * Wait for a started {@link recentQrs} read for at most `timeoutMs` (v1.41.0
 * review): every QR listing awaits it after its KV listing, so a D1 that is
 * slow or hung must not hold the listing up. A read that has not answered by
 * then is taken as no recent codes and logged once, as a timeout (a code just
 * created then shows once KV's listing catches up); its late answer is
 * ignored. The timer starts when the listing needs the rows, not when the read
 * was started, and is cleared when the read answers first. Never throws.
 */
export async function awaitRecentQrs(
  read: Promise<RecentQr[]>,
  timeoutMs: number = QR_RECENT_READ_TIMEOUT_MS,
): Promise<RecentQr[]> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<RecentQr[]>(resolve => {
    timer = setTimeout(() => {
      console.warn('[QR] Recent creates could not be read: timeout');
      resolve([]);
    }, timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

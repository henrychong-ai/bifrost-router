/**
 * Recently created QR codes, per domain (v1.40.0; D1 rows since v1.41.0; the
 * delete awaited and marking every incarnation since v1.41.1).
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
 *   - A delete marks EVERY incarnation of the id recorded so far deleted
 *     (v1.41.1: KV's delete removes the key whatever incarnation it holds,
 *     and the delete's own read of it may have been stale), and inserts the
 *     incarnation it read already deleted when the create's write has not
 *     landed yet ({@link forgetRecentQr}), so it wins in either order. An
 *     unreadable record names no incarnation: its delete only marks the
 *     recorded ones.
 *   - A re-create whose create row is written after the delete's D1 write is
 *     another row, so it is listed whatever its clock says, even behind the
 *     deleted one's. One whose row lands between the delete's KV delete and
 *     its D1 write (possible even within the bound) is marked deleted by that
 *     write's `UPDATE` too: it shows once KV's own listing has it.
 * A create's write is best effort after the answer; a delete's is awaited
 * before the answer (v1.41.1, bounded: {@link awaitRecentQrDelete}), so a
 * listing made after a delete has answered never merges the code it deleted,
 * provided that write finished within its bound. One that outlasts it lands
 * after the answer, and until it does (or KV converges) a listing at a KV
 * location still serving the code can merge it (TODO.md).
 *
 * **The listing checks the incarnation too.** A live row is only a hint that
 * an id may be missing from KV's listing. `listQRs` merges the id when the
 * record it then reads from KV is readable AND is one of the id's live
 * incarnations, so a KV location still serving a deleted incarnation (KV
 * converges in about a minute; D1 is one database for every location) merges
 * nothing. A record that cannot be read names no incarnation, so it is never
 * merged (v1.41.1): it is listed as its minimal row once KV's own listing has
 * it.
 *
 * **`noted_at` is for the window only**: the writer's clock when the row was
 * FIRST written, kept by every later write of it (a delete marking an
 * existing row leaves its `noted_at`; only a row a delete inserts is noted at
 * the delete's time). The read takes rows noted within the window plus
 * {@link QR_RECENT_SKEW_MARGIN_MS} (no upper bound, for a writer whose clock
 * runs ahead), and the write path prunes, a bounded batch per create and per
 * delete, rows noted before that. A disagreeing clock can only make a row
 * show a little longer or shorter, never show a deleted incarnation.
 *
 * Best effort throughout: a failed write is logged by error class and never
 * fails the create or delete, and a failed read is no recent codes. A wait is
 * always bounded: a listing's for the read ({@link awaitRecentQrs},
 * {@link QR_RECENT_READ_TIMEOUT_MS} from the listing needing it) and a
 * delete's for its write ({@link awaitRecentQrDelete},
 * {@link QR_RECENT_DELETE_TIMEOUT_MS}), so a slow D1 never holds either up. A
 * missing table (migration 0013 not applied) is named in the log: once per
 * write, and once per isolate on the read path, which every listing takes; a
 * read timeout at most once a minute per isolate. Listing is read-only.
 *
 * Residual (TODO.md): a create's row is written after its answer, so it can
 * land after a later delete's write. When that delete's KV read was stale (it
 * read an older incarnation, so it did not insert this one's row deleted),
 * the late create row is live, and a KV location still serving the deleted
 * code lists it until KV converges (about a minute). Likewise the delete's
 * `UPDATE` marks deleted a code re-created between its KV delete and its D1
 * write (within the bound or, for a write that outlasts it, after the
 * answer), which then shows once KV's own listing has it.
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
 * by then is taken as no recent codes (logged as a timeout, once per
 * isolate), and a code just created shows once KV's listing catches up. A
 * location far from the D1 primary routinely takes more than 300 ms (the
 * v1.41.0 budget), so the budget is a second (v1.41.1).
 */
export const QR_RECENT_READ_TIMEOUT_MS = 1_000;

/**
 * How long a delete waits for its recent-rows write before answering
 * (v1.41.1). A write that has not answered by then is logged as a timeout and
 * left to finish after the answer (the caller keeps it alive), so a slow D1
 * never holds a delete up.
 */
export const QR_RECENT_DELETE_TIMEOUT_MS = 1_000;

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
 * Run a write's statements and prune expired rows of its domain in ONE
 * `db.batch`, the writes first. D1 runs a batch as one transaction, so a
 * failing prune rolls the writes back with it: when the batch fails, or
 * answers without every write statement succeeding, each write statement is
 * run again on its own (every one is idempotent, so writing twice is
 * harmless), and a failure there is logged once, by the first failure's error
 * class (v1.41.1: a delete has two statements). A missing table is logged
 * once and not retried, since the lone writes would fail the same way. A
 * prune that fails is retried by the next write. Never throws, even when the
 * statements cannot be prepared.
 */
async function writeAndPrune(
  db: D1Database,
  domain: string,
  now: number,
  kind: 'create' | 'delete',
  writes: () => D1PreparedStatement[],
): Promise<void> {
  let count = 0;
  let results: unknown;
  try {
    const batched = writes();
    count = batched.length;
    results = await db.batch([...batched, pruneExpired(db, domain, now)]);
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
  const written = answered.slice(0, count);
  if (count > 0 && written.length === count && written.every(succeeded)) {
    if (!succeeded(answered[count])) console.warn('[QR] Expired recent rows were not pruned');
    return;
  }
  let failure: { error: unknown } | null = null;
  try {
    for (const statement of writes()) {
      try {
        await statement.run();
      } catch (error) {
        failure ??= { error };
      }
    }
  } catch (error) {
    // The statements could not even be prepared
    failure ??= { error };
  }
  if (failure) {
    console.warn(`[QR] Recent ${kind} could not be recorded: ${errorName(failure.error)}`);
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
  await writeAndPrune(db, domain, now, 'create', () => [
    db
      .prepare(
        'INSERT INTO qr_recent (domain, id, created_at, deleted, noted_at) VALUES (?, ?, ?, 0, ?) ' +
          'ON CONFLICT(domain, id, created_at) DO NOTHING',
      )
      .bind(domain, id, created, now),
  ]);
}

/**
 * Record a deleted code, so a recent row cannot bring it back while KV
 * converges (another location's KV `get` can still serve the deleted value
 * for about a minute, and D1 is one database for every location). Two
 * statements, in one batch with the prune (v1.41.1):
 *   - every incarnation of the id recorded so far is marked deleted: KV's
 *     delete removed the key whatever incarnation it held, and the delete's
 *     own read of it (`deletedCreatedAt`) is eventually consistent, so it can
 *     name an older incarnation than the one KV deleted. An existing row
 *     keeps its `noted_at`;
 *   - when `deletedCreatedAt` (the record's createdAt, read before its KV
 *     delete) is valid, that incarnation's row is inserted already deleted,
 *     noted at `now`, so its create's write landing later (it runs after the
 *     create's answer) cannot revive it.
 * An unreadable record names no incarnation (`deletedCreatedAt` undefined):
 * its delete runs the first statement only, so its live row stops listing it
 * (v1.41.0 wrote nothing for it). A re-create whose create row is written
 * after this D1 write is another row, left live; one whose row landed between
 * the KV delete and this write (even within the bound) is marked deleted by
 * the `UPDATE` too, and shows once KV's own listing has it (TODO.md). The
 * same round trip prunes, so a domain that only sees deletes does not grow
 * either.
 *
 * Always written, however old the incarnation (v1.41.0 review): whether its
 * create's row is still in a reader's window would compare the creating
 * isolate's clock with this one's, and no clock orders two writes. The caller
 * awaits it before answering, bounded ({@link awaitRecentQrDelete}). Never
 * throws.
 */
export async function forgetRecentQr(
  db: D1Database,
  domain: string,
  id: string,
  deletedCreatedAt: number | undefined,
  now: number = Date.now(),
): Promise<void> {
  const deleted = deletedCreatedAt === undefined ? null : incarnationTime(deletedCreatedAt);
  if (deletedCreatedAt !== undefined && deleted === null) {
    console.warn(
      '[QR] Recent delete has no valid createdAt; marking the recorded incarnations only',
    );
  }
  await writeAndPrune(db, domain, now, 'delete', () => [
    db.prepare('UPDATE qr_recent SET deleted = 1 WHERE domain = ? AND id = ?').bind(domain, id),
    ...(deleted === null
      ? []
      : [
          db
            .prepare(
              'INSERT INTO qr_recent (domain, id, created_at, deleted, noted_at) ' +
                'VALUES (?, ?, ?, 1, ?) ON CONFLICT(domain, id, created_at) DO UPDATE SET deleted = 1',
            )
            .bind(domain, id, deleted, now),
        ]),
  ]);
}

/** Whether this isolate has logged the read path's missing table (logged once per isolate). */
let missingTableReadLogged = false;

/**
 * Shortest time between two read-timeout logs in one isolate (v1.41.1
 * review): a location far from the D1 primary would otherwise log on every
 * listing, while once per isolate forever would hide a timeout that starts
 * later in a long-lived isolate.
 */
export const QR_RECENT_TIMEOUT_LOG_INTERVAL_MS = 60_000;

/**
 * When this isolate last logged a read timeout, by its own clock (used only
 * to throttle the log, never to order writes); `undefined`: never.
 */
let readTimeoutLoggedAt: number | undefined;

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
 * `work`, or `onTimeout()` when it has not settled within `timeoutMs` of this
 * call. The timer is cleared when `work` settles first. `work` must never
 * reject (every caller's work is best effort and never throws).
 */
async function bounded<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>(resolve => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wait for a started {@link recentQrs} read for at most `timeoutMs` (v1.41.0
 * review): every QR listing awaits it after its KV listing, so a D1 that is
 * slow or hung must not hold the listing up. A read that has not answered by
 * then is taken as no recent codes (a code just created then shows once KV's
 * listing catches up); its late answer is ignored. The timeout is logged at
 * most once per {@link QR_RECENT_TIMEOUT_LOG_INTERVAL_MS} per isolate (v1.41.1:
 * a location far from the D1 primary would otherwise log on every listing).
 * The timer starts when the listing needs the rows, not when the read was
 * started, and is cleared when the read answers first. Never throws (the read
 * never rejects).
 */
export function awaitRecentQrs(
  read: Promise<RecentQr[]>,
  timeoutMs: number = QR_RECENT_READ_TIMEOUT_MS,
): Promise<RecentQr[]> {
  return bounded(read, timeoutMs, () => {
    const at = Date.now();
    // A clock that went back logs again rather than staying silent
    if (
      readTimeoutLoggedAt === undefined ||
      at < readTimeoutLoggedAt ||
      at - readTimeoutLoggedAt >= QR_RECENT_TIMEOUT_LOG_INTERVAL_MS
    ) {
      readTimeoutLoggedAt = at;
      console.warn('[QR] Recent creates could not be read: timeout');
    }
    return [];
  });
}

/**
 * Wait for a started {@link forgetRecentQr} write for at most `timeoutMs`
 * (v1.41.1): a delete awaits it before answering, so a listing made after the
 * answer never merges the code it deleted when the write finished within the
 * bound, but a slow or hung D1 must not hold the delete up. A write that has
 * not answered by then is logged, as a timeout, and keeps running: the caller
 * keeps it alive after the answer (`waitUntil`), and it lands late (marking a
 * delete late is safe: `deleted` only ever goes to 1). Until it lands, a
 * listing at a KV location still serving the code can merge it (TODO.md).
 * Never throws (the write never rejects).
 */
export function awaitRecentQrDelete(
  write: Promise<void>,
  timeoutMs: number = QR_RECENT_DELETE_TIMEOUT_MS,
): Promise<void> {
  return bounded(write, timeoutMs, () => {
    console.warn('[QR] Recent delete could not be recorded before the answer: timeout');
  });
}

import { eq, gte, and, sql } from 'drizzle-orm';
import { createDb } from '../db';
import { insertAuditLog } from '../db/analytics';
import { auditLogs, pollCursors } from '../db/schema';
import type { Bindings } from '../types';

/**
 * Cloudflare account audit-log poller (v1.28.0, Layer 2 of the R2 external
 * operations audit capture — see README.md "External R2 operations audit capture").
 *
 * Polls GET /accounts/{account_id}/audit_logs (v1, GA) on the every-30-min cron,
 * filters entries to R2-scoped resources (bucket config, custom domains,
 * event-notification rules, R2 tokens, queues), and records them as
 * source='cf_audit' audit rows WITH the real Cloudflare actor — the only
 * source of WHO for out-of-band changes. Object-level data ops are explicitly
 * excluded from CF audit logs; those are covered by the R2 event consumer.
 *
 * Cursor: named watermark in poll_cursors (D1) — last-seen `when` timestamp
 * plus the entry IDs AT that timestamp (boundary set) so the inclusive
 * re-query never double-inserts. A details-based id guard backstops cursor
 * loss. All CF API mapping is defensive and isolated here (v2 migration point).
 */

const CURSOR_NAME = 'cf-audit-poll';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 10;
/** First-run lookback when no cursor exists (24h) */
const INITIAL_LOOKBACK_SECS = 24 * 60 * 60;
/** Re-query overlap behind the watermark (CF `since` is documented exclusive) */
const QUERY_OVERLAP_SECS = 60;

/** Loosely-typed CF audit log entry (v1 API; defensively parsed) */
interface CfAuditEntry {
  id?: string;
  action?: { type?: string; result?: boolean | string };
  actor?: { id?: string; email?: string; type?: string; ip?: string };
  resource?: { type?: string; id?: string };
  interface?: string;
  metadata?: Record<string, unknown>;
  oldValue?: unknown;
  newValue?: unknown;
  when?: string;
}

interface PollCursor {
  /** ISO timestamp of the newest entry seen */
  since: string;
  /** Entry IDs sharing that exact timestamp (inclusive-boundary dedup) */
  boundaryIds: string[];
}

/**
 * Is this audit entry relevant to Bifrost's R2 surface? R2 resource types
 * (r2.bucket etc.), queues (the event pipeline's infra), and Workers cron/
 * config stay out of scope deliberately — queue + R2 only.
 */
function isR2Scoped(entry: CfAuditEntry): boolean {
  const rtype = (entry.resource?.type ?? '').toLowerCase();
  const atype = (entry.action?.type ?? '').toLowerCase();
  return rtype.includes('r2') || atype.includes('r2') || rtype.includes('queue');
}

async function readCursor(db: ReturnType<typeof createDb>): Promise<PollCursor | null> {
  const rows = await db
    .select({ value: pollCursors.value })
    .from(pollCursors)
    .where(eq(pollCursors.name, CURSOR_NAME))
    .limit(1);
  if (!rows[0]) return null;
  try {
    const parsed = JSON.parse(rows[0].value) as PollCursor;
    return parsed?.since ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCursor(db: ReturnType<typeof createDb>, cursor: PollCursor): Promise<void> {
  await db
    .insert(pollCursors)
    .values({
      name: CURSOR_NAME,
      value: JSON.stringify(cursor),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: pollCursors.name,
      set: { value: JSON.stringify(cursor), updatedAt: Math.floor(Date.now() / 1000) },
    });
}

/** Fetch one page of account audit logs (since → now, ascending). */
async function fetchAuditPage(env: Bindings, since: string, page: number): Promise<CfAuditEntry[]> {
  const params = new URLSearchParams({
    since,
    per_page: String(PAGE_SIZE),
    page: String(page),
    direction: 'asc',
  });
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/audit_logs?${params}`,
    { headers: { Authorization: `Bearer ${env.CF_AUDIT_API_TOKEN}` } },
  );
  if (!response.ok) {
    throw new Error(
      `CF audit_logs API ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }
  const body = (await response.json()) as { success?: boolean; result?: CfAuditEntry[] };
  if (body.success === false) throw new Error('CF audit_logs API returned success=false');
  return body.result ?? [];
}

/**
 * Idempotency backstop: has this CF entry id already been recorded?
 * Exact json_extract match on details.cf_audit_id (a LIKE pattern would treat
 * %/_ in the id as wildcards — failure direction is permanent audit loss).
 */
async function alreadyRecorded(
  db: ReturnType<typeof createDb>,
  cfId: string,
  sinceSecs: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.source, 'cf_audit'),
        gte(auditLogs.createdAt, sinceSecs),
        sql`json_extract(${auditLogs.details}, '$.cf_audit_id') = ${cfId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Poll once. Called from the scheduled handler via waitUntil; never throws
 * (errors are logged — the next cron run retries from the same cursor, and the
 * 18-month CF retention makes the replay window effectively unbounded).
 */
export async function pollCfAuditLogs(env: Bindings): Promise<void> {
  if (env.CF_AUDIT_POLL !== 'on') return;
  if (!env.CF_AUDIT_API_TOKEN || !env.CF_ACCOUNT_ID) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'cf-audit-poll-unconfigured',
        hasToken: Boolean(env.CF_AUDIT_API_TOKEN),
        hasAccountId: Boolean(env.CF_ACCOUNT_ID),
      }),
    );
    return;
  }

  try {
    const db = createDb(env.DB);
    const cursor = await readCursor(db);
    const since =
      cursor?.since ?? new Date(Date.now() - INITIAL_LOOKBACK_SECS * 1000).toISOString();
    const boundaryIds = new Set(cursor?.boundaryIds ?? []);

    // Query from the watermark MINUS an overlap: the CF API documents `since`
    // as "newer than" (exclusive), so querying from the watermark itself would
    // permanently drop same-second entries that materialise after a run (or
    // sit past a MAX_PAGES truncation at the boundary). The overlap makes
    // correctness independent of CF's boundary semantics — re-fetched entries
    // are absorbed by boundaryIds (fast path) and alreadyRecorded (backstop).
    const queryFrom = cursor?.since
      ? new Date(Date.parse(cursor.since) - QUERY_OVERLAP_SECS * 1000).toISOString()
      : since;

    let recorded = 0;

    // Watermark state. Timestamps are compared NUMERICALLY (epoch ms) — the
    // cursor seed comes from toISOString() ('…00.000Z') while CF `when` values
    // may omit millis ('…00Z'); lexicographic comparison misorders those at
    // equal instants. The boundary id set never re-adds existing ids and never
    // admits empty ids (both previously leaked, growing the cursor unboundedly
    // on quiet accounts).
    let newestWhen = since;
    let newestWhenMs = Date.parse(since);
    const newestIds = new Set<string>(cursor?.boundaryIds ?? []);
    const advanceWatermark = (id: string, when: string | undefined): void => {
      if (!when) return;
      const whenMs = Date.parse(when);
      if (Number.isNaN(whenMs) || whenMs < newestWhenMs) return;
      if (whenMs > newestWhenMs) {
        newestWhenMs = whenMs;
        newestWhen = when;
        newestIds.clear();
      }
      if (id) newestIds.add(id);
    };

    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      const entries = await fetchAuditPage(env, queryFrom, page);
      if (entries.length === 0) break;

      for (const entry of entries) {
        const id = entry.id ?? '';
        if (!id || boundaryIds.has(id) || !isR2Scoped(entry)) {
          // Still advance the watermark over skipped entries.
          advanceWatermark(id, entry.when);
          continue;
        }

        const whenSecs = entry.when
          ? Math.floor(new Date(entry.when).getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        if (!(await alreadyRecorded(db, id, whenSecs - 24 * 60 * 60))) {
          // STRICT insert — a swallowed failure here would advance the
          // watermark past an unrecorded entry and lose it forever. A throw
          // aborts the run before writeCursor; the next run re-polls from the
          // old cursor and alreadyRecorded() skips what did land.
          await insertAuditLog(env.DB, {
            domain: 'storage',
            action: 'cf_config_change',
            actorLogin: entry.actor?.email || entry.actor?.id || 'cloudflare-unknown',
            actorName: entry.actor?.type ? `Cloudflare ${entry.actor.type}` : null,
            path: `${entry.resource?.type ?? 'unknown'}/${entry.resource?.id ?? 'unknown'}`,
            ipAddress: entry.actor?.ip ?? null,
            details: JSON.stringify({
              cf_audit_id: id,
              actionType: entry.action?.type,
              actionResult: entry.action?.result,
              interface: entry.interface,
              resource: entry.resource,
              metadata: entry.metadata,
              oldValue: entry.oldValue,
              newValue: entry.newValue,
              when: entry.when,
            }),
            source: 'cf_audit',
          });
          recorded++;
        }

        advanceWatermark(id, entry.when);
      }

      if (entries.length < PAGE_SIZE) break;
    }

    await writeCursor(db, { since: newestWhen, boundaryIds: [...newestIds] });

    console.log(
      JSON.stringify({
        level: 'info',
        message: 'cf-audit-poll-complete',
        since,
        newestWhen,
        recorded,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'cf-audit-poll-failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

// Internal exports for unit tests
export const _internal = { isR2Scoped, CURSOR_NAME };

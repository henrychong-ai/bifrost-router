import { and, eq, gte, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import { createDb } from '../db';
import { auditLogs, r2EventCorrelations, r2EventSeen } from '../db/schema';
import { BACKUP_BUCKET_NAME, BACKUP_DAILY_PREFIX } from '../backup/constants';
import type { Bindings } from '../types';

/**
 * R2 event notification message payload (delivered via Cloudflare Queues).
 * See https://developers.cloudflare.com/r2/buckets/event-notifications/
 */
export interface R2EventMessage {
  account: string;
  action:
    | 'PutObject'
    | 'CompleteMultipartUpload'
    | 'CopyObject'
    | 'DeleteObject'
    | 'LifecycleDeletion';
  bucket: string;
  object: { key: string; size?: number; eTag?: string };
  eventTime: string;
  copySource?: { bucket: string; object: string };
}

/** Event kind derived from the R2 action */
type EventKind = 'create' | 'delete';

const CREATE_ACTIONS = new Set(['PutObject', 'CompleteMultipartUpload', 'CopyObject']);
const DELETE_ACTIONS = new Set(['DeleteObject', 'LifecycleDeletion']);

/**
 * Bifrost audit actions that can legitimately explain an R2 object event on a
 * user-content bucket. A metadata update performs a copy-in-place (fires
 * object-create); a rename or move is a copy + delete pair (one of each).
 * Feedback artifacts are handled separately (see processFeedbackEvent) —
 * their audit rows live under domain='feedback', not 'storage'.
 */
const CREATE_COMPATIBLE_ACTIONS = [
  'r2_upload',
  'r2_replace',
  'r2_rename',
  'r2_move',
  'r2_metadata_update',
];
const DELETE_COMPATIBLE_ACTIONS = ['r2_delete', 'r2_rename', 'r2_move'];

const FEEDBACK_CREATE_ACTIONS = ['feedback_create'];
const FEEDBACK_DELETE_ACTIONS = ['feedback_delete'];

/**
 * Correlation window (seconds) around the event time within which a
 * Bifrost-sourced audit entry can explain the event. The queue's 60s delivery
 * delay guarantees Bifrost's waitUntil audit write has landed by consumption
 * time; ±120s absorbs clock skew and slow multipart completions.
 */
const CORRELATION_WINDOW_SECS = 120;

/** Retention for idempotency fingerprints + correlation claims (dead after the window) */
const MARKER_RETENTION_SECS = 7 * 24 * 60 * 60;

/** Isolated feedback-artifact bucket (see wrangler.toml FEEDBACK_BUCKET) */
const FEEDBACK_BUCKET_NAME = 'bifrost-feedback';

function eventKindOf(action: R2EventMessage['action']): EventKind | null {
  if (CREATE_ACTIONS.has(action)) return 'create';
  if (DELETE_ACTIONS.has(action)) return 'delete';
  return null;
}

/** Stable per-event fingerprint for at-least-once dedup (r2_event_seen PK) */
function eventFingerprint(event: R2EventMessage): string {
  return [
    event.action,
    event.bucket,
    event.object.key,
    event.eventTime,
    event.object.eTag ?? '',
  ].join('|');
}

/** Did this error come from a UNIQUE/PK violation on the given table? */
function isUniqueViolation(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|constraint|primary key/i.test(message) && message.includes(table);
}

interface CandidateRow {
  id: number;
  action: string;
  path: string | null;
  details: string | null;
  createdAt: number;
}

/**
 * Does this Bifrost audit row explain the event for this object?
 *
 * Exact, structured matching only (review hardening — the original substring
 * containment let a crafted key correlate against an unrelated entry and
 * suppress/misattribute audit evidence):
 *  - direct path match (`bucket/key`)
 *  - rename rows: details.newKey explains the create, details.oldKey the delete
 *  - move rows: details.destinationBucket/destinationKey explain the create,
 *    details.sourceBucket/key the delete
 */
function rowExplainsEvent(row: CandidateRow, event: R2EventMessage, kind: EventKind): boolean {
  const key = event.object.key;
  const exactPath = `${event.bucket}/${key}`;
  const pathMatches = row.path === exactPath;

  // Rename: audit path carries the NEW key; move: audit path carries the source.
  // For the pair side not covered by path, fall through to structured details.
  if (pathMatches && row.action !== 'r2_rename' && row.action !== 'r2_move') {
    return true;
  }

  if (row.action === 'r2_rename' || row.action === 'r2_move') {
    if (!row.details) return false;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(row.details) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (row.action === 'r2_rename') {
      const bucketOk = d.bucket === event.bucket;
      return bucketOk && (kind === 'create' ? d.newKey === key : d.oldKey === key);
    }
    // r2_move
    if (kind === 'create') {
      const bucketOk = d.destinationBucket === event.bucket;
      return bucketOk && (d.destinationKey ?? d.key) === key;
    }
    const bucketOk = d.sourceBucket === event.bucket;
    return bucketOk && d.key === key;
  }

  return false;
}

/**
 * Build the audit_logs insert values for an event-derived row.
 */
function eventAuditValues(
  event: R2EventMessage,
  kind: EventKind,
  actor: { login: string; name: string },
  extraDetails: Record<string, unknown> = {},
) {
  return {
    domain: 'storage',
    action: kind === 'create' ? 'r2_object_create' : 'r2_object_delete',
    actorLogin: actor.login,
    actorName: actor.name,
    path: `${event.bucket}/${event.object.key}`,
    details: JSON.stringify({
      r2Action: event.action,
      bucket: event.bucket,
      key: event.object.key,
      size: event.object.size,
      eTag: event.object.eTag,
      eventTime: event.eventTime,
      ...(event.copySource && { copySource: event.copySource }),
      ...extraDetails,
    }),
    source: 'r2_event' as const,
  };
}

const EXTERNAL_ACTOR = { login: 'external-unattributed', name: 'External (unattributed)' };
const BACKUP_ACTOR = { login: 'bifrost-scheduled-backup', name: 'Bifrost Scheduled Backup' };
const FEEDBACK_ACTOR = { login: 'bifrost-feedback-pipeline', name: 'Bifrost Feedback Pipeline' };

/**
 * Atomically record the event: fingerprint + audit row in one D1 batch (both
 * or neither — a redelivered event can neither double-insert nor be lost).
 *
 * @returns true if recorded, false if the fingerprint already existed
 *          (duplicate delivery — safe to ack). Other errors propagate.
 */
async function recordEventRow(
  db: ReturnType<typeof createDb>,
  fingerprint: string,
  values: ReturnType<typeof eventAuditValues>,
): Promise<boolean> {
  try {
    await db.batch([
      db.insert(r2EventSeen).values({ fingerprint }),
      db.insert(auditLogs).values(values),
    ]);
    return true;
  } catch (error) {
    if (isUniqueViolation(error, 'r2_event_seen')) return false;
    throw error;
  }
}

/**
 * Try to claim a Bifrost-sourced audit entry that explains this event.
 * The claim (and the event fingerprint) are inserted in one atomic batch so a
 * redelivery cannot re-surface a correlated event as a false external row.
 *
 * @returns 'claimed' (event explained — drop), 'duplicate' (redelivery — ack),
 *          or 'unmatched' (record as external)
 */
async function claimCorrelation(
  db: ReturnType<typeof createDb>,
  event: R2EventMessage,
  kind: EventKind,
  eventTimeSecs: number,
  fingerprint: string,
): Promise<'claimed' | 'duplicate' | 'unmatched'> {
  const compatible = kind === 'create' ? CREATE_COMPATIBLE_ACTIONS : DELETE_COMPATIBLE_ACTIONS;

  // Slots already claimed for this kind within the relevant window (bounded —
  // the claims table is pruned, but never scan beyond the window regardless).
  const claimed = db
    .select({ auditId: r2EventCorrelations.auditId })
    .from(r2EventCorrelations)
    .where(
      and(
        eq(r2EventCorrelations.eventKind, kind),
        gte(r2EventCorrelations.eventTime, eventTimeSecs - 2 * CORRELATION_WINDOW_SECS),
      ),
    );

  const candidates = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      path: auditLogs.path,
      details: auditLogs.details,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.source, 'bifrost'),
        eq(auditLogs.domain, 'storage'),
        inArray(auditLogs.action, compatible),
        gte(auditLogs.createdAt, eventTimeSecs - CORRELATION_WINDOW_SECS),
        lte(auditLogs.createdAt, eventTimeSecs + CORRELATION_WINDOW_SECS),
        notInArray(auditLogs.id, claimed),
      ),
    )
    // Nearest-in-time first IN SQL — without ORDER BY, the limit() truncation
    // is arbitrary and could exclude the true match under bulk load (>200
    // in-window rows), misreporting a Bifrost op as external.
    .orderBy(sql`abs(${auditLogs.createdAt} - ${eventTimeSecs})`)
    .limit(200);

  const matches = candidates
    .filter(row => rowExplainsEvent(row, event, kind))
    // Nearest-in-time first — under bulk load the true match is the closest one.
    .sort((a, b) => Math.abs(a.createdAt - eventTimeSecs) - Math.abs(b.createdAt - eventTimeSecs));

  for (const match of matches) {
    try {
      await db.batch([
        db.insert(r2EventSeen).values({ fingerprint }),
        db.insert(r2EventCorrelations).values({
          auditId: match.id,
          eventKind: kind,
          eventTime: eventTimeSecs,
        }),
      ]);
      console.log(
        JSON.stringify({
          level: 'info',
          message: 'r2-event-correlated',
          bucket: event.bucket,
          key: event.object.key,
          action: event.action,
          auditId: match.id,
        }),
      );
      return 'claimed';
    } catch (error) {
      if (isUniqueViolation(error, 'r2_event_seen')) return 'duplicate';
      if (isUniqueViolation(error, 'r2_event_correlations')) continue; // slot taken — next candidate
      throw error; // transient D1 failure — retry the message, do NOT mislabel as external
    }
  }
  return 'unmatched';
}

/**
 * Feedback-bucket events: every legitimate write goes through Bifrost's
 * feedback endpoint, whose audit rows live under domain='feedback' and cover
 * up to four R2 objects per submission. Rather than slot-claiming (which
 * starves multi-attachment submissions and could absorb evidence), these
 * events are ALWAYS recorded — attributed to the feedback pipeline when a
 * feedback_* row exists in the window, external otherwise.
 */
async function processFeedbackEvent(
  db: ReturnType<typeof createDb>,
  event: R2EventMessage,
  kind: EventKind,
  eventTimeSecs: number,
  fingerprint: string,
): Promise<boolean> {
  const compatible = kind === 'create' ? FEEDBACK_CREATE_ACTIONS : FEEDBACK_DELETE_ACTIONS;
  const feedbackRows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.source, 'bifrost'),
        eq(auditLogs.domain, 'feedback'),
        inArray(auditLogs.action, compatible),
        gte(auditLogs.createdAt, eventTimeSecs - CORRELATION_WINDOW_SECS),
        lte(auditLogs.createdAt, eventTimeSecs + CORRELATION_WINDOW_SECS),
      ),
    )
    .limit(1);

  const matched = feedbackRows.length > 0;
  return recordEventRow(
    db,
    fingerprint,
    eventAuditValues(
      event,
      kind,
      matched ? FEEDBACK_ACTOR : EXTERNAL_ACTOR,
      matched ? { correlatedFeedbackAuditId: feedbackRows[0].id } : {},
    ),
  );
}

/**
 * Process one R2 event. Throws on transient failures (D1 errors) so the queue
 * retries and eventually dead-letters — a swallowed failure here would
 * permanently lose an audit event.
 */
async function processEvent(env: Bindings, event: R2EventMessage): Promise<void> {
  const kind = event?.action ? eventKindOf(event.action) : null;
  if (!kind || !event.bucket || !event.object?.key) {
    console.warn(JSON.stringify({ level: 'warn', message: 'r2-event-skipped-malformed', event }));
    return;
  }

  const db = createDb(env.DB);
  const fingerprint = eventFingerprint(event);

  // Malformed eventTime: degrade to a best-effort external row (correlation is
  // meaningless without a timestamp) instead of burning retries on NaN params.
  const eventTimeMs = Date.parse(event.eventTime ?? '');
  if (Number.isNaN(eventTimeMs)) {
    const recorded = await recordEventRow(db, fingerprint, {
      ...eventAuditValues(event, kind, EXTERNAL_ACTOR, { malformedEventTime: true }),
    });
    logOutcome(event, recorded ? 'r2-event-external' : 'r2-event-duplicate');
    return;
  }
  const eventTimeSecs = Math.floor(eventTimeMs / 1000);

  // System attribution: daily backup writes (no per-object Bifrost audit entry).
  const isBackupWrite =
    kind === 'create' &&
    event.bucket === BACKUP_BUCKET_NAME &&
    event.object.key.startsWith(BACKUP_DAILY_PREFIX);
  if (isBackupWrite) {
    const recorded = await recordEventRow(
      db,
      fingerprint,
      eventAuditValues(event, kind, BACKUP_ACTOR),
    );
    logOutcome(event, recorded ? 'r2-event-system-attributed' : 'r2-event-duplicate');
    return;
  }

  // Feedback artifacts.
  if (event.bucket === FEEDBACK_BUCKET_NAME) {
    const recorded = await processFeedbackEvent(db, event, kind, eventTimeSecs, fingerprint);
    logOutcome(event, recorded ? 'r2-event-feedback' : 'r2-event-duplicate');
    return;
  }

  const outcome = await claimCorrelation(db, event, kind, eventTimeSecs, fingerprint);
  if (outcome !== 'unmatched') {
    if (outcome === 'duplicate') logOutcome(event, 'r2-event-duplicate');
    return;
  }

  const recorded = await recordEventRow(
    db,
    fingerprint,
    eventAuditValues(event, kind, EXTERNAL_ACTOR),
  );
  logOutcome(event, recorded ? 'r2-event-external' : 'r2-event-duplicate');
}

function logOutcome(event: R2EventMessage, message: string): void {
  console.log(
    JSON.stringify({
      level: 'info',
      message,
      bucket: event.bucket,
      key: event.object?.key,
      action: event.action,
    }),
  );
}

/** Opportunistic per-batch prune: markers older than the retention are dead. */
async function pruneMarkers(db: ReturnType<typeof createDb>): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - MARKER_RETENTION_SECS;
  try {
    await db.batch([
      db.delete(r2EventSeen).where(lt(r2EventSeen.createdAt, cutoff)),
      db.delete(r2EventCorrelations).where(lt(r2EventCorrelations.createdAt, cutoff)),
    ]);
  } catch (error) {
    // Prune is best-effort housekeeping — never block event processing on it.
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'r2-event-prune-failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Queue consumer entrypoint for R2 event notifications (v1.28.0).
 *
 * Flag-gated by R2_EVENT_AUDIT: any value other than "on" acks and discards the
 * batch (90s rollback — notification rules can stay attached). Per-message
 * failures retry individually (then DLQ); one bad message never blocks a batch.
 */
export async function handleR2EventBatch(
  batch: MessageBatch<R2EventMessage>,
  env: Bindings,
): Promise<void> {
  if (env.R2_EVENT_AUDIT !== 'on') {
    batch.ackAll();
    return;
  }

  const db = createDb(env.DB);
  await pruneMarkers(db);

  for (const message of batch.messages) {
    try {
      await processEvent(env, message.body);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'r2-event-processing-failed',
          error: error instanceof Error ? error.message : String(error),
          body: message.body,
        }),
      );
      message.retry();
    }
  }
}

// Internal exports for unit tests
export const _internal = {
  eventKindOf,
  eventFingerprint,
  rowExplainsEvent,
  claimCorrelation,
  processEvent,
  CORRELATION_WINDOW_SECS,
};

/**
 * Feedback DB helpers (v1.26.0).
 *
 * Error policy: reads SWALLOW errors (return null/[] so the API degrades
 * gracefully before the 0009 migration is applied), writes THROW so the HTTP
 * handler can surface failure. The `F-<n>` short-id is allocated atomically from
 * the `counters` table (D1 serialises writes).
 *
 * Auth model: single ADMIN_API_KEY → one admin sees ALL feedback. There is no
 * submitter-scoping and no actor roles; `submitter_*` are optional free-text
 * metadata only.
 */

import { and, desc, eq, gte } from 'drizzle-orm';
import {
  formatFeedbackShortId,
  type FeedbackContext,
  type FeedbackItem,
  type FeedbackSeverity,
  type FeedbackStatus,
  type FeedbackType,
  type TriageFeedbackInput,
} from '@bifrost/shared';
import { createDb } from './index';
import { feedback, type FeedbackRow } from './schema';

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Map a raw DB row to the camelCase API/MCP shape (context + arrays parsed). */
export function rowToFeedbackItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    shortId: row.shortId,
    type: row.type as FeedbackType,
    severity: (row.severity as FeedbackSeverity | null) ?? null,
    priority: row.priority,
    status: row.status as FeedbackStatus,
    title: row.title,
    description: row.description,
    steps: row.steps ?? null,
    expected: row.expected ?? null,
    actual: row.actual ?? null,
    context: safeJsonParse<FeedbackContext | null>(row.contextJson, null),
    screenshotKeys: safeJsonParse<string[]>(row.screenshotKeys, []),
    captureKey: row.captureKey ?? null,
    labels: row.labels ?? null,
    area: row.area ?? null,
    assignee: row.assignee ?? null,
    triageNotes: row.triageNotes ?? null,
    linkedPr: row.linkedPr ?? null,
    externalRef: row.externalRef ?? null,
    submitterEmail: row.submitterEmail ?? null,
    submitterName: row.submitterName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

/**
 * Atomically allocate the next `F-<n>` sequence value. A single
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` is atomic under D1's serialised
 * writes and works whether or not the seed row exists. Gaps are acceptable (a
 * failed row-insert after this increment skips that n — same as GitHub/Linear).
 */
export async function allocateFeedbackShortId(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO counters (name, value) VALUES ('feedback', 1) " +
        'ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value',
    )
    .first<{ value: number }>();
  return row?.value ?? 1;
}

/** Fields the route handler supplies to create a feedback row. */
export interface CreateFeedbackData {
  /** Pre-generated UUIDv7 (the handler needs it first to build the R2 object keys). */
  id: string;
  type: FeedbackType;
  severity?: FeedbackSeverity | null;
  title: string;
  description: string;
  steps?: string | null;
  expected?: string | null;
  actual?: string | null;
  context: FeedbackContext;
  screenshotKeys: string[];
  captureKey: string | null;
  /** Optional free-text submitter metadata (NOT an identity claim). */
  submitterEmail?: string | null;
  submitterName?: string | null;
}

/** Insert a new feedback row. WRITE — throws on failure. */
export async function createFeedback(
  db: D1Database,
  data: CreateFeedbackData,
): Promise<FeedbackItem> {
  const drizzleDb = createDb(db);
  const n = await allocateFeedbackShortId(db);
  const now = new Date().toISOString();
  const row: FeedbackRow = {
    id: data.id,
    shortId: formatFeedbackShortId(n),
    type: data.type,
    severity: data.severity ?? null,
    priority: 0,
    status: 'new',
    title: data.title,
    description: data.description,
    steps: data.steps ?? null,
    expected: data.expected ?? null,
    actual: data.actual ?? null,
    contextJson: JSON.stringify(data.context),
    screenshotKeys: data.screenshotKeys.length ? JSON.stringify(data.screenshotKeys) : null,
    captureKey: data.captureKey,
    labels: null,
    area: null,
    assignee: null,
    triageNotes: null,
    linkedPr: null,
    externalRef: null,
    submitterEmail: data.submitterEmail ?? null,
    submitterName: data.submitterName ?? null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  };
  await drizzleDb.insert(feedback).values(row);
  return rowToFeedbackItem(row);
}

/** Filters for listing feedback. The single admin sees all — no submitter scope. */
export interface ListFeedbackFilters {
  status?: FeedbackStatus;
  type?: FeedbackType;
  priority?: number;
  since?: string;
  limit?: number;
  offset?: number;
}

/** List feedback rows (filtered). READ — swallows errors → []. */
export async function listFeedback(
  db: D1Database,
  filters: ListFeedbackFilters = {},
): Promise<FeedbackItem[]> {
  try {
    const drizzleDb = createDb(db);
    const conditions = [];
    if (filters.status) conditions.push(eq(feedback.status, filters.status));
    if (filters.type) conditions.push(eq(feedback.type, filters.type));
    if (typeof filters.priority === 'number') {
      conditions.push(eq(feedback.priority, filters.priority));
    }
    if (filters.since) conditions.push(gte(feedback.createdAt, filters.since));

    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const rows = await drizzleDb
      .select()
      .from(feedback)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(feedback.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map(rowToFeedbackItem);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'listFeedback failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return [];
  }
}

/** Get a single feedback row by id. READ — swallows errors → null. */
export async function getFeedbackById(db: D1Database, id: string): Promise<FeedbackItem | null> {
  try {
    const drizzleDb = createDb(db);
    const rows = await drizzleDb.select().from(feedback).where(eq(feedback.id, id)).limit(1);
    return rows[0] ? rowToFeedbackItem(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Apply a triage patch and return the updated row. WRITE — throws on failure. */
export async function triageFeedback(
  db: D1Database,
  id: string,
  patch: TriageFeedbackInput,
): Promise<FeedbackItem | null> {
  const drizzleDb = createDb(db);
  const now = new Date().toISOString();
  const set: Partial<FeedbackRow> = { updatedAt: now };

  if (patch.status !== undefined) {
    set.status = patch.status;
    set.resolvedAt = patch.status === 'resolved' ? now : null;
  }
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.severity !== undefined) set.severity = patch.severity;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.labels !== undefined) set.labels = patch.labels;
  if (patch.area !== undefined) set.area = patch.area;
  if (patch.assignee !== undefined) set.assignee = patch.assignee;
  if (patch.triageNotes !== undefined) set.triageNotes = patch.triageNotes;
  if (patch.linkedPr !== undefined) set.linkedPr = patch.linkedPr;
  if (patch.externalRef !== undefined) set.externalRef = patch.externalRef;

  await drizzleDb.update(feedback).set(set).where(eq(feedback.id, id));
  return getFeedbackById(db, id);
}

/** Delete a feedback row by id. WRITE — throws on failure. (R2 cleanup is the handler's job.) */
export async function deleteFeedback(db: D1Database, id: string): Promise<void> {
  const drizzleDb = createDb(db);
  await drizzleDb.delete(feedback).where(eq(feedback.id, id));
}

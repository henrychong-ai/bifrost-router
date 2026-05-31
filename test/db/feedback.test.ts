/**
 * D1 unit tests for the feedback work-queue helpers (v1.26.0).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  allocateFeedbackShortId,
  createFeedback,
  deleteFeedback,
  getFeedbackById,
  listFeedback,
  triageFeedback,
  type CreateFeedbackData,
} from '../../src/db/feedback';

const FEEDBACK_DDL = `
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY NOT NULL,
    short_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    severity TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'new',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    steps TEXT, expected TEXT, actual TEXT,
    context_json TEXT NOT NULL,
    screenshot_keys TEXT, capture_key TEXT,
    labels TEXT, area TEXT, assignee TEXT,
    triage_notes TEXT, linked_pr TEXT, external_ref TEXT,
    submitter_email TEXT, submitter_name TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
  )`;
const COUNTERS_DDL = `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL DEFAULT 0)`;

function data(overrides: Partial<CreateFeedbackData> = {}): CreateFeedbackData {
  return {
    id: crypto.randomUUID(),
    type: 'bug',
    title: 'Title',
    description: 'Description',
    context: { url: 'https://x', timestamp: '2026-05-30T00:00:00Z' },
    screenshotKeys: [],
    captureKey: null,
    submitterEmail: 'a@example.com',
    submitterName: 'A',
    ...overrides,
  };
}

describe('db/feedback', () => {
  beforeAll(async () => {
    await env.DB.prepare(FEEDBACK_DDL).run();
    await env.DB.prepare(COUNTERS_DDL).run();
  });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM feedback').run();
    await env.DB.prepare('DELETE FROM counters').run();
  });

  it('allocates F-<n> monotonically (atomic counter)', async () => {
    expect(await allocateFeedbackShortId(env.DB)).toBe(1);
    expect(await allocateFeedbackShortId(env.DB)).toBe(2);
    expect(await allocateFeedbackShortId(env.DB)).toBe(3);
  });

  it('creates rows with sequential short ids + defaults', async () => {
    const a = await createFeedback(env.DB, data());
    const b = await createFeedback(env.DB, data());
    expect(a.shortId).toBe('F-1');
    expect(b.shortId).toBe('F-2');
    expect(a.status).toBe('new');
    expect(a.priority).toBe(0);
    expect(a.resolvedAt).toBeNull();
  });

  it('round-trips context + array fields', async () => {
    const created = await createFeedback(env.DB, data({ screenshotKeys: ['feedback/x/s-0.png'] }));
    const got = await getFeedbackById(env.DB, created.id);
    expect(got?.context?.url).toBe('https://x');
    expect(got?.screenshotKeys).toEqual(['feedback/x/s-0.png']);
    expect(got?.submitterEmail).toBe('a@example.com');
  });

  it('accepts a submission with no submitter metadata', async () => {
    const created = await createFeedback(
      env.DB,
      data({ submitterEmail: null, submitterName: null }),
    );
    const got = await getFeedbackById(env.DB, created.id);
    expect(got?.submitterEmail).toBeNull();
    expect(got?.submitterName).toBeNull();
  });

  it('lists with type/status filters (admin sees all)', async () => {
    await createFeedback(env.DB, data({ type: 'bug' }));
    await createFeedback(env.DB, data({ type: 'feature' }));
    expect(await listFeedback(env.DB, {})).toHaveLength(2);
    expect(await listFeedback(env.DB, { type: 'feature' })).toHaveLength(1);
    expect(await listFeedback(env.DB, { type: 'bug' })).toHaveLength(1);
  });

  it('triages (resolved sets resolvedAt) and deletes', async () => {
    const item = await createFeedback(env.DB, data());
    const triaged = await triageFeedback(env.DB, item.id, {
      status: 'resolved',
      priority: 1,
      linkedPr: 'PR#9',
      area: 'routes',
    });
    expect(triaged?.status).toBe('resolved');
    expect(triaged?.resolvedAt).not.toBeNull();
    expect(triaged?.priority).toBe(1);
    expect(triaged?.linkedPr).toBe('PR#9');
    expect(triaged?.area).toBe('routes');

    await deleteFeedback(env.DB, item.id);
    expect(await getFeedbackById(env.DB, item.id)).toBeNull();
  });

  it('list degrades gracefully (returns []) before the migration', async () => {
    await env.DB.prepare('DROP TABLE IF EXISTS feedback').run();
    expect(await listFeedback(env.DB, {})).toEqual([]);
    await env.DB.prepare(FEEDBACK_DDL).run(); // restore for isolation
  });
});

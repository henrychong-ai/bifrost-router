/**
 * Behavioural tests for the feedback API (v1.26.0).
 *
 * Auth model: a single ADMIN_API_KEY gates the whole admin API. So every
 * feedback endpoint requires the key (401 without it), the single admin sees ALL
 * feedback (no submitter-scoping), and `submitter_*` are optional free-text
 * fields, NOT identity claims.
 *
 * The handler's async audit write runs in executionCtx.waitUntil — `fetchSettled`
 * passes a collectable ExecutionContext and awaits those promises before
 * returning, so the write completes inside the test's isolated-storage frame.
 *
 * NOTE: requires `FEEDBACK_BUCKET` in the miniflare r2Buckets list
 * (vitest.config.ts) — the main session adds it alongside the wrangler binding.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

const VALID_KEY = 'test-api-key-12345';
const BASE_URL = 'http://example.com/api/feedback';
const testEnv = { ...env, ADMIN_API_DOMAIN: 'example.com' };

let ipCounter = 0;

describe('feedback API - auth + lifecycle', () => {
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        domain TEXT NOT NULL, action TEXT NOT NULL, path TEXT,
        actor_login TEXT, actor_name TEXT, details TEXT, ip_address TEXT,
        source TEXT NOT NULL DEFAULT 'bifrost',
        created_at INTEGER DEFAULT (unixepoch()) NOT NULL
      )`).run();
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY NOT NULL, short_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, severity TEXT, priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'new', title TEXT NOT NULL, description TEXT NOT NULL,
        steps TEXT, expected TEXT, actual TEXT, context_json TEXT NOT NULL,
        screenshot_keys TEXT, capture_key TEXT, labels TEXT, area TEXT, assignee TEXT,
        triage_notes TEXT, linked_pr TEXT, external_ref TEXT,
        submitter_email TEXT, submitter_name TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
      )`).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL DEFAULT 0)`,
    ).run();
  });

  beforeEach(async () => {
    app = new Hono<AppEnv>().route('/api', adminRoutes);
    await env.DB.prepare('DELETE FROM feedback').run();
    await env.DB.prepare('DELETE FROM counters').run();
  });

  // app.fetch with a collectable ExecutionContext so waitUntil (audit) settles
  // before the call returns — keeps storage ops inside the isolated frame.
  async function fetchSettled(req: Request): Promise<Response> {
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        promises.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const res = await app.fetch(req, testEnv, ctx);
    await Promise.allSettled(promises);
    return res;
  }

  function submitReq(
    fields: Record<string, string>,
    files: File[] = [],
    apiKey: string | null = VALID_KEY,
  ): Request {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    for (const f of files) fd.append('screenshot', f, f.name);
    const headers: Record<string, string> = { 'CF-Connecting-IP': `10.0.0.${ipCounter++}` };
    if (apiKey) headers['X-Admin-Key'] = apiKey;
    return new Request(BASE_URL, { method: 'POST', headers, body: fd });
  }

  function jsonReq(
    method: string,
    url: string,
    body?: object,
    apiKey: string | null = VALID_KEY,
  ): Request {
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-Admin-Key'] = apiKey;
    if (body) headers['Content-Type'] = 'application/json';
    return new Request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  }

  const BASE = { type: 'bug', title: 'Login broken', description: 'It does nothing' };

  async function submit(fields = BASE, files: File[] = []): Promise<Response> {
    return fetchSettled(submitReq(fields, files));
  }

  it('rejects submit without an API key (401)', async () => {
    const res = await fetchSettled(submitReq(BASE, [], null));
    expect(res.status).toBe(401);
  });

  it('rejects submit with a wrong API key (401)', async () => {
    const res = await fetchSettled(submitReq(BASE, [], 'wrong-key'));
    expect(res.status).toBe(401);
  });

  it('submits (201) and gets F-1 with optional submitter metadata', async () => {
    const res = await submit({
      ...BASE,
      submitterEmail: 'someone@example.com',
      submitterName: 'Someone',
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      data: { shortId: string; submitterEmail: string | null };
    };
    expect(data.data.shortId).toBe('F-1');
    expect(data.data.submitterEmail).toBe('someone@example.com');
  });

  it('submits with no submitter metadata (201, null submitter)', async () => {
    const res = await submit(BASE);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { data: { submitterEmail: string | null } };
    expect(data.data.submitterEmail).toBeNull();
  });

  it('list returns ALL feedback (single-admin model)', async () => {
    await submit({ ...BASE, title: 'one' });
    await submit({ ...BASE, type: 'feature', title: 'two' });

    const list = (await (await fetchSettled(jsonReq('GET', BASE_URL))).json()) as {
      data: { feedback: unknown[]; total: number };
    };
    expect(list.data.feedback).toHaveLength(2);
    expect(list.data.total).toBe(2);
  });

  it('triage updates status (resolved sets resolvedAt)', async () => {
    const created = (await (await submit(BASE)).json()) as { data: { id: string } };
    const id = created.data.id;

    const patched = await fetchSettled(
      jsonReq('PATCH', `${BASE_URL}/${id}`, { status: 'resolved' }),
    );
    expect(patched.status).toBe(200);
    const patchedData = (await patched.json()) as {
      data: { status: string; resolvedAt: string | null };
    };
    expect(patchedData.data.status).toBe('resolved');
    expect(patchedData.data.resolvedAt).not.toBeNull();
  });

  it('export returns 200 (json)', async () => {
    await submit(BASE);
    const res = await fetchSettled(jsonReq('GET', `${BASE_URL}/export?format=json`));
    expect(res.status).toBe(200);
  });

  it('GET /:id returns the item, 404 for unknown', async () => {
    const created = (await (await submit(BASE)).json()) as { data: { id: string } };
    expect((await fetchSettled(jsonReq('GET', `${BASE_URL}/${created.data.id}`))).status).toBe(200);
    expect((await fetchSettled(jsonReq('GET', `${BASE_URL}/does-not-exist`))).status).toBe(404);
  });

  it('rejects an over-length title (400)', async () => {
    const res = await submit({ type: 'bug', title: 'x'.repeat(201), description: 'desc' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid type (400)', async () => {
    const res = await submit({ type: 'issue', title: 'ok', description: 'desc' });
    expect(res.status).toBe(400);
  });

  it('stores a screenshot, serves it (ownership + nosniff), and cascades on delete', async () => {
    const png = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' });
    const created = (await (await submit(BASE, [png])).json()) as {
      data: { id: string; screenshotKeys: string[] };
    };
    const { id, screenshotKeys } = created.data;
    expect(screenshotKeys).toHaveLength(1);

    // The attachment is fetchable (key belongs to the item). Consume the body so
    // the R2 stream is disposed before the test ends.
    const att = await fetchSettled(
      jsonReq('GET', `${BASE_URL}/${id}/attachment/${screenshotKeys[0]}`),
    );
    expect(att.status).toBe(200);
    // Stored attachments must never be sniffed/executed by the browser.
    expect(att.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(att.headers.get('Content-Disposition')).toBe('attachment');
    const bytes = new Uint8Array(await att.arrayBuffer());
    expect(bytes.byteLength).toBe(4);

    // A key NOT belonging to the item is rejected (no arbitrary bucket read).
    const stray = await fetchSettled(
      jsonReq('GET', `${BASE_URL}/${id}/attachment/feedback/other/secret.png`),
    );
    expect(stray.status).toBe(404);

    // Delete -> row gone, item 404s afterwards.
    expect((await fetchSettled(jsonReq('DELETE', `${BASE_URL}/${id}`))).status).toBe(200);
    expect((await fetchSettled(jsonReq('GET', `${BASE_URL}/${id}`))).status).toBe(404);
  });

  it('rejects an over-size screenshot (413)', async () => {
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    const res = await submit(BASE, [big]);
    expect(res.status).toBe(413);
  });

  it('rejects an empty triage patch (400)', async () => {
    const created = (await (await submit(BASE)).json()) as { data: { id: string } };
    const res = await fetchSettled(jsonReq('PATCH', `${BASE_URL}/${created.data.id}`, {}));
    expect(res.status).toBe(400);
  });
});

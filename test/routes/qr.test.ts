/**
 * Behavioural tests for the QR code API (v1.30.0 — ported feature, port-seam
 * coverage). These exercise the plain-Hono adaptation's handler-level
 * behaviours that the shared contract tests cannot reach: auth inheritance
 * (incl. the SVG image endpoints), the serialized-payload BYTE budget, the
 * same-domain linkedRoute guard, type immutability, ''-clears-description,
 * Wi-Fi credential redaction in audit projections, and the `qr:` KV-prefix
 * exclusion from route scans and inclusion in backups.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import { getAllRoutesAllDomains, createRoute } from '../../src/kv/routes';
import { backupKV } from '../../src/backup/kv';
import type { AppEnv } from '../../src/types';

const VALID_KEY = 'test-api-key-12345'; // gitleaks:allow — test placeholder, not a credential
const DOMAIN = 'example.com';
const OTHER_DOMAIN = 'secondary.example.net';
const BASE = `http://${DOMAIN}/api/qr`;
const testEnv = { ...env, ADMIN_API_DOMAIN: DOMAIN };

describe('QR API (v1.30.0 port seams)', () => {
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
  });

  beforeEach(() => {
    app = new Hono<AppEnv>().route('/api', adminRoutes);
  });

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

  function authedJson(method: string, url: string, body?: unknown): Request {
    return new Request(url, {
      method,
      headers: {
        'X-Admin-Key': VALID_KEY,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Auth inheritance — every QR endpoint sits behind the ADMIN_API_KEY chain
  // ---------------------------------------------------------------------------

  it('rejects unauthenticated requests on list, create, AND both SVG image endpoints', async () => {
    for (const [method, url] of [
      ['GET', BASE],
      ['POST', BASE],
      ['GET', `${BASE}/some-id/image`],
      ['GET', `${BASE}/from-route?path=/x`],
    ] as const) {
      const res = await fetchSettled(new Request(url, { method }));
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  // ---------------------------------------------------------------------------
  // CRUD + handler-level validation parity
  // ---------------------------------------------------------------------------

  it('creates, fetches, lists, and deletes a QR code (and 404s after delete)', async () => {
    const created = await fetchSettled(
      authedJson('POST', BASE, {
        type: 'url',
        id: 'test-crud',
        payload: { url: 'https://example.com/page' },
        description: 'CRUD test',
      }),
    );
    expect(created.status).toBe(201);

    const dup = await fetchSettled(
      authedJson('POST', BASE, {
        type: 'url',
        id: 'test-crud',
        payload: { url: 'https://example.com' },
      }),
    );
    expect(dup.status).toBe(409);

    const got = await fetchSettled(authedJson('GET', `${BASE}/test-crud`));
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { data: { id: string; description?: string } };
    expect(gotBody.data.id).toBe('test-crud');
    expect(gotBody.data.description).toBe('CRUD test');

    const list = await fetchSettled(authedJson('GET', BASE));
    const listBody = (await list.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(listBody.data.some(q => q.id === 'test-crud')).toBe(true);

    const del = await fetchSettled(authedJson('DELETE', `${BASE}/test-crud`));
    expect(del.status).toBe(200);
    const gone = await fetchSettled(authedJson('GET', `${BASE}/test-crud`));
    expect(gone.status).toBe(404);
  });

  it('enforces the serialized-payload BYTE budget (multibyte text passes the char cap but not the byte cap)', async () => {
    // 400 CJK chars: within the 800-char TextPayloadSchema cap, but ~1200
    // UTF-8 bytes — over MAX_QR_PAYLOAD_LENGTH (1024). The byte-oriented
    // check (upstream codex F2) must reject with a byte count.
    const res = await fetchSettled(
      authedJson('POST', BASE, { type: 'text', payload: { text: '測'.repeat(400) } }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/bytes/);
  });

  it('rejects a linkedRoute on a different domain (route-existence oracle guard)', async () => {
    const res = await fetchSettled(
      authedJson('POST', BASE, {
        type: 'url',
        payload: { url: 'https://example.com' },
        linkedRoute: { domain: OTHER_DOMAIN, path: '/foreign' },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/must match the QR domain/);
  });

  it('rejects changing the type on update (immutable), and treats explicit "" as clear-description', async () => {
    await fetchSettled(
      authedJson('POST', BASE, {
        type: 'text',
        id: 'test-immutable',
        payload: { text: 'hello' },
        description: 'has description',
      }),
    );

    const typeChange = await fetchSettled(
      authedJson('PUT', `${BASE}/test-immutable`, { type: 'url' }),
    );
    expect(typeChange.status).toBe(400);
    expect(await typeChange.text()).toMatch(/cannot change/);

    const cleared = await fetchSettled(
      authedJson('PUT', `${BASE}/test-immutable`, { description: '' }),
    );
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { data: { description?: string } };
    expect(body.data.description).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Wi-Fi credential redaction in the audit projection
  // ---------------------------------------------------------------------------

  it('redacts wifi password/identity/anonymousIdentity in the audit row, not the record', async () => {
    const created = await fetchSettled(
      authedJson('POST', BASE, {
        type: 'wifi',
        id: 'test-wifi-audit',
        payload: {
          ssid: 'CorpNet',
          auth: 'WPA2-EAP',
          eapMethod: 'PEAP',
          phase2: 'MSCHAPV2',
          identity: 'user@example.com',
          anonymousIdentity: 'anon@example.com',
          password: 'super-secret-pw',
          hidden: false,
        },
      }),
    );
    expect(created.status).toBe(201);
    // The stored record keeps the credentials (locked upstream decision)…
    const record = (await created.json()) as { data: { payload: { password: string } } };
    expect(record.data.payload.password).toBe('super-secret-pw');

    // …but the audit projection masks all three credential-class fields.
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_logs WHERE action = 'qr_create' AND path = '/qr/test-wifi-audit' ORDER BY id DESC LIMIT 1`,
    ).first<{ details: string }>();
    expect(audit).toBeTruthy();
    expect(audit!.details).not.toContain('super-secret-pw');
    expect(audit!.details).not.toContain('user@example.com');
    expect(audit!.details).not.toContain('anon@example.com');
    expect(audit!.details).toContain('[redacted]');
  });

  // ---------------------------------------------------------------------------
  // Image endpoints — authed SVG with no-store caching
  // ---------------------------------------------------------------------------

  it('serves the stored-record SVG and the ephemeral from-route SVG with private, no-store', async () => {
    await fetchSettled(
      authedJson('POST', BASE, {
        type: 'url',
        id: 'test-image',
        payload: { url: 'https://example.com' },
      }),
    );
    const img = await fetchSettled(authedJson('GET', `${BASE}/test-image/image`));
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(img.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await img.text()).toContain('<svg');

    // from-route: 404 when no route exists at the path…
    const missing = await fetchSettled(authedJson('GET', `${BASE}/from-route?path=/no-such-route`));
    expect(missing.status).toBe(404);

    // …and an SVG once the route exists.
    await createRoute(env.ROUTES, DOMAIN, {
      path: '/qr-target',
      type: 'redirect',
      target: 'https://example.com/target',
    });
    const ok = await fetchSettled(authedJson('GET', `${BASE}/from-route?path=/qr-target`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
  });

  // ---------------------------------------------------------------------------
  // KV cohabitation — route scans exclude qr: keys; backups include them
  // ---------------------------------------------------------------------------

  it('never surfaces qr: records as routes in the all-domains scan', async () => {
    await fetchSettled(
      authedJson('POST', BASE, {
        type: 'text',
        id: 'test-cohab',
        payload: { text: 'kv cohabitation' },
      }),
    );
    const routes = await getAllRoutesAllDomains(env.ROUTES);
    const leaked = routes.filter(
      r =>
        (r as { path?: string }).path?.includes('test-cohab') ||
        (r as { domain?: string }).domain === 'qr',
    );
    expect(leaked).toEqual([]);
  });

  it('includes qr: records in the daily KV backup alongside routes (v1.30.0 regression)', async () => {
    await createRoute(env.ROUTES, DOMAIN, {
      path: '/backup-probe',
      type: 'redirect',
      target: 'https://example.com',
    });
    await fetchSettled(
      authedJson('POST', BASE, {
        type: 'text',
        id: 'test-backup',
        payload: { text: 'back me up' },
      }),
    );

    const result = await backupKV(env.ROUTES, env.BACKUP_BUCKET, '20260724');
    const obj = await env.BACKUP_BUCKET.get(result.file);
    expect(obj).toBeTruthy();
    const buf = await obj!.arrayBuffer();
    const ds = new DecompressionStream('gzip');
    const text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
    expect(text).toContain(`"${DOMAIN}:/backup-probe"`);
    expect(text).toContain(`"qr:${DOMAIN}:test-backup"`);
  });
});

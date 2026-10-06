/**
 * Behavioural tests for the QR code API (v1.30.0 — ported feature, port-seam
 * coverage). These exercise the plain-Hono adaptation's handler-level
 * behaviours that the shared contract tests cannot reach: auth inheritance
 * (incl. the SVG image endpoints), the serialized-payload BYTE budget, the
 * same-domain linkedRoute guard, type immutability, ''-clears-description,
 * Wi-Fi credential redaction in audit projections, and the `qr:` KV-prefix
 * exclusion from route scans and inclusion in backups.
 */

import { env } from 'cloudflare:test';
import { MAX_QR_RECORD_BYTES, MAX_ROUTE_RECORD_BYTES, type QRCode } from '@bifrost/shared';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECORD_LINE_BYTES } from '../../src/backup/integrity';
import { backupKV } from '../../src/backup/kv';
import { putQR } from '../../src/kv/qr';
import { createRoute, getAllRoutesAllDomains } from '../../src/kv/routes';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

const VALID_KEY = 'test-api-key-12345'; // gitleaks:allow — test placeholder, not a credential
const DOMAIN = 'example.com';
const OTHER_DOMAIN = 'secondary.example.net';
const BASE = `http://${DOMAIN}/api/qr`;
const testEnv = { ...env, ADMIN_API_DOMAIN: DOMAIN };

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
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'url',
        id: 'test-crud',
        payload: { url: 'https://example.com/page' },
        description: 'CRUD test',
      }),
    );
    expect(created.status).toBe(201);

    const dup = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
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

    const del = await fetchSettled(authedJson('DELETE', `${BASE}/test-crud?domain=${DOMAIN}`));
    expect(del.status).toBe(200);
    const gone = await fetchSettled(authedJson('GET', `${BASE}/test-crud`));
    expect(gone.status).toBe(404);
  });

  it('refuses QR create, update and delete without a domain; reads still default', async () => {
    const noDomainCreate = await fetchSettled(
      authedJson('POST', BASE, {
        type: 'url',
        id: 'test-nodomain',
        payload: { url: 'https://example.com' },
      }),
    );
    expect(noDomainCreate.status).toBe(400);
    expect(await noDomainCreate.text()).toContain('An explicit domain is required');
    // Nothing was written to ADMIN_API_DOMAIN's namespace
    expect((await fetchSettled(authedJson('GET', `${BASE}/test-nodomain`))).status).toBe(404);

    const created = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'url',
        id: 'test-nodomain',
        payload: { url: 'https://example.com' },
        description: 'kept',
      }),
    );
    expect(created.status).toBe(201);

    const noDomainUpdate = await fetchSettled(
      authedJson('PUT', `${BASE}/test-nodomain`, { description: 'changed' }),
    );
    expect(noDomainUpdate.status).toBe(400);
    const noDomainDelete = await fetchSettled(authedJson('DELETE', `${BASE}/test-nodomain`));
    expect(noDomainDelete.status).toBe(400);

    // A domainless GET still reads ADMIN_API_DOMAIN: the record is intact
    const got = await fetchSettled(authedJson('GET', `${BASE}/test-nodomain`));
    expect(got.status).toBe(200);
    expect(((await got.json()) as { data: { description?: string } }).data.description).toBe(
      'kept',
    );

    const conflict = await fetchSettled(
      new Request(`${BASE}/test-nodomain?domain=${OTHER_DOMAIN}`, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': VALID_KEY, 'X-Domain': DOMAIN },
      }),
    );
    expect(conflict.status).toBe(400);
    expect((await fetchSettled(authedJson('GET', `${BASE}/test-nodomain`))).status).toBe(200);

    expect(
      (await fetchSettled(authedJson('DELETE', `${BASE}/test-nodomain?domain=${DOMAIN}`))).status,
    ).toBe(200);
  });

  it('answers 400 for a read whose X-Domain conflicts with ?domain', async () => {
    const res = await fetchSettled(
      new Request(`${BASE}?domain=${OTHER_DOMAIN}`, {
        headers: { 'X-Admin-Key': VALID_KEY, 'X-Domain': DOMAIN },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Conflicting domain parameters');
  });

  it('answers 400 for a read naming an unsupported domain (read resolver)', async () => {
    for (const url of [`${BASE}?domain=evil.test`, `${BASE}/any?domain=evil.test`]) {
      const res = await fetchSettled(authedJson('GET', url));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Invalid domain: evil.test');
    }
  });

  it('enforces the serialized-payload BYTE budget (multibyte text passes the char cap but not the byte cap)', async () => {
    // 400 CJK chars: within the 800-char TextPayloadSchema cap, but ~1200
    // UTF-8 bytes — over MAX_QR_PAYLOAD_LENGTH (1024). The byte-oriented
    // check must reject with a byte count.
    const res = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'text',
        payload: { text: '測'.repeat(400) },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/bytes/);
  });

  it('rejects a linkedRoute on a different domain (route-existence oracle guard)', async () => {
    const res = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'url',
        payload: { url: 'https://example.com' },
        linkedRoute: { domain: OTHER_DOMAIN, path: '/foreign' },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/must match the QR domain/);
  });

  it('rejects a linkedRoute on an unsupported domain before the same-domain guard', async () => {
    const res = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'url',
        id: 'test-bad-link',
        payload: { url: 'https://example.com' },
        linkedRoute: { domain: 'evil.test', path: '/foreign' },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    // Refused by the body schema (the supported-domain enum), not the same-domain guard
    expect(body).toMatch(/Invalid option: expected one of "example\.com"/);
    expect(body).not.toMatch(/must match the QR domain/);
    expect((await fetchSettled(authedJson('GET', `${BASE}/test-bad-link`))).status).toBe(404);
  });

  // v1.37.2: a QR record is one line of the nightly backup, so a linked path
  // follows the route path rules and the route key limit
  it('rejects a 2 MiB linkedRoute.path on create and update, writing nothing', async () => {
    const huge = `/${'a'.repeat(2 * 1024 * 1024)}`;
    const created = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'url',
        id: 'test-huge-link',
        payload: { url: 'https://example.com' },
        linkedRoute: { domain: DOMAIN, path: huge },
      }),
    );
    expect(created.status).toBe(400);
    expect(await created.text()).toMatch(/Route path is too long for this domain/);
    expect(
      (await fetchSettled(authedJson('GET', `${BASE}/test-huge-link?domain=${DOMAIN}`))).status,
    ).toBe(404);

    await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'url',
        id: 'test-link-update',
        payload: { url: 'https://example.com' },
      }),
    );
    const updated = await fetchSettled(
      authedJson('PUT', `${BASE}/test-link-update?domain=${DOMAIN}`, {
        linkedRoute: { domain: DOMAIN, path: huge },
      }),
    );
    expect(updated.status).toBe(400);
    const stored = await env.ROUTES.get(`qr:${DOMAIN}:test-link-update`, 'json');
    expect(stored).not.toHaveProperty('linkedRoute');
  });

  it('refuses a QR record over the record cap at the KV writer, writing nothing', async () => {
    const now = Date.now();
    const record = {
      id: 'test-oversized',
      domain: DOMAIN,
      type: 'url',
      payload: { url: 'https://example.com' },
      description: 'x'.repeat(MAX_QR_RECORD_BYTES),
      tags: [],
      design: {},
      createdBy: 'test',
      createdAt: now,
      updatedAt: now,
    } as unknown as QRCode;
    await expect(putQR(env.ROUTES, record)).rejects.toMatchObject({ status: 400 });
    expect(await env.ROUTES.get(`qr:${DOMAIN}:test-oversized`)).toBeNull();
  });

  it('keeps every record cap at most a quarter of the backup line limit', () => {
    for (const cap of [MAX_QR_RECORD_BYTES, MAX_ROUTE_RECORD_BYTES]) {
      expect(cap).toBeLessThanOrEqual(MAX_RECORD_LINE_BYTES / 4);
    }
  });

  it('rejects changing the type on update (immutable), and treats explicit "" as clear-description', async () => {
    await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'text',
        id: 'test-immutable',
        payload: { text: 'hello' },
        description: 'has description',
      }),
    );

    const typeChange = await fetchSettled(
      authedJson('PUT', `${BASE}/test-immutable?domain=${DOMAIN}`, { type: 'url' }),
    );
    expect(typeChange.status).toBe(400);
    expect(await typeChange.text()).toMatch(/cannot change/);

    const cleared = await fetchSettled(
      authedJson('PUT', `${BASE}/test-immutable?domain=${DOMAIN}`, { description: '' }),
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
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
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
    // The stored record keeps the credentials (a locked design decision)…
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
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
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
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
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
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
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

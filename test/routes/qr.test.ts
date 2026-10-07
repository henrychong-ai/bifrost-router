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
import {
  MAX_QR_RECORD_BYTES,
  MAX_ROUTE_RECORD_BYTES,
  type QRCode,
  QRDesignSchema,
  renderQrSvg,
} from '@bifrost/shared';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECORD_LINE_BYTES } from '../../src/backup/integrity';
import { backupKV } from '../../src/backup/kv';
import { putQR } from '../../src/kv/qr';
import { createRoute, getAllRoutesAllDomains } from '../../src/kv/routes';
import { qrKey, routeKey } from '../../src/kv/schema';
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

  // ---------------------------------------------------------------------------
  // v1.38.0: deleted incarnations, QR_NOT_FOUND, patch-only limits, unknown fields
  // ---------------------------------------------------------------------------

  it('answers a delete with the deleted code: its id and createdAt, the incarnation it removed', async () => {
    const created = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'text',
        id: 'test-incarnation',
        payload: { text: 'tick' },
      }),
    );
    const record = ((await created.json()) as { data: QRCode }).data;
    const deleted = await fetchSettled(
      authedJson('DELETE', `${BASE}/test-incarnation?domain=${DOMAIN}`),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      success: true,
      data: { deleted: true, id: 'test-incarnation', createdAt: record.createdAt },
    });
    // No clock header: deletions are named by incarnation, never timed
    expect(deleted.headers.get('X-Server-Time')).toBeNull();
  });

  it('answers a missing code with a JSON QR_NOT_FOUND on read, update and delete', async () => {
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { description: 'x' }],
      ['DELETE', undefined],
    ] as const) {
      const response = await fetchSettled(
        authedJson(method, `${BASE}/test-never-made?domain=${DOMAIN}`, body),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        success: false,
        error: 'QR_NOT_FOUND',
        message: 'QR code not found: test-never-made',
      });
    }
  });

  it("applies today's limits to the fields an update sets, never to the ones it keeps", async () => {
    const now = Date.now();
    const legacy = {
      id: 'test-legacy-caps',
      domain: DOMAIN,
      type: 'url',
      payload: { url: 'https://example.com/legacy' },
      description: 'd'.repeat(120),
      tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`),
      design: {},
      createdBy: 'test',
      createdAt: now,
      updatedAt: now,
    };
    await env.ROUTES.put(`qr:${DOMAIN}:test-legacy-caps`, JSON.stringify(legacy));

    const listed = await fetchSettled(authedJson('GET', `${BASE}?domain=${DOMAIN}&search=legacy`));
    const page = (await listed.json()) as { data: QRCode[] };
    expect(page.data.map(qr => qr.id)).toContain('test-legacy-caps');

    const designOnly = await fetchSettled(
      authedJson('PUT', `${BASE}/test-legacy-caps?domain=${DOMAIN}`, {
        design: { fg: '#112233' },
      }),
    );
    expect(designOnly.status).toBe(200);
    const updated = ((await designOnly.json()) as { data: QRCode }).data;
    expect(updated.design.fg).toBe('#112233');
    expect(updated.description).toBe(legacy.description);
    expect(updated.tags).toEqual(legacy.tags);

    const overCap = await fetchSettled(
      authedJson('PUT', `${BASE}/test-legacy-caps?domain=${DOMAIN}`, {
        description: 'e'.repeat(101),
      }),
    );
    expect(overCap.status).toBe(400);
  });

  it('drops unknown fields, top-level and nested, on update and from the audit snapshot', async () => {
    const now = Date.now();
    await env.ROUTES.put(
      `qr:${DOMAIN}:test-junk`,
      JSON.stringify({
        id: 'test-junk',
        domain: DOMAIN,
        type: 'wifi',
        payload: { ssid: 'Office', auth: 'WPA', password: 'pw', legacySecret: 'junk-payload' },
        design: { fg: '#000000', junkDesign: 'junk-design' },
        legacySecret: 'junk-top',
        createdBy: 'test',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const response = await fetchSettled(
      authedJson('PUT', `${BASE}/test-junk?domain=${DOMAIN}`, { description: 'Office network' }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('junk-');
    const stored = (await env.ROUTES.get(`qr:${DOMAIN}:test-junk`)) ?? '';
    expect(stored).toContain('Office network');
    expect(stored).not.toContain('junk-');
    expect(stored).not.toContain('legacySecret');
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_logs WHERE action = 'qr_update' AND path = '/qr/test-junk' ORDER BY id DESC LIMIT 1`,
    ).first<{ details: string }>();
    expect(audit?.details).toContain('Office network');
    expect(audit?.details).not.toContain('junk-');
  });

  it('list search ignores case and separators and takes words in any order', async () => {
    await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'text',
        id: 'summer-sale-flyer',
        payload: { text: 'flyer' },
        description: 'Front desk flyer',
      }),
    );
    for (const query of ['sale summer', 'Summer_Sale', 'summersale', 'desk front']) {
      const response = await fetchSettled(
        authedJson('GET', `${BASE}?domain=${DOMAIN}&search=${encodeURIComponent(query)}`),
      );
      const body = (await response.json()) as { data: QRCode[] };
      expect(body.data.map(qr => `${query}:${qr.id}`)).toContain(`${query}:summer-sale-flyer`);
    }
    const tooLong = await fetchSettled(
      authedJson('GET', `${BASE}?domain=${DOMAIN}&search=${'x'.repeat(2049)}`),
    );
    expect(tooLong.status).toBe(400);
  });

  it('encodes the short URL while the linked route exists, also when it cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fetchSettled(
        authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
          type: 'url',
          id: 'test-linked-img',
          payload: { url: 'https://example.net/fallback' },
          linkedRoute: { domain: DOMAIN, path: '/linked-img' },
        }),
      );
      const design = QRDesignSchema.parse({});
      const image = async () =>
        (await fetchSettled(authedJson('GET', `${BASE}/test-linked-img/image`))).text();
      // No route: the stored payload
      expect(await image()).toBe(renderQrSvg('https://example.net/fallback', design));
      // An unreadable route is still a route: its short URL, never the payload
      await env.ROUTES.put(routeKey(DOMAIN, '/linked-img'), '{"broken"');
      expect(await image()).toBe(renderQrSvg(`https://${DOMAIN}/linked-img`, design));
      // A readable route: its short URL
      await env.ROUTES.delete(routeKey(DOMAIN, '/linked-img'));
      await createRoute(env.ROUTES, DOMAIN, {
        path: '/linked-img',
        type: 'redirect',
        target: 'https://example.com/t',
      });
      expect(await image()).toBe(renderQrSvg(`https://${DOMAIN}/linked-img`, design));
      // from-route refuses an unreadable route as every route read does
      await env.ROUTES.put(routeKey(DOMAIN, '/linked-img'), '{"broken"');
      const fromRoute = await fetchSettled(
        authedJson('GET', `${BASE}/from-route?path=/linked-img`),
      );
      expect(fromRoute.status).toBe(409);
      expect(await fromRoute.json()).toMatchObject({ error: 'ROUTE_RECORD_INVALID' });
    } finally {
      await env.ROUTES.delete(routeKey(DOMAIN, '/linked-img'));
      warn.mockRestore();
    }
  });

  it('deletes an unreadable code with one read, auditing its key and state only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = qrKey(DOMAIN, 'test-unreadable');
    await env.ROUTES.put(key, '{"payload":{"password":"never-quoted"}');
    const get = vi.spyOn(env.ROUTES, 'get');
    try {
      const response = await fetchSettled(
        authedJson('DELETE', `${BASE}/test-unreadable?domain=${DOMAIN}`),
      );
      expect(response.status).toBe(200);
      // No createdAt: the record that was deleted could not be read
      expect(await response.json()).toEqual({
        success: true,
        data: { deleted: true, id: 'test-unreadable' },
      });
      expect(get.mock.calls.filter(call => call[0] === key)).toHaveLength(1);
    } finally {
      get.mockRestore();
      warn.mockRestore();
    }
    expect(await env.ROUTES.get(key)).toBeNull();
    const audit = await env.DB.prepare(
      `SELECT details FROM audit_logs WHERE action = 'qr_delete' AND path = '/qr/test-unreadable' ORDER BY id DESC LIMIT 1`,
    ).first<{ details: string }>();
    expect(JSON.parse(audit?.details ?? '{}')).toEqual({
      id: 'test-unreadable',
      key,
      state: 'invalid',
    });
  });

  it('deletes a readable code with one read', async () => {
    await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'text',
        id: 'test-one-read',
        payload: { text: 'x' },
      }),
    );
    const key = qrKey(DOMAIN, 'test-one-read');
    const get = vi.spyOn(env.ROUTES, 'get');
    try {
      const response = await fetchSettled(
        authedJson('DELETE', `${BASE}/test-one-read?domain=${DOMAIN}`),
      );
      expect(response.status).toBe(200);
      expect(get.mock.calls.filter(call => call[0] === key)).toHaveLength(1);
    } finally {
      get.mockRestore();
    }
  });
});

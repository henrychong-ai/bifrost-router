/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */
/**
 * Contact cards as vCard 3.0 through the QR API (v1.42.0): a create with the
 * new fields, the image it serves, the write rules the Worker applies, a
 * MECARD-era card that still reads and renders, and its edit into the new
 * fields.
 */

import { env } from 'cloudflare:test';
import { type QRCode, QRDesignSchema, renderQrSvg, serializeVcard } from '@bifrost/shared';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import migration0013 from '../../drizzle/0013_qr_recent.sql?raw';
import { qrKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

const VALID_KEY = 'test-api-key-12345'; // gitleaks:allow — test placeholder, not a credential
const DOMAIN = 'example.com';
const BASE = `http://${DOMAIN}/api/qr`;
const testEnv = { ...env, ADMIN_API_DOMAIN: DOMAIN };

function authedJson(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'X-Admin-Key': VALID_KEY, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const CARD = {
  firstName: 'Jane',
  surname: 'Doe',
  org: 'Example Widgets, Inc.',
  title: 'Head of Operations',
  phones: [
    { number: '+1 555 0100', type: 'work' },
    { number: '+1 555 0199', type: 'main' },
  ],
  email: 'jane.doe@example.com',
  url: 'example.com',
  address: { street: 'Suite 12, 100 Main Street', city: 'Springfield', country: 'Exampleland' },
} as const;

describe('contact cards as vCard 3.0 (v1.42.0)', () => {
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
    const statements = migration0013
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map(statement => statement.trim())
      .filter(statement => statement.length > 0);
    for (const statement of statements) await env.DB.prepare(statement).run();
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

  it('creates a card with the new fields and serves its vCard 3.0 image', async () => {
    const created = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        id: 'jane-doe',
        type: 'vcard',
        payload: CARD,
      }),
    );
    expect(created.status).toBe(201);
    const record = ((await created.json()) as { data: QRCode }).data;
    expect(record.payload).toEqual(CARD);

    const image = await fetchSettled(authedJson('GET', `${BASE}/jane-doe/image`));
    expect(image.status).toBe(200);
    expect(await image.text()).toBe(renderQrSvg(serializeVcard(CARD), record.design));
  });

  it('refuses a card without a name, a control character, a blank phone or a legacy conflict', async () => {
    for (const payload of [
      { org: 'Example' },
      { firstName: 'Jane', title: 'A\u0000B' },
      { firstName: 'Jane', url: 'https://example.com\nX' },
      { firstName: 'Jane', email: 'jane@example.com\n' },
      { firstName: 'Jane', phones: [{ number: ' ', type: 'work' }] },
      { name: 'Jane', firstName: 'Jane' },
    ]) {
      const res = await fetchSettled(
        authedJson('POST', `${BASE}?domain=${DOMAIN}`, { type: 'vcard', payload }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('refuses a card whose shown name has no letter or digit', async () => {
    for (const [id, payload] of [
      ['card-invisible', { firstName: '\u200b\u200d' }],
      ['card-hidden-display', { firstName: 'Jane', displayName: '\u200b' }],
      ['card-emoji', { firstName: '\u{1F600}' }],
      // A Hangul filler: a letter in Unicode that displays as nothing
      ['card-filler', { firstName: 'Jane', displayName: String.fromCodePoint(0x3164) }],
    ] as const) {
      const res = await fetchSettled(
        authedJson('POST', `${BASE}?domain=${DOMAIN}`, { type: 'vcard', id, payload }),
      );
      expect({ id, status: res.status }).toEqual({ id, status: 400 });
    }
    const ok = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'vcard',
        id: 'card-visible-display',
        payload: { firstName: '\u200b', displayName: 'Jane Doe' },
      }),
    );
    expect(ok.status).toBe(201);
  });

  it('reads, lists, renders and edits a stored card whose shown name has no letter or digit', async () => {
    const payload = { firstName: 'Jane', displayName: '\u200b' };
    await env.ROUTES.put(
      qrKey(DOMAIN, 'card-hidden-name'),
      JSON.stringify({
        id: 'card-hidden-name',
        domain: DOMAIN,
        type: 'vcard',
        payload,
        design: QRDesignSchema.parse({}),
        createdAt: 1,
        updatedAt: 2,
        createdBy: 'test',
      }),
    );
    const got = await fetchSettled(authedJson('GET', `${BASE}/card-hidden-name?domain=${DOMAIN}`));
    expect(got.status).toBe(200);
    expect(((await got.json()) as { data: QRCode }).data.payload).toEqual(payload);
    const listed = await fetchSettled(authedJson('GET', `${BASE}?domain=${DOMAIN}`));
    expect(((await listed.json()) as { data: QRCode[] }).data.map(qr => qr.id)).toContain(
      'card-hidden-name',
    );
    const image = await fetchSettled(
      authedJson('GET', `${BASE}/card-hidden-name/image?domain=${DOMAIN}`),
    );
    expect(image.status).toBe(200);
    expect(await image.text()).toBe(renderQrSvg(serializeVcard(payload), QRDesignSchema.parse({})));
    // Edits that leave the payload alone are accepted; resending it is a write
    const put = (body: Record<string, unknown>) =>
      fetchSettled(authedJson('PUT', `${BASE}/card-hidden-name?domain=${DOMAIN}`, body));
    const described = await put({ description: 'Renamed' });
    expect(described.status).toBe(200);
    expect(((await described.json()) as { data: QRCode }).data.payload).toEqual(payload);
    expect((await put({ tags: ['team'] })).status).toBe(200);
    expect((await put({ payload })).status).toBe(400);
  });

  it('refuses a card whose vCard is over the 1 KB payload budget', async () => {
    const res = await fetchSettled(
      authedJson('POST', `${BASE}?domain=${DOMAIN}`, {
        type: 'vcard',
        payload: {
          // The shown name needs a letter or digit
          firstName: `J${';'.repeat(127)}`,
          surname: ';'.repeat(128),
          org: ';'.repeat(128),
          title: ';'.repeat(128),
          address: { street: ';'.repeat(128) },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Serialized payload is \d+ bytes \(max 1024\)/);
  });

  it('a MECARD-era card still reads and renders as a vCard, and an edit moves it to the new fields', async () => {
    const legacy = {
      id: 'legacy-card',
      domain: DOMAIN,
      type: 'vcard',
      // Written before the write rules: a website with a line break
      payload: { name: 'Jane Doe', phone: '+1 555 0100', url: 'https://example.com\nX' },
      design: QRDesignSchema.parse({}),
      createdAt: 1,
      updatedAt: 1,
      createdBy: 'test',
    };
    await env.ROUTES.put(qrKey(DOMAIN, 'legacy-card'), JSON.stringify(legacy));

    const read = await fetchSettled(authedJson('GET', `${BASE}/legacy-card?domain=${DOMAIN}`));
    expect(read.status).toBe(200);
    const image = await fetchSettled(authedJson('GET', `${BASE}/legacy-card/image`));
    expect(await image.text()).toBe(
      renderQrSvg(
        'BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Jane Doe;;;\r\nFN:Jane Doe\r\nTEL;TYPE=WORK,VOICE:+1 555 0100\r\nURL:https://example.comX\r\nEND:VCARD',
        legacy.design,
      ),
    );

    // A description edit leaves the stored payload alone
    const described = await fetchSettled(
      authedJson('PUT', `${BASE}/legacy-card?domain=${DOMAIN}`, { description: 'Front desk' }),
    );
    expect(described.status).toBe(200);
    expect(((await described.json()) as { data: QRCode }).data.payload).toEqual(legacy.payload);

    const moved = await fetchSettled(
      authedJson('PUT', `${BASE}/legacy-card?domain=${DOMAIN}`, {
        payload: {
          firstName: 'Jane',
          surname: 'Doe',
          phones: [{ number: '+1 555 0100', type: 'work' }],
        },
      }),
    );
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { data: QRCode }).data.payload).toEqual({
      firstName: 'Jane',
      surname: 'Doe',
      phones: [{ number: '+1 555 0100', type: 'work' }],
    });
  });
});

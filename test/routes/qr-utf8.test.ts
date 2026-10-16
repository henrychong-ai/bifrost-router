/* oxlint-disable import/default -- Vite ?raw imports return a string as default export */
/**
 * Unpaired surrogates through the QR API (v1.42.1): create and update of every
 * type refuse one with a 400 naming the field, never its value; an emoji card
 * creates and renders; a stored record holding one still reads and renders as
 * U+FFFD.
 */

import { env } from 'cloudflare:test';
import {
  QR_TEXT_MALFORMED_MESSAGE,
  QRDesignSchema,
  renderQrSvg,
  serializePayload,
} from '@bifrost/shared';
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

const LONE = '\ud83d';

describe('unpaired surrogates in payload text (v1.42.1)', () => {
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

  const create = (body: Record<string, unknown>) =>
    fetchSettled(authedJson('POST', `${BASE}?domain=${DOMAIN}`, body));
  const put = (id: string, body: Record<string, unknown>) =>
    fetchSettled(authedJson('PUT', `${BASE}/${id}?domain=${DOMAIN}`, body));

  // One valid payload per type, and the same payload with a lone surrogate in a text field
  const types = [
    ['url', { url: 'https://example.com/a' }, { url: `https://example.com/${LONE}` }],
    ['text', { text: 'Hello' }, { text: `Hello ${LONE}` }],
    ['wifi', { ssid: 'Office', password: 'secret' }, { ssid: 'Office', password: `se${LONE}cret` }],
    [
      'vcard',
      { firstName: 'Jane', surname: 'Doe' },
      { firstName: 'Jane', surname: 'Doe', address: { city: `Spring${LONE}` } },
    ],
  ] as const;

  it.each(types)('refuses one on create and update of a %s code', async (type, valid, bad) => {
    const created = await create({ type, payload: bad });
    expect(created.status).toBe(400);
    expect(await created.text()).toContain(QR_TEXT_MALFORMED_MESSAGE);

    const id = `lone-${type}`;
    expect((await create({ type, id, payload: valid })).status).toBe(201);
    const updated = await put(id, { payload: bad });
    expect(updated.status).toBe(400);
    expect(await updated.text()).toContain(QR_TEXT_MALFORMED_MESSAGE);
  });

  it('creates an emoji card and renders it', async () => {
    const payload = { firstName: 'Jane 🌸', surname: 'Doe', title: '🚀 Lead' };
    expect((await create({ type: 'vcard', id: 'emoji-card', payload })).status).toBe(201);
    const res = await fetchSettled(authedJson('GET', `${BASE}/emoji-card/image?domain=${DOMAIN}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      renderQrSvg(serializePayload('vcard', payload), QRDesignSchema.parse({})),
    );
  });

  it('a stored record holding one still reads and renders, as U+FFFD', async () => {
    const stored = {
      id: 'lone-stored',
      domain: DOMAIN,
      type: 'text',
      payload: { text: `A${LONE}B` },
      design: QRDesignSchema.parse({}),
      createdAt: 1,
      updatedAt: 2,
      createdBy: 'legacy',
    };
    await env.ROUTES.put(qrKey(DOMAIN, 'lone-stored'), JSON.stringify(stored));
    const got = await fetchSettled(authedJson('GET', `${BASE}/lone-stored?domain=${DOMAIN}`));
    expect(got.status).toBe(200);
    const res = await fetchSettled(authedJson('GET', `${BASE}/lone-stored/image?domain=${DOMAIN}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(renderQrSvg('A\ufffdB', QRDesignSchema.parse({})));
    // A description edit leaves the stored payload as it is
    expect((await put('lone-stored', { description: 'Renamed' })).status).toBe(200);
  });

  it('names the refused contact-card field on create and update, never its value', async () => {
    const created = await create({
      type: 'vcard',
      payload: { firstName: 'Jane', address: { city: `Spring${LONE}` } },
    });
    expect(created.status).toBe(400);
    const createdText = await created.text();
    expect(createdText).toContain(`${QR_TEXT_MALFORMED_MESSAGE} (field: address.city)`);
    expect(createdText).not.toContain('Spring');

    expect(
      (await create({ type: 'vcard', id: 'lone-field', payload: { firstName: 'Jane' } })).status,
    ).toBe(201);
    const updated = await put('lone-field', {
      payload: { firstName: 'Jane', phones: [{ number: `+1 555${LONE}`, type: 'cell' }] },
    });
    expect(updated.status).toBe(400);
    const updatedText = await updated.text();
    expect(updatedText).toContain(`${QR_TEXT_MALFORMED_MESSAGE} (field: phones.0.number)`);
    expect(updatedText).not.toContain('+1 555');
  });
});

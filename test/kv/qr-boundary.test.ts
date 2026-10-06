/**
 * Stored QR values read as text and validated (v1.38.0): every field a reader
 * consumes is checked, nested ones included (payload, design, linkedRoute);
 * a record that fails is not found, logged as fixed text naming its key, and
 * never quoted; supported legacy forms are normalised; an unreadable record
 * is present for delete (the recovery) and for create (never overwritten).
 */
import { env, SELF } from 'cloudflare:test';
import { type QRCode, QRCodeSchema, QRDesignSchema } from '@bifrost/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQR, getQRSafe, isStoredQR, listQRs, putQR } from '../../src/kv/qr';
import { qrKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { KVReadError } from '../../src/utils/kv-errors';
import { clearAllRoutes } from '../helpers';

const DOMAIN = 'links.example.com';
const ADMIN_HOST = 'example.com';
const API_KEY = 'test-api-key-12345'; // gitleaks:allow

function makeQR(overrides: Partial<QRCode> = {}): QRCode {
  const now = Date.now();
  return QRCodeSchema.parse({
    id: 'abc123def456',
    domain: DOMAIN,
    type: 'url',
    payload: { url: 'https://example.com' },
    design: QRDesignSchema.parse({}),
    createdAt: now,
    updatedAt: now,
    createdBy: 'test-user',
    ...overrides,
  });
}

async function clearQrs(): Promise<void> {
  const listed = await env.ROUTES.list({ prefix: `qr:${DOMAIN}:` });
  for (const key of listed.keys) await env.ROUTES.delete(key.name);
}

describe('stored QR values that are not valid records', () => {
  const secret = 'wifi-password-never-quoted';
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    await clearQrs();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const expectFixedLog = (id = 'broken') => {
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'warn',
        message: 'boundary-invalid-value',
        category: 'qr',
        key: qrKey(DOMAIN, id),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  };

  it.each([
    ['not JSON (truncated)', `{"payload":{"password":"${secret}"`],
    ['JSON of another shape', JSON.stringify({ id: 'broken', payload: { password: secret } })],
    ['a JSON array', JSON.stringify([secret])],
    ['an unknown type', JSON.stringify({ ...makeQR({ id: 'broken' }), type: secret })],
    ['a non-numeric updatedAt', JSON.stringify({ ...makeQR({ id: 'broken' }), updatedAt: secret })],
    [
      'an empty linkedRoute object',
      JSON.stringify({ ...makeQR({ id: 'broken' }), linkedRoute: {} }),
    ],
    [
      'a linkedRoute with a null path',
      JSON.stringify({ ...makeQR({ id: 'broken' }), linkedRoute: { domain: DOMAIN, path: null } }),
    ],
    [
      'a linkedRoute path that is not a path',
      JSON.stringify({
        ...makeQR({ id: 'broken' }),
        linkedRoute: { domain: DOMAIN, path: secret },
      }),
    ],
    [
      'a bare-string linkedRoute (never a form this template wrote)',
      JSON.stringify({ ...makeQR({ id: 'broken' }), linkedRoute: '/x' }),
    ],
    [
      'a design of the wrong shape',
      JSON.stringify({ ...makeQR({ id: 'broken' }), design: { size: secret } }),
    ],
    [
      'a design that is not an object',
      JSON.stringify({ ...makeQR({ id: 'broken' }), design: [secret] }),
    ],
    [
      'a url payload without its url',
      JSON.stringify({ ...makeQR({ id: 'broken' }), payload: { link: secret } }),
    ],
    [
      'a wifi payload whose password is not a string',
      JSON.stringify({
        ...makeQR({ id: 'broken' }),
        type: 'wifi',
        payload: { ssid: 'Office', password: { secret } },
      }),
    ],
    ['tags that are not strings', JSON.stringify({ ...makeQR({ id: 'broken' }), tags: [1] })],
  ])('treats %s as not found, quoting nothing', async (_label, stored) => {
    await env.ROUTES.put(qrKey(DOMAIN, 'broken'), stored);
    expect(await getQR(env.ROUTES, DOMAIN, 'broken')).toBeNull();
    expect(await getQRSafe(env.ROUTES, DOMAIN, 'broken')).toEqual({ success: true, data: null });
    expectFixedLog();
  });

  it('listQRs skips an invalid record and lists the rest', async () => {
    await env.ROUTES.put(qrKey(DOMAIN, 'broken'), `{"password":"${secret}"`);
    const record = makeQR({ id: 'fine-code' });
    await putQR(env.ROUTES, record);
    const result = await listQRs(env.ROUTES, DOMAIN);
    expect(result.items).toEqual([record]);
    expect(result.total).toBe(1);
    expectFixedLog();
  });

  it('accepts every record the write schema produces', () => {
    for (const record of [
      makeQR(),
      makeQR({ id: 'linked', linkedRoute: { domain: DOMAIN, path: '/x' }, tags: ['a'] }),
      makeQR({ id: 'note', type: 'text', payload: { text: 'hello' } }),
      makeQR({
        id: 'card',
        type: 'vcard',
        payload: { name: 'A', phone: '1', email: 'a@example.com', org: 'O', title: 'T', url: 'u' },
      }),
      makeQR({
        id: 'wifi-code',
        type: 'wifi',
        payload: { ssid: 'Office', auth: 'WPA', password: 'pw', hidden: false },
        design: QRDesignSchema.parse({ logoAspectRatio: 2 }),
      }),
    ]) {
      expect(isStoredQR(JSON.parse(JSON.stringify(record)))).toBe(true);
    }
  });

  it('normalises null design fields and optional fields, and a Wi-Fi record without auth', async () => {
    await env.ROUTES.put(
      qrKey(DOMAIN, 'nulls'),
      JSON.stringify({
        ...makeQR({ id: 'nulls' }),
        description: null,
        design: { fg: null, bg: '#ffeedd', size: null, logoDataUri: null },
      }),
    );
    const read = await getQR(env.ROUTES, DOMAIN, 'nulls');
    expect(read?.design).toEqual({ ...QRDesignSchema.parse({}), bg: '#ffeedd' });
    expect(read).not.toHaveProperty('description');
    await env.ROUTES.put(
      qrKey(DOMAIN, 'no-design'),
      JSON.stringify({ ...makeQR({ id: 'no-design' }), design: null }),
    );
    expect((await getQR(env.ROUTES, DOMAIN, 'no-design'))?.design).toEqual(
      QRDesignSchema.parse({}),
    );
    await env.ROUTES.put(
      qrKey(DOMAIN, 'wifi-legacy'),
      JSON.stringify({
        ...makeQR({ id: 'wifi-legacy' }),
        type: 'wifi',
        payload: { ssid: 'Office', password: 'pw' },
      }),
    );
    expect((await getQR(env.ROUTES, DOMAIN, 'wifi-legacy'))?.payload).toEqual({
      ssid: 'Office',
      password: 'pw',
      auth: 'WPA',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a linkedRoute as {domain, path} only', async () => {
    await env.ROUTES.put(
      qrKey(DOMAIN, 'linked'),
      JSON.stringify({
        ...makeQR({ id: 'linked' }),
        linkedRoute: { domain: DOMAIN, path: '/x', extra: 'dropped' },
      }),
    );
    expect((await getQR(env.ROUTES, DOMAIN, 'linked'))?.linkedRoute).toEqual({
      domain: DOMAIN,
      path: '/x',
    });
  });

  it('reads values as text and validates them locally', async () => {
    const types: unknown[] = [];
    const kv = new Proxy(env.ROUTES, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== 'function') return member;
        if (property === 'get') {
          return (key: string, type?: unknown) => {
            types.push(type);
            return (member as (...args: unknown[]) => unknown).call(target, key, type);
          };
        }
        return (member as (...args: unknown[]) => unknown).bind(target);
      },
    });
    const record = makeQR({ id: 'fine-code' });
    await putQR(env.ROUTES, record);
    expect(await getQR(kv, DOMAIN, 'fine-code')).toEqual(record);
    expect(await getQR(kv, DOMAIN, 'missing-code')).toBeNull();
    expect(await getQRSafe(kv, DOMAIN, 'fine-code')).toEqual({ success: true, data: record });
    expect((await listQRs(kv, DOMAIN)).items).toEqual([record]);
    expect(new Set(types)).toEqual(new Set(['text']));
  });

  it('passes a KV failure through as the cause', async () => {
    const outage = new Error('KV unavailable');
    const kv = {
      get: async () => {
        throw outage;
      },
    } as unknown as KVNamespace;
    const failure: unknown = await getQR(kv, DOMAIN, 'any').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KVReadError);
    expect((failure as KVReadError).cause).toBe(outage);
  });
});

describe('an unreadable QR record through the API', () => {
  const app = new Hono<AppEnv>().route('/api', adminRoutes);
  const call = (method: string, url: string, body?: unknown) =>
    app.fetch(
      new Request(`https://${ADMIN_HOST}/api/qr${url}`, {
        method,
        headers: { 'X-Admin-Key': API_KEY, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const BROKEN = JSON.stringify({ id: 'broken', payload: { password: 'never-quoted' } });
  beforeEach(async () => {
    await clearAllRoutes();
    await clearQrs();
    await env.ROUTES.put(qrKey(DOMAIN, 'broken'), BROKEN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('GET answers 404', async () => {
    expect((await call('GET', `/broken?domain=${DOMAIN}`)).status).toBe(404);
  });

  it('DELETE removes it, then answers 404', async () => {
    const response = await call('DELETE', `/broken?domain=${DOMAIN}`);
    expect(response.status).toBe(200);
    expect(await env.ROUTES.get(qrKey(DOMAIN, 'broken'))).toBeNull();
    expect((await call('DELETE', `/broken?domain=${DOMAIN}`)).status).toBe(404);
  });

  it('a create with its id is a 409 and never overwrites it', async () => {
    const response = await call('POST', `?domain=${DOMAIN}`, {
      type: 'url',
      id: 'broken',
      payload: { url: 'https://example.com/' },
    });
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain('Delete it and create it again');
    expect(text).not.toContain('never-quoted');
    expect(await env.ROUTES.get(qrKey(DOMAIN, 'broken'))).toBe(BROKEN);
  });
});

describe('QR timestamps are the server clock', () => {
  beforeEach(async () => {
    await clearQrs();
  });

  it('a client-sent createdAt or updatedAt is ignored on create and update', async () => {
    const headers = { 'X-Admin-Key': API_KEY, 'Content-Type': 'application/json' };
    const before = Date.now();
    const created = await SELF.fetch(`https://${ADMIN_HOST}/api/qr?domain=${DOMAIN}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'url',
        id: 'clock-code',
        payload: { url: 'https://example.com/' },
        createdAt: 1,
        updatedAt: 9_999_999_999_999,
      }),
    });
    expect(created.status).toBe(201);
    const record = ((await created.json()) as { data: QRCode }).data;
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.updatedAt).toBe(record.createdAt);
    const updated = await SELF.fetch(`https://${ADMIN_HOST}/api/qr/clock-code?domain=${DOMAIN}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ description: 'x', createdAt: 1, updatedAt: 1 }),
    });
    expect(updated.status).toBe(200);
    const after = ((await updated.json()) as { data: QRCode }).data;
    expect(after.createdAt).toBe(record.createdAt);
    expect(after.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
    expect(after.updatedAt).toBeLessThanOrEqual(Date.now());
  });
});

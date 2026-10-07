/**
 * A path change with other edits is ONE write (v1.38.0): `POST
 * /api/routes/migrate` takes the rest of the edit as an update body and writes
 * the merged record once at the new key. KV takes one write per key per
 * second, so a move followed by an update of the same key could lose the
 * update. Validation, field caps, the record size and the credential guard
 * all run on the merged record before anything moves.
 */

import { env } from 'cloudflare:test';
import { MAX_ROUTE_TARGET_LENGTH } from '@bifrost/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { clearAllRoutes, createAuditLogsTable, createSettlingExecutionContext } from '../helpers';

const DOMAIN = 'links.example.com';
const headers = { 'X-Admin-Key': 'test-api-key-12345', 'Content-Type': 'application/json' };
const app = new Hono<AppEnv>().route('/api', adminRoutes);

const STORED = {
  path: '/promo',
  type: 'redirect',
  target: 'https://example.com/landing',
  statusCode: 302,
  enabled: true,
  createdAt: 1000,
  updatedAt: 1000,
};

async function migrate(body?: unknown, query = `oldPath=/promo&newPath=/promo-2&domain=${DOMAIN}`) {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await app.fetch(
    new Request(`https://example.com/api/routes/migrate?${query}`, {
      method: 'POST',
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await settled();
  return response;
}

const stored = async (path: string): Promise<Record<string, unknown> | null> => {
  const text = await env.ROUTES.get(routeKey(DOMAIN, path));
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
};

describe('POST /api/routes/migrate with the rest of the edit', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await createAuditLogsTable();
    await env.DB.prepare('DELETE FROM audit_logs').run();
    await env.ROUTES.put(routeKey(DOMAIN, '/promo'), JSON.stringify(STORED));
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes the merged record once at the new key and removes the old one', async () => {
    const put = vi.spyOn(env.ROUTES, 'put');
    const response = await migrate({ cacheControl: 'no-store', statusCode: 301 });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      path: '/promo-2',
      cacheControl: 'no-store',
      statusCode: 301,
      target: STORED.target,
      createdAt: 1000,
    });
    expect(await stored('/promo')).toBeNull();
    expect(await stored('/promo-2')).toMatchObject({ cacheControl: 'no-store', statusCode: 301 });
    // ONE write, at the new key
    expect(put.mock.calls.map(([key]) => key)).toEqual([routeKey(DOMAIN, '/promo-2')]);
    const row = await env.DB.prepare(
      "SELECT details FROM audit_logs WHERE action = 'migrate' ORDER BY id DESC LIMIT 1",
    ).first<{ details: string }>();
    expect(JSON.parse(row?.details ?? '{}')).toMatchObject({
      oldPath: '/promo',
      newPath: '/promo-2',
      before: { path: '/promo', statusCode: 302 },
      edited: { cacheControl: 'no-store', statusCode: 301 },
    });
  });

  it('moves the record unedited with no body or an empty one, as before', async () => {
    for (const [index, body] of [undefined, '', '   '].entries()) {
      const from = index === 0 ? '/promo' : `/moved-${index - 1}`;
      const response = await migrate(
        body,
        `oldPath=${from}&newPath=/moved-${index}&domain=${DOMAIN}`,
      );
      expect(response.status).toBe(200);
      expect(await stored(`/moved-${index}`)).toMatchObject({ target: STORED.target });
    }
  });

  it('refuses a body that is not JSON or not a valid patch, moving nothing', async () => {
    for (const body of ['{not json', { statusCode: 303 }, { type: 'bogus' }, [1]]) {
      const response = await migrate(body);
      expect(response.status).toBe(400);
      expect(await stored('/promo')).toMatchObject({ path: '/promo' });
      expect(await stored('/promo-2')).toBeNull();
    }
  });

  it('refuses a patch over a field cap, moving nothing', async () => {
    const response = await migrate({
      target: `https://example.com/?q=${'x'.repeat(MAX_ROUTE_TARGET_LENGTH)}`,
    });
    expect(response.status).toBe(400);
    expect(await stored('/promo')).not.toBeNull();
    expect(await stored('/promo-2')).toBeNull();
  });

  it('asks for the credential confirmation BEFORE anything moves, then moves with it', async () => {
    const patch = { target: 'https://example.com/cb?token=LIVE' };
    const refused = await migrate(patch);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      success: false,
      error: 'ROUTE_TARGET_CREDENTIAL',
      details: { parameters: ['token'] },
    });
    expect(await stored('/promo')).not.toBeNull();
    expect(await stored('/promo-2')).toBeNull();

    const confirmed = await migrate({ ...patch, acknowledgeCredentialTarget: true });
    expect(confirmed.status).toBe(200);
    const moved = await stored('/promo-2');
    expect(moved).toMatchObject({ target: patch.target });
    // The request-only flag is never stored
    expect(moved).not.toHaveProperty('acknowledgeCredentialTarget');
    const row = await env.DB.prepare(
      "SELECT details FROM audit_logs WHERE action = 'migrate' ORDER BY id DESC LIMIT 1",
    ).first<{ details: string }>();
    expect(JSON.parse(row?.details ?? '{}')).toMatchObject({
      credentialTargetAcknowledged: ['token'],
      edited: { target: expect.stringContaining('https://example.com/cb?token=') },
    });
    // The audit row redacts the credential value, as every audit row does
    expect(row?.details).not.toContain('LIVE');
  });

  it('guards a stored credential target when a patch re-enables the route', async () => {
    await env.ROUTES.put(
      routeKey(DOMAIN, '/promo'),
      JSON.stringify({ ...STORED, target: 'https://example.com/?api_key=x', enabled: false }),
    );
    const response = await migrate({ enabled: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'ROUTE_TARGET_CREDENTIAL' });
    expect(await stored('/promo-2')).toBeNull();
  });

  it('a patch never merges with an unreadable record, and never overwrites one', async () => {
    await env.ROUTES.put(routeKey(DOMAIN, '/promo-2'), '{"path":');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await migrate({ cacheControl: 'no-store' });
    expect(response.status).toBe(409);
    expect(await stored('/promo')).toMatchObject({ path: '/promo' });
  });
});

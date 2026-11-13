/**
 * QR record keys: an update writes under the key it read.
 *
 * - `PUT /api/qr/:id` read the record at `qr:{domain}:{id}` but wrote the
 *   merged record to the key rebuilt from the stored record's own `domain` and
 *   `id` fields. Every record the API writes has fields equal to its key, but a
 *   record written straight to KV whose fields disagree with its key was
 *   written elsewhere: under another code's key (overwriting it) or another
 *   domain's. The update now writes under the key it read, and the record's
 *   fields follow that key.
 */
import { env } from 'cloudflare:test';
import { QRDesignSchema } from '@bifrost/shared';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { qrKey } from '../../src/kv/schema';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';
import { clearAllRoutes, createAuditLogsTable, createSettlingExecutionContext } from '../helpers';

const DOMAIN = 'example.com';
const OTHER_DOMAIN = 'secondary.example.net';
const testEnv = { ...env, ADMIN_API_DOMAIN: DOMAIN };
const app = new Hono<AppEnv>().route('/api', adminRoutes);

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const { ctx, settled } = createSettlingExecutionContext();
  const response = await app.fetch(
    new Request(`https://${DOMAIN}/api${path}`, {
      method,
      headers: { 'X-Admin-Key': 'test-api-key-12345', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
    ctx,
  );
  await settled();
  return response;
}

/** A stored text code whose own `id` and `domain` fields are given separately from its key. */
function storedText(id: string, domain: string, text: string) {
  return {
    id,
    domain,
    type: 'text',
    payload: { text },
    design: QRDesignSchema.parse({}),
    createdAt: 1,
    updatedAt: 2,
    createdBy: 'legacy',
  };
}

const readKey = async (key: string): Promise<Record<string, unknown> | null> => {
  const raw = await env.ROUTES.get(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};

describe('QR update writes under the key it read', () => {
  beforeAll(async () => {
    await createAuditLogsTable();
  });
  beforeEach(async () => {
    await clearAllRoutes();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('a record whose id field names another code never overwrites that code', async () => {
    // Under the key `kb-source`, a record whose id field says `kb-victim`;
    // a real `kb-victim` exists too and must not be overwritten
    await env.ROUTES.put(
      qrKey(DOMAIN, 'kb-source'),
      JSON.stringify(storedText('kb-victim', DOMAIN, 'source')),
    );
    const victim = JSON.stringify(storedText('kb-victim', DOMAIN, 'victim'));
    await env.ROUTES.put(qrKey(DOMAIN, 'kb-victim'), victim);

    const answer = await call('PUT', `/qr/kb-source?domain=${DOMAIN}`, {
      description: 'edited',
    });
    expect(answer.status).toBe(200);
    const { data } = (await answer.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: 'kb-source', domain: DOMAIN, description: 'edited' });

    expect(await env.ROUTES.get(qrKey(DOMAIN, 'kb-victim'))).toBe(victim);
    expect(await readKey(qrKey(DOMAIN, 'kb-source'))).toMatchObject({
      id: 'kb-source',
      domain: DOMAIN,
      description: 'edited',
      payload: { text: 'source' },
    });
    // Still readable after the write
    expect((await call('GET', `/qr/kb-source?domain=${DOMAIN}`)).status).toBe(200);
  });

  it('a record whose domain field names another domain is not written there', async () => {
    await env.ROUTES.put(
      qrKey(DOMAIN, 'kb-planted'),
      JSON.stringify(storedText('kb-planted', OTHER_DOMAIN, 'planted')),
    );

    const answer = await call('PUT', `/qr/kb-planted?domain=${DOMAIN}`, {
      description: 'edited',
    });
    expect(answer.status).toBe(200);

    expect(await env.ROUTES.get(qrKey(OTHER_DOMAIN, 'kb-planted'))).toBeNull();
    expect(await readKey(qrKey(DOMAIN, 'kb-planted'))).toMatchObject({
      id: 'kb-planted',
      domain: DOMAIN,
      description: 'edited',
    });
  });

  it('a record the API wrote updates exactly as before', async () => {
    const created = await call('POST', `/qr?domain=${DOMAIN}`, {
      id: 'kb-normal',
      type: 'text',
      payload: { text: 'hello' },
    });
    expect(created.status).toBe(201);
    const answer = await call('PUT', `/qr/kb-normal?domain=${DOMAIN}`, { description: 'edited' });
    expect(answer.status).toBe(200);
    expect(await readKey(qrKey(DOMAIN, 'kb-normal'))).toMatchObject({
      id: 'kb-normal',
      domain: DOMAIN,
      description: 'edited',
      payload: { text: 'hello' },
    });
  });
});

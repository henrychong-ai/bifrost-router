/**
 * Route and QR writes bound their request bodies in the Worker: a handler
 * buffers the whole body with `c.req.json()` before any schema sees it, so
 * without a ceiling an admin-key holder could make one request buffer an
 * unbounded body. Over the ceiling answers 413 `PAYLOAD_TOO_LARGE` and writes
 * nothing; a declared Content-Length over it is refused unread, a body
 * without one is counted while read.
 */

import { env } from 'cloudflare:test';
import { QR_WRITE_MAX_BYTES, ROUTE_WRITE_MAX_BYTES } from '@bifrost/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv } from '../../src/types';

const KEY = 'test-api-key-12345'; // gitleaks:allow — test placeholder, not a credential
const DOMAIN = 'example.com';
const testEnv = { ...env, ADMIN_API_DOMAIN: DOMAIN };
const app = () => new Hono<AppEnv>().route('/api', adminRoutes);

/** A JSON object of exactly `bytes` UTF-8 bytes, padded in a `pad` field. */
function jsonOfSize(bytes: number, fields: Record<string, unknown> = {}): string {
  const base = JSON.stringify({ ...fields, pad: '' });
  const body = JSON.stringify({ ...fields, pad: 'a'.repeat(bytes - base.length) });
  expect(new TextEncoder().encode(body).length).toBe(bytes);
  return body;
}

function send(method: string, path: string, body: string): Promise<Response> {
  return Promise.resolve(
    app().fetch(
      new Request(`http://${DOMAIN}${path}`, {
        method,
        headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
        body,
      }),
      testEnv,
    ),
  );
}

/** The same body as a stream, so no Content-Length is declared. */
function sendStreamed(method: string, path: string, body: string): Promise<Response> {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192));
      controller.close();
    },
  });
  const request = new Request(`http://${DOMAIN}${path}`, {
    method,
    headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  expect(request.headers.get('Content-Length')).toBeNull();
  return Promise.resolve(app().fetch(request, testEnv));
}

async function expectTooLarge(response: Response, limitText: string) {
  expect(response.status).toBe(413);
  const data = (await response.json()) as Record<string, unknown>;
  expect(data).toEqual({
    success: false,
    error: 'PAYLOAD_TOO_LARGE',
    message: expect.stringContaining(limitText),
  });
}

const ROUTE_WRITES: Array<[string, string]> = [
  ['POST', `/api/routes?domain=${DOMAIN}`],
  ['PUT', `/api/routes?domain=${DOMAIN}&path=/big`],
  ['POST', `/api/routes/seed?domain=${DOMAIN}`],
  ['POST', `/api/routes/migrate?domain=${DOMAIN}`],
  ['POST', '/api/routes/transfer'],
];

const QR_WRITES: Array<[string, string]> = [
  ['POST', `/api/qr?domain=${DOMAIN}`],
  ['PUT', `/api/qr/big?domain=${DOMAIN}`],
];

describe('route write body limit', () => {
  it('is 64 KiB', () => {
    expect(ROUTE_WRITE_MAX_BYTES).toBe(64 * 1024);
  });

  it.each(ROUTE_WRITES)('%s %s refuses one byte over the limit with 413', async (method, path) => {
    const body = jsonOfSize(ROUTE_WRITE_MAX_BYTES + 1, { path: '/big', type: 'redirect' });
    await expectTooLarge(await send(method, path, body), '64 KB');
    expect(await env.ROUTES.get(`${DOMAIN}:/big`)).toBeNull();
  });

  it.each(ROUTE_WRITES)('%s %s reads a body exactly at the limit', async (method, path) => {
    const body = jsonOfSize(ROUTE_WRITE_MAX_BYTES, { path: '/big', type: 'redirect' });
    const response = await send(method, path, body);
    // Read and refused by the handler's own checks, never by the size ceiling.
    expect(response.status).not.toBe(413);
  });

  it.each(ROUTE_WRITES)('%s %s counts a body sent without Content-Length', async (method, path) => {
    const body = jsonOfSize(ROUTE_WRITE_MAX_BYTES + 1, { path: '/big', type: 'redirect' });
    await expectTooLarge(await sendStreamed(method, path, body), '64 KB');
    expect(await env.ROUTES.get(`${DOMAIN}:/big`)).toBeNull();
  });

  it('leaves a normal route write untouched', async () => {
    const response = await send(
      'POST',
      `/api/routes?domain=${DOMAIN}`,
      JSON.stringify({ path: '/body-limit-ok', type: 'redirect', target: 'https://example.com/' }),
    );
    expect(response.status).toBe(201);
  });

  it('does not limit reads and deletes', async () => {
    const list = await app().fetch(
      new Request(`http://${DOMAIN}/api/routes?domain=${DOMAIN}`, {
        headers: { 'X-Admin-Key': KEY },
      }),
      testEnv,
    );
    expect(list.status).toBe(200);
  });
});

describe('QR write body limit', () => {
  it('is 192 KiB, the stored QR record bound', () => {
    expect(QR_WRITE_MAX_BYTES).toBe(192 * 1024);
  });

  it.each(QR_WRITES)('%s %s refuses one byte over the limit with 413', async (method, path) => {
    const body = jsonOfSize(QR_WRITE_MAX_BYTES + 1, { id: 'big', type: 'text' });
    await expectTooLarge(await send(method, path, body), '192 KB');
    expect(await env.ROUTES.get(`qr:${DOMAIN}:big`)).toBeNull();
  });

  it.each(QR_WRITES)('%s %s reads a body exactly at the limit', async (method, path) => {
    const body = jsonOfSize(QR_WRITE_MAX_BYTES, { id: 'big', type: 'text' });
    expect((await send(method, path, body)).status).not.toBe(413);
  });

  it.each(QR_WRITES)('%s %s counts a body sent without Content-Length', async (method, path) => {
    const body = jsonOfSize(QR_WRITE_MAX_BYTES + 1, { id: 'big', type: 'text' });
    await expectTooLarge(await sendStreamed(method, path, body), '192 KB');
  });
});

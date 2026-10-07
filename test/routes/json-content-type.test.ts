import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { adminRoutes } from '../../src/routes/admin';
import type { AppEnv, Bindings, KVRouteConfig } from '../../src/types';
import {
  bodyHasBytes,
  isJsonContentType,
  isMultipartContentType,
  isMultipartEndpoint,
} from '../../src/utils/json-body';
import { clearAllRoutes, seedRoute } from '../helpers';

/**
 * One body guard on the admin API (v1.39.0), after authentication and before
 * every route: a body sent to any endpoint but the two multipart uploads must
 * be `application/json` (or absent), and an upload must be
 * `multipart/form-data`; anything else is 415 UNSUPPORTED_MEDIA_TYPE before a
 * handler reads or writes anything. A page on another site can make a browser
 * send a `text/plain`, form or multipart body without a CORS preflight, never
 * a JSON one: defence in depth behind the admin key and the dashboard's
 * cross-site refusal.
 */
const ADMIN_HOST = 'example.com';
const API_KEY = 'test-api-key-12345';
const bindings = { ...env, ADMIN_API_DOMAIN: ADMIN_HOST } as Bindings;

async function send(request: Request): Promise<{ status: number; body: unknown }> {
  const response = await worker.fetch(request, bindings, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}

function adminRequest(method: string, path: string, body: BodyInit | null, contentType?: string) {
  const headers = new Headers({ 'X-Admin-Key': API_KEY });
  if (contentType !== undefined) headers.set('Content-Type', contentType);
  return new Request(`https://${ADMIN_HOST}${path}`, { method, headers, body });
}

/** A stream of `chunks`, with no Content-Length or Content-Type. */
function streamed(method: string, path: string, chunks: string[]): Request {
  const bytes = chunks.map(chunk => new TextEncoder().encode(chunk));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request(`https://${ADMIN_HOST}${path}`, {
    method,
    headers: { 'X-Admin-Key': API_KEY },
    body,
  });
  expect(request.body).not.toBeNull();
  expect(request.headers.get('Content-Type')).toBeNull();
  expect(request.headers.get('Content-Length')).toBeNull();
  return request;
}

/** A concrete request path for a Hono route pattern: every parameter `value`. */
function withParams(pattern: string, value: string): string {
  return pattern.replaceAll(/:[A-Za-z]+(?:\{[^}]*\})?/g, value);
}

const route: KVRouteConfig = {
  path: '/existing',
  type: 'redirect',
  target: 'https://example.com/landing',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const JSON_ENDPOINTS: Array<[string, string, string]> = [
  ['create a route', 'POST', '/api/routes?domain=example.com'],
  ['update a route', 'PUT', '/api/routes?domain=example.com&path=/existing'],
  ['seed routes', 'POST', '/api/routes/seed?domain=example.com'],
  [
    'migrate a route with a body',
    'POST',
    '/api/routes/migrate?domain=example.com&oldPath=/existing&newPath=/moved',
  ],
  ['transfer a route', 'POST', '/api/routes/transfer'],
  ['create a QR code', 'POST', '/api/qr?domain=example.com'],
  ['update a QR code', 'PUT', '/api/qr/code-1?domain=example.com'],
  ['rename an object', 'POST', '/api/storage/files/rename'],
  ['move an object', 'POST', '/api/storage/files/move'],
  ['update object metadata', 'PUT', '/api/storage/files/metadata/a.txt'],
  ['comment on an object', 'PUT', '/api/storage/files/comment/a.txt'],
  ['triage feedback', 'PATCH', '/api/feedback/00000000-0000-0000-0000-000000000000'],
];

const NOT_JSON: Array<[string, () => [BodyInit, string | undefined]]> = [
  ['text/plain (the default of a string body)', () => ['{"path":"/x"}', undefined]],
  ['text/plain, set', () => ['{"path":"/x"}', 'text/plain']],
  ['a form', () => ['path=%2Fx', 'application/x-www-form-urlencoded']],
  [
    'multipart',
    () => {
      const form = new FormData();
      form.set('path', '/x');
      return [form, undefined];
    },
  ],
  ['a JSON look-alike', () => ['{"path":"/x"}', 'application/jsonp']],
];

describe('admin JSON bodies must be sent as JSON (415)', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    await seedRoute(route, ADMIN_HOST);
    // The code the QR update targets (an absent one answers 404 first)
    await env.ROUTES.delete('qr:example.com:code-1');
    const qr = await send(
      adminRequest(
        'POST',
        '/api/qr?domain=example.com',
        JSON.stringify({ type: 'url', id: 'code-1', payload: { url: 'https://example.com/' } }),
        'application/json',
      ),
    );
    if (qr.status !== 201) throw new Error(`QR fixture not created: ${qr.status}`);
  });

  for (const [what, method, path] of JSON_ENDPOINTS) {
    it(`${what}: refuses every non-JSON body`, async () => {
      for (const [label, make] of NOT_JSON) {
        const [body, contentType] = make();
        const answer = await send(adminRequest(method, path, body, contentType));
        expect({ label, status: answer.status }).toEqual({ label, status: 415 });
        expect(answer.body).toEqual({
          success: false,
          error: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'The request body must be JSON, sent with Content-Type: application/json.',
        });
      }
    });
  }

  it('writes nothing when it refuses', async () => {
    const created = await send(
      adminRequest(
        'POST',
        '/api/routes?domain=example.com',
        JSON.stringify({ path: '/new', type: 'redirect', target: 'https://example.com/' }),
        'text/plain',
      ),
    );
    expect(created.status).toBe(415);
    expect(await env.ROUTES.get('example.com:/new')).toBeNull();
    const updated = await send(
      adminRequest(
        'PUT',
        '/api/routes?domain=example.com&path=/existing',
        JSON.stringify({ target: 'https://example.com/changed' }),
        'text/plain',
      ),
    );
    expect(updated.status).toBe(415);
    expect(JSON.parse((await env.ROUTES.get('example.com:/existing')) ?? '{}')).toMatchObject({
      target: 'https://example.com/landing',
    });
  });

  it('accepts JSON with any parameters, in any case', async () => {
    for (const contentType of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON',
    ]) {
      const answer = await send(
        adminRequest(
          'PUT',
          '/api/routes?domain=example.com&path=/existing',
          JSON.stringify({ enabled: true }),
          contentType,
        ),
      );
      expect({ contentType, status: answer.status }).toEqual({ contentType, status: 200 });
    }
  });

  it('a request with no body passes the guard, whatever Content-Type it names', async () => {
    for (const [method, path] of [
      ['POST', '/api/routes/migrate?domain=example.com&oldPath=/existing&newPath=/moved'],
      ['POST', '/api/storage/files/purge-cache/a.txt'],
      ['DELETE', '/api/routes?domain=example.com&path=/existing'],
    ] as const) {
      for (const contentType of [undefined, 'text/plain']) {
        const request = adminRequest(method, path, null, contentType);
        const answer = await send(request);
        expect({ method, path, contentType, status: answer.status }).not.toMatchObject({
          status: 415,
        });
        await seedRoute(route, ADMIN_HOST);
        await env.ROUTES.delete('example.com:/moved');
      }
    }
    // A declared empty body is no body
    const empty = new Request(
      `https://${ADMIN_HOST}/api/routes?domain=example.com&path=/existing`,
      {
        method: 'DELETE',
        headers: { 'X-Admin-Key': API_KEY, 'Content-Type': 'text/plain', 'Content-Length': '0' },
        body: '',
      },
    );
    expect((await send(empty)).status).not.toBe(415);
  });

  it('a body sent where none is read still has to be JSON', async () => {
    const answer = await send(
      adminRequest('DELETE', '/api/routes?domain=example.com&path=/existing', 'x', 'text/plain'),
    );
    expect(answer.status).toBe(415);
    expect(await env.ROUTES.get('example.com:/existing')).not.toBeNull();
  });

  it('the guard runs before a handler: a missing route with a text body is 415', async () => {
    const answer = await send(
      adminRequest('PUT', '/api/routes?domain=example.com&path=/missing', '{}', 'text/plain'),
    );
    expect(answer.status).toBe(415);
  });

  // v1.39.0: workerd hands an HTTP/2 POST or DELETE sent with neither
  // Content-Length nor Content-Type (a plain `curl -X POST` over HTTPS) a
  // non-null body stream that holds nothing
  describe('a body stream of unknown length with no Content-Type', () => {
    it('is no body when it holds no byte (empty chunks included)', async () => {
      for (const chunks of [[], [''], ['', '']]) {
        const migrate = await send(
          streamed(
            'POST',
            '/api/routes/migrate?domain=example.com&oldPath=/existing&newPath=/moved',
            chunks,
          ),
        );
        expect({ chunks, status: migrate.status }).toEqual({ chunks, status: 200 });
        expect(await env.ROUTES.get('example.com:/moved')).not.toBeNull();
        await env.ROUTES.delete('example.com:/moved');
        await seedRoute(route, ADMIN_HOST);

        const removed = await send(
          streamed('DELETE', '/api/routes?domain=example.com&path=/existing', chunks),
        );
        expect({ chunks, status: removed.status }).toEqual({ chunks, status: 200 });
        expect(await env.ROUTES.get('example.com:/existing')).toBeNull();
        await seedRoute(route, ADMIN_HOST);
      }
    });

    it('is a body, refused, when it holds a byte (after an empty chunk too)', async () => {
      for (const chunks of [['x'], ['', '{"path":"/x"}'], ['{}']]) {
        const answer = await send(
          streamed('DELETE', '/api/routes?domain=example.com&path=/existing', chunks),
        );
        expect({ chunks, status: answer.status }).toEqual({ chunks, status: 415 });
        expect(answer.body).toMatchObject({ error: 'UNSUPPORTED_MEDIA_TYPE' });
        expect(await env.ROUTES.get('example.com:/existing')).not.toBeNull();
      }
    });

    it('a stream that neither yields a byte nor ends counts as a body at the deadline', async () => {
      let cancelled = false;
      const stalled = new Request(`https://${ADMIN_HOST}/api/routes`, {
        method: 'POST',
        headers: { 'X-Admin-Key': API_KEY },
        body: new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      });
      const started = Date.now();
      expect(await bodyHasBytes(stalled, 20)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(cancelled).toBe(false);
      const empty = streamed('POST', '/api/routes', ['']);
      expect(await bodyHasBytes(empty, 20)).toBe(false);
    });

    it('an empty stream with a Content-Type other than JSON is still refused', async () => {
      const request = streamed('DELETE', '/api/routes?domain=example.com&path=/existing', []);
      const typed = new Request(request, {
        headers: { 'X-Admin-Key': API_KEY, 'Content-Type': 'text/plain' },
      });
      expect((await send(typed)).status).toBe(415);
    });
  });

  it('a migrate without a body needs no Content-Type', async () => {
    const answer = await send(
      adminRequest(
        'POST',
        '/api/routes/migrate?domain=example.com&oldPath=/existing&newPath=/moved',
        null,
      ),
    );
    expect(answer.status).not.toBe(415);
  });

  it('reads the multipart types and the two upload endpoints exactly', () => {
    expect(isMultipartContentType('multipart/form-data; boundary=x')).toBe(true);
    expect(isMultipartContentType('Multipart/Form-Data;boundary=x')).toBe(true);
    expect(isMultipartContentType('multipart/mixed; boundary=x')).toBe(false);
    expect(isMultipartContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isMultipartContentType(undefined)).toBe(false);
    expect(isMultipartEndpoint('POST', '/api/storage/files/upload')).toBe(true);
    expect(isMultipartEndpoint('POST', '/api/feedback')).toBe(true);
    expect(isMultipartEndpoint('PUT', '/api/storage/files/upload')).toBe(false);
    expect(isMultipartEndpoint('POST', '/api/storage/files/upload/x')).toBe(false);
    expect(isMultipartEndpoint('POST', '/api/feedback/abc')).toBe(false);
    expect(isMultipartEndpoint('POST', '/api/storage/upload')).toBe(false);
  });

  // The exemption is a hand-written path list, so it is checked against the
  // routes the admin API actually registers: exactly the storage upload and
  // the feedback submission take multipart, and no other body route does
  it('exempts exactly the registered upload and feedback routes', () => {
    const app = new Hono<AppEnv>().route('/api', adminRoutes);
    const bodyRoutes = app.routes.filter(({ method }) =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method),
    );
    // The routes were read: a few known body routes are among them
    expect(bodyRoutes.map(({ method, path }) => `${method} ${path}`)).toEqual(
      expect.arrayContaining([
        'PUT /api/routes',
        'POST /api/routes/migrate',
        'DELETE /api/storage/:bucket/objects/:key{.+}',
        'PATCH /api/feedback/:id',
      ]),
    );
    const exempt = bodyRoutes
      .filter(({ method, path }) => isMultipartEndpoint(method, withParams(path, 'x1')))
      .map(({ method, path }) => `${method} ${path}`);
    expect(exempt).toEqual(['POST /api/storage/:bucket/upload', 'POST /api/feedback']);
    // Whatever a parameter holds, no other body route reads as an upload
    for (const value of ['files', 'upload', 'feedback', 'a/upload', '']) {
      for (const { method, path } of bodyRoutes) {
        if (exempt.includes(`${method} ${path}`)) continue;
        const concrete = withParams(path, value);
        expect({ method, concrete, exempt: isMultipartEndpoint(method, concrete) }).toEqual({
          method,
          concrete,
          exempt: false,
        });
      }
    }
  });

  it('reads Content-Type values as the browser sends them', () => {
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('')).toBe(false);
    expect(isJsonContentType('text/plain;charset=UTF-8')).toBe(false);
    expect(isJsonContentType('multipart/form-data; boundary=x')).toBe(false);
    expect(isJsonContentType('application/json-patch+json')).toBe(false);
    expect(isJsonContentType(' application/json ')).toBe(true);
    expect(isJsonContentType('application/json;charset=UTF-8')).toBe(true);
  });
});

describe('uploads must be multipart (415)', () => {
  const NOT_MULTIPART: Array<[string, () => [BodyInit, string | undefined]]> = [
    ['JSON', () => ['{"key":"a.txt"}', 'application/json']],
    ['a form', () => ['key=a.txt&file=x', 'application/x-www-form-urlencoded']],
    ['text/plain', () => ['x', 'text/plain']],
    ['no Content-Type', () => [new Uint8Array([120]), undefined]],
  ];

  for (const [what, path] of [
    ['a storage upload', '/api/storage/files/upload'],
    ['a feedback submission', '/api/feedback'],
  ] as const) {
    it(`${what} refuses every body that is not multipart, writing nothing`, async () => {
      for (const [label, make] of NOT_MULTIPART) {
        const [body, contentType] = make();
        const answer = await send(adminRequest('POST', path, body, contentType));
        expect({ label, status: answer.status }).toEqual({ label, status: 415 });
        expect(answer.body).toEqual({
          success: false,
          error: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'The request body must be a multipart/form-data upload.',
        });
      }
      expect(await env.FILES_BUCKET.head('a.txt')).toBeNull();
    });
  }

  it('a multipart upload passes the guard', async () => {
    const form = new FormData();
    form.set('file', new File(['hello'], 'guard-ok.txt', { type: 'text/plain' }));
    form.set('key', 'guard-ok.txt');
    const answer = await send(adminRequest('POST', '/api/storage/files/upload', form));
    expect(answer.status).toBe(201);
    await env.FILES_BUCKET.delete('guard-ok.txt');
  });
});

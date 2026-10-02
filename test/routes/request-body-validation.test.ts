import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { adminRoutes } from '../../src/routes/admin';
import { createRoute, getRoute } from '../../src/kv/routes';
import type { AppEnv, Bindings } from '../../src/types';
import { clearAllRoutes } from '../helpers';

/**
 * Request-body validation for the write endpoints that used to read their JSON
 * body through a type cast or without a JSON guard: storage rename / move /
 * metadata / comment, and route transfer / create / update / seed.
 *
 * Two properties are pinned here:
 *
 * 1. A body that is malformed, of the wrong type, or missing a required field
 *    is answered 400 BEFORE any KV, R2 or D1 call. The rejected requests run
 *    against bindings that record — and throw on — every call, so a handler
 *    that reached storage fails the test twice over.
 * 2. Everything the handlers accepted before is still accepted: a `null`
 *    `destinationKey`, an empty metadata patch, undeclared extra keys, a
 *    non-boolean `acknowledgeCredentialTarget`, and a string, `null` or empty
 *    comment.
 *
 * One body is refused that used to succeed: a move with an EMPTY
 * `destinationKey`, which skipped key validation and wrote to the empty key.
 */

const ADMIN_HOST = 'example.com';
const TRANSFER_TARGET_DOMAIN = 'links.example.com';
const headers = { 'X-Admin-Key': 'test-api-key-12345', 'Content-Type': 'application/json' };

function createApp() {
  return new Hono<AppEnv>().route('/api', adminRoutes);
}

/** A binding stand-in: every method call is recorded, then throws. */
function recordingBinding(calls: string[], name: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => () => {
        const call = `${name}.${String(property)}`;
        calls.push(call);
        throw new Error(`unexpected storage call: ${call}`);
      },
    },
  );
}

/** Real config, but every KV / R2 / D1 binding the four handlers can reach is a recorder. */
function recordingEnv(calls: string[]): Bindings {
  return {
    ...env,
    ADMIN_API_DOMAIN: ADMIN_HOST,
    ROUTES: recordingBinding(calls, 'ROUTES'),
    DB: recordingBinding(calls, 'DB'),
    FILES_BUCKET: recordingBinding(calls, 'FILES_BUCKET'),
    ASSETS_BUCKET: recordingBinding(calls, 'ASSETS_BUCKET'),
  } as Bindings;
}

const realEnv = { ...env, ADMIN_API_DOMAIN: ADMIN_HOST } as Bindings;

function send(bindings: Bindings, method: string, path: string, body: string): Promise<Response> {
  return Promise.resolve(
    createApp().fetch(
      new Request(`http://${ADMIN_HOST}/api${path}`, { method, headers, body }),
      bindings,
    ),
  );
}

const MALFORMED = '{"oldKey": ';

const ENDPOINTS = {
  rename: { method: 'POST', path: '/storage/files/rename' },
  move: { method: 'POST', path: '/storage/files/move' },
  metadata: { method: 'PUT', path: '/storage/files/metadata/validation/meta.txt' },
  transfer: { method: 'POST', path: '/routes/transfer' },
  comment: { method: 'PUT', path: '/storage/files/comment/validation/comment.txt' },
  create: { method: 'POST', path: `/routes?domain=${ADMIN_HOST}` },
  update: { method: 'PUT', path: `/routes?domain=${ADMIN_HOST}&path=/validation` },
  seed: { method: 'POST', path: `/routes/seed?domain=${ADMIN_HOST}` },
} as const;

type EndpointName = keyof typeof ENDPOINTS;

const REJECTED: Array<[EndpointName, string, string]> = [
  ['rename', 'malformed JSON', MALFORMED],
  ['rename', 'a wrong-typed field', JSON.stringify({ oldKey: 5, newKey: 'b.txt' })],
  ['rename', 'a missing required field', JSON.stringify({ oldKey: 'a.txt' })],
  ['move', 'malformed JSON', MALFORMED],
  [
    'move',
    'a wrong-typed field',
    JSON.stringify({ key: 'a.txt', destinationBucket: 'assets', destinationKey: 7 }),
  ],
  ['move', 'a missing required field', JSON.stringify({ key: 'a.txt' })],
  ['metadata', 'malformed JSON', MALFORMED],
  ['metadata', 'a wrong-typed field', JSON.stringify({ contentType: 5 })],
  // Every metadata field is optional, so there is no required field to omit;
  // the third case is a body that is not an object at all.
  ['metadata', 'a non-object body', JSON.stringify(['text/html'])],
  ['transfer', 'malformed JSON', MALFORMED],
  [
    'transfer',
    'a wrong-typed field',
    JSON.stringify({ path: 5, fromDomain: ADMIN_HOST, toDomain: TRANSFER_TARGET_DOMAIN }),
  ],
  [
    'transfer',
    'a missing required field',
    JSON.stringify({ path: '/validation', fromDomain: ADMIN_HOST }),
  ],
  // An empty destinationKey is a key, not an absent one: the key validator
  // refuses it, exactly as it refuses an empty source key.
  [
    'move',
    'an empty destinationKey',
    JSON.stringify({ key: 'a.txt', destinationBucket: 'assets', destinationKey: '' }),
  ],
  ['comment', 'malformed JSON', MALFORMED],
  ['comment', 'a wrong-typed field', JSON.stringify({ comment: 5 })],
  ['comment', 'a missing required field', JSON.stringify({})],
  ['comment', 'a null body', 'null'],
  ['create', 'malformed JSON', MALFORMED],
  [
    'create',
    'a wrong-typed field',
    JSON.stringify({ path: '/validation', type: 'redirect', target: 5 }),
  ],
  ['create', 'a missing required field', JSON.stringify({ path: '/validation', type: 'redirect' })],
  ['update', 'malformed JSON', MALFORMED],
  ['update', 'a wrong-typed field', JSON.stringify({ enabled: 'yes' })],
  // Every update field is optional, so there is no required field to omit; a
  // `null` body used to reach KV as an empty patch and then fail on the audit step.
  ['update', 'a null body', 'null'],
  ['update', 'a non-object body', JSON.stringify(['enabled'])],
  ['seed', 'malformed JSON', MALFORMED],
  ['seed', 'a wrong-typed field', JSON.stringify({ routes: 'not-an-array' })],
  ['seed', 'a missing required field', JSON.stringify({})],
  ['seed', 'a null body', 'null'],
  ['seed', 'a null route entry', JSON.stringify({ routes: [null] })],
];

const WELL_FORMED: Record<EndpointName, string> = {
  rename: JSON.stringify({ oldKey: 'a.txt', newKey: 'b.txt' }),
  move: JSON.stringify({ key: 'a.txt', destinationBucket: 'assets' }),
  metadata: JSON.stringify({ contentType: 'text/html' }),
  transfer: JSON.stringify({
    path: '/validation',
    fromDomain: ADMIN_HOST,
    toDomain: TRANSFER_TARGET_DOMAIN,
  }),
  comment: JSON.stringify({ comment: 'a note' }),
  create: JSON.stringify({ path: '/validation', type: 'redirect', target: 'https://example.com/' }),
  update: JSON.stringify({ enabled: false }),
  seed: JSON.stringify({
    routes: [{ path: '/validation', type: 'redirect', target: 'https://example.com/' }],
  }),
};

/** The stored comment on the comment test's object, or null when there is none. */
async function storedComment(): Promise<string | null> {
  const row = await env.DB.prepare('SELECT comment FROM file_comments WHERE bucket = ? AND key = ?')
    .bind('files', 'validation/comment.txt')
    .first<{ comment: string }>();
  return row?.comment ?? null;
}

describe('request-body validation (storage and route write endpoints)', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it.each(REJECTED)('%s: %s is a 400 with no storage call', async (name, _label, body) => {
    const calls: string[] = [];
    const { method, path } = ENDPOINTS[name];

    const response = await send(recordingEnv(calls), method, path, body);

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('control: the recording bindings do see a well-formed request on every endpoint', async () => {
    // Without this, "no storage call" above would also pass for a recorder
    // that the handlers never reach in the first place.
    for (const name of Object.keys(ENDPOINTS) as EndpointName[]) {
      const calls: string[] = [];
      const { method, path } = ENDPOINTS[name];

      const response = await send(recordingEnv(calls), method, path, WELL_FORMED[name]);

      expect(response.status, `${name} status`).toBe(500);
      expect(calls.length, `${name} storage calls`).toBeGreaterThan(0);
    }
  });

  it('names the offending field in the storage error', async () => {
    const response = await send(
      recordingEnv([]),
      'POST',
      ENDPOINTS.rename.path,
      JSON.stringify({ oldKey: 'a.txt' }),
    );

    expect(await response.text()).toContain('Invalid rename request: newKey:');
  });

  it('answers a transfer schema failure in the route-write validation shape', async () => {
    const response = await send(
      recordingEnv([]),
      'POST',
      ENDPOINTS.transfer.path,
      JSON.stringify({ path: '/validation', fromDomain: ADMIN_HOST }),
    );

    const data = (await response.json()) as {
      success: boolean;
      error: string;
      details: Array<{ path: string[] }>;
    };
    expect(data.success).toBe(false);
    expect(data.error).toBe('Validation failed');
    expect(data.details.map(issue => issue.path.join('.'))).toEqual(['toDomain']);
  });

  it('rename: still ignores undeclared keys', async () => {
    await env.FILES_BUCKET.put('validation/rename-src.txt', 'x');

    const response = await send(
      realEnv,
      'POST',
      ENDPOINTS.rename.path,
      JSON.stringify({
        oldKey: 'validation/rename-src.txt',
        newKey: 'validation/rename-dst.txt',
        note: 'not part of the contract',
      }),
    );

    expect(response.status).toBe(200);
    expect(await env.FILES_BUCKET.head('validation/rename-dst.txt')).not.toBeNull();
    expect(await env.FILES_BUCKET.head('validation/rename-src.txt')).toBeNull();
  });

  it('move: still treats a null destinationKey as "keep the source key"', async () => {
    await env.FILES_BUCKET.put('validation/move-null.txt', 'x');

    const response = await send(
      realEnv,
      'POST',
      ENDPOINTS.move.path,
      JSON.stringify({
        key: 'validation/move-null.txt',
        destinationBucket: 'assets',
        destinationKey: null,
      }),
    );

    expect(response.status).toBe(200);
    expect(await env.ASSETS_BUCKET.head('validation/move-null.txt')).not.toBeNull();
    expect(await env.FILES_BUCKET.head('validation/move-null.txt')).toBeNull();
  });

  it('metadata: still accepts an empty patch and leaves the metadata alone', async () => {
    await env.FILES_BUCKET.put('validation/meta.txt', 'x', {
      httpMetadata: { contentType: 'text/plain', cacheControl: 'no-store' },
    });

    const response = await send(realEnv, 'PUT', ENDPOINTS.metadata.path, '{}');

    expect(response.status).toBe(200);
    const head = await env.FILES_BUCKET.head('validation/meta.txt');
    expect(head?.httpMetadata).toMatchObject({
      contentType: 'text/plain',
      cacheControl: 'no-store',
    });
  });

  it('comment: still sets a string and clears on null or an empty string', async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS file_comments (
        bucket TEXT NOT NULL,
        key TEXT NOT NULL,
        comment TEXT NOT NULL,
        updated_by TEXT,
        updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
        PRIMARY KEY (bucket, key)
      )`,
    ).run();
    await env.FILES_BUCKET.put('validation/comment.txt', 'x');

    const set = await send(realEnv, 'PUT', ENDPOINTS.comment.path, '{"comment":"a note"}');
    expect(set.status).toBe(200);
    expect(await storedComment()).toBe('a note');

    const clearedByNull = await send(realEnv, 'PUT', ENDPOINTS.comment.path, '{"comment":null}');
    expect(clearedByNull.status).toBe(200);
    expect(await storedComment()).toBeNull();

    await send(realEnv, 'PUT', ENDPOINTS.comment.path, '{"comment":"again"}');
    const clearedByEmpty = await send(realEnv, 'PUT', ENDPOINTS.comment.path, '{"comment":""}');
    expect(clearedByEmpty.status).toBe(200);
    expect(await storedComment()).toBeNull();
  });

  it('answers malformed JSON on a route write with "Invalid JSON body"', async () => {
    const response = await send(recordingEnv([]), 'POST', ENDPOINTS.create.path, MALFORMED);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid JSON body');
  });

  it('transfer: still accepts a non-boolean acknowledgeCredentialTarget', async () => {
    // The flag is read off the raw body, where anything but a literal `true`
    // means "not acknowledged" — it must never become a type error.
    await createRoute(env.ROUTES, ADMIN_HOST, {
      path: '/validation',
      type: 'redirect',
      target: 'https://example.com/',
    });

    const response = await send(
      realEnv,
      'POST',
      ENDPOINTS.transfer.path,
      JSON.stringify({
        path: '/validation',
        fromDomain: ADMIN_HOST,
        toDomain: TRANSFER_TARGET_DOMAIN,
        acknowledgeCredentialTarget: 'yes',
      }),
    );

    expect(response.status).toBe(200);
    expect(await getRoute(env.ROUTES, TRANSFER_TARGET_DOMAIN, '/validation')).not.toBeNull();
    expect(await getRoute(env.ROUTES, ADMIN_HOST, '/validation')).toBeNull();
  });
});

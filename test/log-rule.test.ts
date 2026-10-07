import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkBackupHealth } from '../src/backup/health';
import { handleScheduled } from '../src/backup/scheduled';
import { insertAuditLog } from '../src/db/analytics';
import { handleR2 } from '../src/handlers/r2';
import { rateLimit, rateLimitStrict } from '../src/middleware/rate-limit';
import { handleR2EventBatch, type R2EventMessage } from '../src/queue/r2-events';
import type { AppEnv, Bindings, KVRouteConfig } from '../src/types';
import { createAuditLogsTable } from './helpers';

/**
 * The Worker's log rule (v1.39.0): a line never carries a visitor's path,
 * query or body, an identity (an email, a client IP), a whole payload, or an
 * error's message or stack (its class only). Configured route targets and
 * admin object keys may appear in operational lines. Every console channel is
 * captured, and each path is driven with marker values where the rule forbids
 * them.
 */
const CHANNELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const MARKER = 'secret-marker-7Kw';
const EMAIL = `operator-${MARKER}@example.com`;
const CLIENT_IP = '203.0.113.79';

/** An argument as a console shows it: an error with its message and stack. */
function show(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message} ${arg.stack ?? ''}`;
  return JSON.stringify(arg) ?? String(arg);
}

let output: string[] = [];
beforeEach(() => {
  output = [];
  for (const channel of CHANNELS) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      output.push(args.map(show).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every captured line that holds any of `values`. */
const leaks = (...values: string[]) =>
  output.filter(line => values.some(value => line.includes(value)));

/** A batch of one message whose body is `body`. */
function batchOf(body: unknown) {
  const message = { body, ack: vi.fn<() => void>(), retry: vi.fn<() => void>() };
  const batch = {
    queue: 'bifrost-r2-events',
    messages: [message],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch<R2EventMessage>;
  return { batch, message };
}

/** A D1 binding whose every statement fails with a message holding the marker. */
const failD1 = () => Promise.reject(new Error(`D1_ERROR: ${MARKER} ${EMAIL}`));

function failingDb(): D1Database {
  const fail = failD1;
  const statement = { bind: () => statement, all: fail, raw: fail, first: fail, run: fail };
  return {
    prepare: () => statement,
    batch: fail,
    exec: fail,
    dump: fail,
  } as unknown as D1Database;
}

/** An R2 object for the serve lines, with or without a body. */
function object(withBody: boolean, size = 4): R2ObjectBody {
  return {
    key: 'docs/a.pdf',
    version: 'v1',
    size,
    etag: 'abc123',
    httpEtag: '"abc123"',
    checksums: {},
    uploaded: new Date('2026-01-01T00:00:00Z'),
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {},
    range: withBody ? { offset: 0, length: size } : undefined,
    writeHttpMetadata: () => {},
    ...(withBody
      ? {
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(size));
              controller.close();
            },
          }),
        }
      : {}),
  } as unknown as R2ObjectBody;
}

/** The parsed serve lines among the captured output. */
const serveLines = () =>
  output
    .filter(line => line.startsWith('{') && line.includes('"R2 '))
    .map(line => JSON.parse(line) as Record<string, unknown>);

describe('the audit success line', () => {
  beforeEach(async () => {
    await createAuditLogsTable();
  });

  it('says whether an actor was recorded, never who; D1 keeps the login', async () => {
    await insertAuditLog(env.DB, {
      domain: 'example.com',
      action: 'update',
      actorLogin: EMAIL,
      actorName: `Operator ${MARKER}`,
      path: '/promo',
      details: null,
    });
    const line = output.find(entry => entry.includes('Audit log recorded'));
    expect(JSON.parse(line ?? '{}')).toEqual({
      level: 'info',
      message: 'Audit log recorded',
      domain: 'example.com',
      action: 'update',
      hasActor: true,
      path: '/promo',
    });
    expect(leaks(MARKER, '@')).toEqual([]);
    const row = await env.DB.prepare('SELECT actor_login FROM audit_logs WHERE actor_login = ?1')
      .bind(EMAIL)
      .first<{ actor_login: string }>();
    expect(row?.actor_login).toBe(EMAIL);
  });

  it('says so when there is no actor', async () => {
    await insertAuditLog(env.DB, { domain: 'example.com', action: 'delete', path: '/old' });
    const line = output.find(entry => entry.includes('Audit log recorded'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({ hasActor: false });
  });
});

describe('the R2 event consumer', () => {
  it('logs a failed event by its action, bucket, key and error class only', async () => {
    const body = {
      account: `account-${MARKER}`,
      action: 'PutObject',
      bucket: 'files',
      object: { key: 'docs/report.pdf', size: 1, eTag: `etag-${MARKER}` },
      eventTime: new Date().toISOString(),
      copySource: { bucket: 'files', object: `copy-${MARKER}` },
    };
    const { batch, message } = batchOf(body);
    await handleR2EventBatch(batch, { ...env, DB: failingDb(), R2_EVENT_AUDIT: 'on' } as Bindings);
    expect(message.retry).toHaveBeenCalledOnce();
    const line = output.find(entry => entry.includes('r2-event-processing-failed'));
    expect(JSON.parse(line ?? '{}')).toEqual({
      level: 'error',
      message: 'r2-event-processing-failed',
      action: 'PutObject',
      bucket: 'files',
      key: 'docs/report.pdf',
      errorName: 'Error',
    });
    expect(leaks(MARKER, '@')).toEqual([]);
  });

  it('logs a malformed event by its named fields, never the body', async () => {
    const { batch, message } = batchOf({
      account: `account-${MARKER}`,
      action: 'Unknown',
      bucket: 'files',
      object: { key: 'docs/x.pdf', extra: MARKER },
      note: MARKER,
    });
    await handleR2EventBatch(batch, { ...env, R2_EVENT_AUDIT: 'on' } as Bindings);
    expect(message.ack).toHaveBeenCalledOnce();
    const line = output.find(entry => entry.includes('r2-event-skipped-malformed'));
    // An action this consumer does not know is left out, like the body
    expect(JSON.parse(line ?? '{}')).toEqual({
      level: 'warn',
      message: 'r2-event-skipped-malformed',
      bucket: 'files',
      key: 'docs/x.pdf',
    });
    expect(leaks(MARKER)).toEqual([]);
  });

  it('logs only validated metadata of a malformed event, never marker values', async () => {
    const { batch, message } = batchOf({
      account: `account-${MARKER}`,
      action: `Put-${MARKER}`,
      bucket: `Bucket ${MARKER}`,
      object: `object-${MARKER}`,
    });
    await handleR2EventBatch(batch, { ...env, R2_EVENT_AUDIT: 'on' } as Bindings);
    expect(message.ack).toHaveBeenCalledOnce();
    const line = output.find(entry => entry.includes('r2-event-skipped-malformed'));
    expect(JSON.parse(line ?? '{}')).toEqual({
      level: 'warn',
      message: 'r2-event-skipped-malformed',
    });
    expect(leaks(MARKER)).toEqual([]);
  });

  it('a known action with a non-string bucket or key is malformed, never recorded or logged raw', async () => {
    for (const body of [
      { action: 'PutObject', bucket: { name: 'files', account: MARKER }, object: { key: 'a.pdf' } },
      { action: 'PutObject', bucket: 'files', object: { key: { path: 'a.pdf', note: MARKER } } },
      { action: 'PutObject', bucket: 'files', object: { key: `${'k'.repeat(1025)}${MARKER}` } },
    ]) {
      output = [];
      const { batch, message } = batchOf(body);
      await handleR2EventBatch(batch, { ...env, R2_EVENT_AUDIT: 'on' } as Bindings);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(output.some(entry => entry.includes('r2-event-skipped-malformed'))).toBe(true);
      expect(output.some(entry => entry.includes('r2-event-external'))).toBe(false);
      expect(leaks(MARKER)).toEqual([]);
    }
  });

  it('an event whose other fields cannot be read is skipped, never retried', async () => {
    const unreadable = { toString: 0 };
    for (const body of [
      {
        action: 'PutObject',
        bucket: 'files',
        eventTime: 'x',
        object: { key: 'a.pdf', eTag: unreadable },
      },
      { action: 'PutObject', bucket: 'files', eventTime: unreadable, object: { key: 'a.pdf' } },
      { action: 'PutObject', bucket: 'files', object: { key: 'a.pdf', size: '12' } },
      { action: 'CopyObject', bucket: 'files', object: { key: 'a.pdf' }, copySource: 'b/c' },
    ]) {
      output = [];
      const { batch, message } = batchOf(body);
      await handleR2EventBatch(batch, { ...env, R2_EVENT_AUDIT: 'on' } as Bindings);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(output.some(entry => entry.includes('r2-event-skipped-malformed'))).toBe(true);
    }
  });

  it('a known action with a missing key logs the action and bucket only', async () => {
    const { batch } = batchOf({ account: MARKER, action: 'DeleteObject', bucket: 'files' });
    await handleR2EventBatch(batch, { ...env, R2_EVENT_AUDIT: 'on' } as Bindings);
    const line = output.find(entry => entry.includes('r2-event-skipped-malformed'));
    expect(JSON.parse(line ?? '{}')).toEqual({
      level: 'warn',
      message: 'r2-event-skipped-malformed',
      action: 'DeleteObject',
      bucket: 'files',
    });
    expect(leaks(MARKER)).toEqual([]);
  });

  it('logs nothing of a body that is not an object', async () => {
    const { batch } = batchOf(`text-${MARKER}`);
    await handleR2EventBatch(batch, { ...env, R2_EVENT_AUDIT: 'on' } as Bindings);
    expect(output.some(entry => entry.includes('r2-event-skipped-malformed'))).toBe(true);
    expect(leaks(MARKER)).toEqual([]);
  });
});

describe('the backup jobs', () => {
  it('health: an R2 failure is logged by its class only', async () => {
    const bucket = {
      list: () => Promise.reject(new TypeError(`list failed: daily/${MARKER}`)),
    } as unknown as R2Bucket;
    const health = await checkBackupHealth(bucket);
    expect(health.status).toBe('critical');
    expect(output).toEqual(['[Backup] Health listing failed: TypeError']);
    expect(JSON.stringify(health)).not.toContain(MARKER);
  });

  it('scheduled: a platform error is logged by its class only', async () => {
    const failingKv = {
      list: () => Promise.reject(new RangeError(`KV list failed for links.example.com:/${MARKER}`)),
    } as unknown as KVNamespace;
    const result = await handleScheduled({ ...env, ROUTES: failingKv } as unknown as Bindings);
    expect(result.success).toBe(false);
    expect(output.filter(line => line.includes('error'))).toEqual([
      '[Backup] Platform error: RangeError',
    ]);
    expect(leaks(MARKER)).toEqual([]);
  });
});

describe('the rate limiter', () => {
  /** A KV binding whose every call fails with a message naming the client. */
  const failingKv = {
    get: () => Promise.reject(new Error(`KV get failed: ratelimit:${CLIENT_IP} ${MARKER}`)),
    put: () => Promise.reject(new Error(MARKER)),
  } as unknown as KVNamespace;

  it.each([
    ['fail-open', rateLimit, 200],
    ['fail-closed', rateLimitStrict, 503],
  ] as const)('%s: names no client IP and no error message', async (_label, limiter, status) => {
    const app = new Hono<AppEnv>();
    app.use('*', limiter({ maxRequests: 3, windowSeconds: 60 }));
    app.get('/test', c => c.json({ success: true }));
    const response = await app.fetch(
      new Request('http://localhost/test', { headers: { 'CF-Connecting-IP': CLIENT_IP } }),
      { ...env, ROUTES: failingKv } as Bindings,
    );
    expect(response.status).toBe(status);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({ level: 'error', errorName: 'Error' });
    expect(leaks(CLIENT_IP, MARKER)).toEqual([]);
  });
});

describe('the R2 serve lines', () => {
  // A wildcard r2 route serves its stored target, whatever remainder matched
  // it: every serve line names the route key and that target, never the
  // visitor's path or query
  const route: KVRouteConfig = {
    path: '/files/*',
    type: 'r2',
    target: 'docs/a.pdf',
    createdAt: 0,
    updatedAt: 0,
  };
  const visitorUrl = `http://localhost/files/${MARKER}?token=${MARKER}`;

  async function serve(
    get: (key: string, options?: R2GetOptions) => Promise<unknown>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const app = new Hono<AppEnv>();
    app.get('/files/*', c => handleR2(c, route));
    return app.fetch(
      new Request(visitorUrl, { headers }),
      { ENVIRONMENT: 'development', FILES_BUCKET: { get } as unknown as R2Bucket },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext,
    );
  }

  it('cache MISS and HIT name the route key, the target and the bucket', async () => {
    vi.spyOn(caches.default, 'match').mockResolvedValueOnce(undefined);
    vi.spyOn(caches.default, 'put').mockResolvedValue(undefined);
    expect((await serve(async () => object(true))).status).toBe(200);
    vi.spyOn(caches.default, 'match').mockResolvedValueOnce(new Response('x'));
    expect((await serve(async () => object(true))).status).toBe(200);
    expect(serveLines()).toEqual([
      expect.objectContaining({ message: 'R2 cache MISS', path: '/files/*', key: 'docs/a.pdf' }),
      expect.objectContaining({ message: 'R2 cache HIT', path: '/files/*', key: 'docs/a.pdf' }),
    ]);
    expect(serveLines().every(line => line['bucket'] === 'files')).toBe(true);
    expect(leaks(MARKER)).toEqual([]);
  });

  it('an uncached serve and a degraded read name the same three fields', async () => {
    const get = vi
      .fn<(key: string, options?: R2GetOptions) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error(`Invalid range ${MARKER}`))
      .mockResolvedValueOnce(object(true));
    const response = await serve(get, { Range: 'bytes=0-1' });
    await response.arrayBuffer();
    const lines = serveLines();
    expect(lines.map(line => line['message'])).toEqual([
      'R2 read failed with request options present (malformed options or transient fault) — degrading to a plainer read',
      'R2 uncached serve',
    ]);
    for (const line of lines) {
      expect(line).toMatchObject({ path: '/files/*', key: 'docs/a.pdf', bucket: 'files' });
    }
    expect(lines[0]?.['errorName']).toBe('Error');
    expect(leaks(MARKER)).toEqual([]);
  });

  it('an If-Range re-read that misses names the same three fields', async () => {
    const get = vi
      .fn<(key: string, options?: R2GetOptions) => Promise<unknown>>()
      .mockResolvedValueOnce(object(true, 4096))
      .mockResolvedValueOnce(null);
    const response = await serve(get, { Range: 'bytes=0-1', 'If-Range': '"stale"' });
    expect(response.status).toBe(404);
    expect(serveLines()).toEqual([
      expect.objectContaining({
        message: 'R2 If-Range full re-read missed — object vanished, returning 404',
        path: '/files/*',
        key: 'docs/a.pdf',
        bucket: 'files',
      }),
    ]);
    expect(leaks(MARKER)).toEqual([]);
  });
});

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneUnifiedTrafficEvents, recordAuditLog } from '../src/db/analytics';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { errorName } from '../src/utils/error-name';
import { clearAllRoutes, seedRoute, TEST_DOMAIN } from './helpers';

/**
 * Failure paths log a fixed error classification (v1.39.0): `errorName`, the
 * class of the thrown value, never its message or stack. A KV or D1 failure
 * message quotes what the call held (a `domain:path` key, a statement's
 * parameters, a URL), so a visitor's path or query, or an admin's search,
 * would reach the logs. Every console channel is captured.
 */
const CHANNELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const MARKER = 'secret-marker-9Qz';

let output: string[] = [];
beforeEach(() => {
  output = [];
  for (const channel of CHANNELS) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

/** A D1 binding whose every statement fails with `message`. */
function failingDb(message: string): D1Database {
  const fail = () => Promise.reject(new Error(message));
  const statement = {
    bind: () => statement,
    all: fail,
    raw: fail,
    first: fail,
    run: fail,
  };
  return {
    prepare: () => statement,
    batch: fail,
    exec: fail,
    dump: fail,
  } as unknown as D1Database;
}

describe('errorName', () => {
  it('is the class of an Error, the type of anything else, never the message', () => {
    class KvReadError extends Error {
      override name = 'KvReadError';
    }
    expect(errorName(new Error(MARKER))).toBe('Error');
    expect(errorName(new TypeError(MARKER))).toBe('TypeError');
    expect(errorName(new KvReadError(MARKER))).toBe('KvReadError');
    expect(errorName(MARKER)).toBe('string');
    expect(errorName(42)).toBe('number');
    expect(errorName(undefined)).toBe('undefined');
    expect(errorName(null)).toBe('null');
    expect(errorName({ message: MARKER })).toBe('object');
    // A name that is not an identifier (an error built to carry text) is Error
    const forged = new Error('x');
    forged.name = `Bad ${MARKER}`;
    expect(errorName(forged)).toBe('Error');
    const long = new Error('x');
    long.name = 'A'.repeat(65);
    expect(errorName(long)).toBe('Error');
  });
});

describe('the unhandled-error logger', () => {
  it('logs the class and route pattern only, on every channel', async () => {
    await clearAllRoutes();
    await seedRoute({
      path: '/boom',
      type: 'r2',
      target: 'boom.txt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    class KvReadError extends Error {
      override name = 'KvReadError';
    }
    const bindings = {
      ...env,
      ENVIRONMENT: 'production',
      FILES_BUCKET: {
        get: () => {
          throw new KvReadError(`read failed for ${TEST_DOMAIN}:/boom?token=${MARKER}`);
        },
      } as unknown as R2Bucket,
    } as Bindings;
    const response = await worker.fetch(
      new Request(`https://${TEST_DOMAIN}/boom?token=${MARKER}`),
      bindings,
      ctx,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(MARKER);
    const line = output.find(entry => entry.includes('Unhandled error'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({
      errorName: 'KvReadError',
      route: '/*',
      method: 'GET',
    });
    expect(output.filter(entry => entry.includes(MARKER))).toEqual([]);
  });
});

describe('the analytics endpoints', () => {
  const testEnv = {
    ...env,
    ADMIN_API_DOMAIN: TEST_DOMAIN,
    DB: failingDb(`D1_ERROR: query failed; params: /${MARKER}`),
  } as unknown as Bindings;

  it.each([
    '/api/analytics/summary',
    `/api/analytics/clicks?slug=/${MARKER}`,
    `/api/analytics/views?path=/${MARKER}`,
    `/api/analytics/clicks/${MARKER}`,
    `/api/analytics/downloads?path=/${MARKER}`,
    `/api/analytics/downloads/${MARKER}`,
    `/api/analytics/proxy?path=/${MARKER}`,
    `/api/analytics/proxy/${MARKER}`,
    `/api/analytics/audit?path=/${MARKER}`,
  ])('%s logs the failure as a class, not a message', async target => {
    const response = await worker.fetch(
      new Request(`https://${TEST_DOMAIN}${target}`, {
        headers: { 'X-Admin-Key': 'test-api-key-12345' },
      }),
      testEnv,
      ctx,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(MARKER);
    const failures = output.filter(entry => entry.includes('"errorName"'));
    expect(failures.length).toBeGreaterThan(0);
    for (const entry of failures) expect(entry).not.toContain('"error":');
    expect(output.filter(entry => entry.includes(MARKER))).toEqual([]);
  });
});

describe('the analytics writers', () => {
  it('a failed prune or audit write logs the class only', async () => {
    const db = failingDb(`D1_ERROR: params: /${MARKER}`);
    expect(await pruneUnifiedTrafficEvents(db, 30)).toBe(0);
    await recordAuditLog(db, {
      domain: TEST_DOMAIN,
      action: 'create',
      actorLogin: 'api-key',
      path: '/promo',
      details: JSON.stringify({ note: 'x' }),
    } as Parameters<typeof recordAuditLog>[1]);
    const failures = output.filter(entry => entry.includes('"errorName":"Error"'));
    expect(failures).toHaveLength(2);
    expect(output.filter(entry => entry.includes(MARKER))).toEqual([]);
  });
});

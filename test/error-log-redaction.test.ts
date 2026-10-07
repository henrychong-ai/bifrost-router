import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { clearAllRoutes, seedRoute, TEST_DOMAIN } from './helpers';

async function serveThrowingRoute(message: string): Promise<{ lines: string[]; body: string }> {
  await clearAllRoutes();
  await seedRoute({
    path: '/boom',
    type: 'r2',
    target: 'boom.txt',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const bindings = {
    ...env,
    ENVIRONMENT: 'development',
    FILES_BUCKET: {
      get: () => {
        throw new Error(message);
      },
    } as unknown as R2Bucket,
  } as Bindings;

  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });

  const response = await worker.fetch(new Request(`https://${TEST_DOMAIN}/boom`), bindings, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
  expect(response.status).toBe(500);

  return {
    lines: errors.filter(line => line.includes('Unhandled error')),
    body: await response.text(),
  };
}

/**
 * Unhandled-error logs must not persist credentials or request paths.
 *
 * A thrown Error's message and stack are attacker-influenceable and routinely
 * carry whatever the failing call was holding: a credential (an Authorization
 * header echoed back by a fetch failure, a token in a URL) or the visitor's
 * path and query (a KV read names the `domain:path` key it read). The log line
 * names the error's class only (v1.39.0); the development-only diagnostic
 * echoed in the response body passes through the shared redactor.
 */
describe('unhandled-error logs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('log the error class, never the message or stack', async () => {
    for (const message of [
      'upstream rejected Authorization: Bearer sk-live-abcdef123456',
      'session invalid: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl',
      'KV GET failed: example.com:/boom/secret-token-123?code=abc',
      'R2 bucket temporarily unavailable',
    ]) {
      const { lines } = await serveThrowingRoute(message);
      expect(lines).toHaveLength(1);
      const logged = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(logged).toEqual({
        level: 'error',
        message: 'Unhandled error',
        errorName: 'Error',
        // The route pattern, never the request path (v1.39.0)
        route: '/*',
        method: 'GET',
      });
      for (const word of message.split(/[\s:]+/).filter(part => part.length > 4)) {
        expect(lines[0]).not.toContain(word);
      }
    }
  });

  it('redacts the development-only diagnostic echoed in the RESPONSE body', async () => {
    // The body is where a developer actually reads the error, and it is
    // rendered by the dashboard and pasted into tickets. A credential is no
    // less exposed there than in a log line.
    const { body } = await serveThrowingRoute(
      'upstream rejected Authorization: Bearer sk-live-abcdef123456',
    );

    expect(body).not.toContain('sk-live-abcdef123456');
    expect(body).toContain('[REDACTED]');
    expect(body).toContain('upstream rejected');
  });

  it('omits the diagnostic entirely outside development', async () => {
    await clearAllRoutes();
    await seedRoute({
      path: '/boom-prod',
      type: 'r2',
      target: 'boom.txt',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(
      new Request(`https://${TEST_DOMAIN}/boom-prod`),
      {
        ...env,
        ENVIRONMENT: 'production',
        FILES_BUCKET: {
          get: () => {
            throw new Error('Bearer sk-live-abcdef123456');
          },
        } as unknown as R2Bucket,
      } as Bindings,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('sk-live-abcdef123456');
    expect(body).not.toContain('[REDACTED]');
  });
});

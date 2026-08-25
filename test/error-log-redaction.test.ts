import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/index';
import type { Bindings } from '../src/types';
import { clearAllRoutes, seedRoute, TEST_DOMAIN } from './helpers';

/**
 * Unhandled-error logs must not persist credentials.
 *
 * A thrown Error's message and stack are attacker-influenceable and routinely
 * carry whatever credential the failing call was holding — an Authorization
 * header echoed back by a fetch failure, a token in a URL. Both the structured
 * log line and the development-only diagnostic echoed in the response body
 * carried them verbatim; both now pass through the shared redactor.
 */
describe('unhandled-error log redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('redacts a Bearer token from the logged message and stack', async () => {
    const { lines } = await serveThrowingRoute(
      'upstream rejected Authorization: Bearer sk-live-abcdef123456',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('sk-live-abcdef123456');
    expect(lines[0]).toContain('[REDACTED]');
    // The rest of the diagnostic survives — this is redaction, not suppression.
    expect(lines[0]).toContain('upstream rejected');
    expect(lines[0]).toContain('"path":"/boom"');
  });

  it('redacts a JWT-shaped string', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl';
    const { lines } = await serveThrowingRoute(`session invalid: ${jwt}`);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(jwt);
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('leaves a credential-free message byte-identical', async () => {
    const { lines, body } = await serveThrowingRoute('R2 bucket temporarily unavailable');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('R2 bucket temporarily unavailable');
    expect(lines[0]).not.toContain('[REDACTED]');
    // The development diagnostic still reaches the developer intact.
    expect(body).toContain('R2 bucket temporarily unavailable');
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

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { privacySafeRequestLogger } from '../../src/middleware/request-logger';
import type { AppEnv } from '../../src/types';

/** The request lines `app` logs for `url`. */
async function requestLines(app: Hono<AppEnv>, url: string): Promise<unknown[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await app.request(url);
    return log.mock.calls
      .map(call => JSON.parse(String(call[0])) as unknown)
      .filter(line => (line as { message?: unknown }).message === 'request');
  } finally {
    log.mockRestore();
  }
}

describe('privacy-safe request logger', () => {
  // v1.39.0: the line named the request path (query dropped), and a wildcard
  // remainder or a storage key in the path can carry a secret
  it('logs the answering route pattern, never the request path or query', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', privacySafeRequestLogger());
    app.get('/api/storage/:bucket/objects/:key{.+}', c => c.text('object'));
    app.get('/ok', c => c.text('ok'));
    app.all('*', c => c.text('catch-all'));

    const [object] = await requestLines(
      app,
      'https://example.com/api/storage/files/objects/SECRET-KEY/x.pdf?token=QUERY-SECRET',
    );
    expect(object).toEqual({
      level: 'info',
      message: 'request',
      method: 'GET',
      route: '/api/storage/:bucket/objects/:key{.+}',
      status: 200,
      durationMs: expect.any(Number) as unknown,
    });
    const [ok] = await requestLines(app, 'https://example.com/ok?token=secret');
    expect(ok).toMatchObject({ route: '/ok', status: 200 });
    const [visitor] = await requestLines(
      app,
      'https://example.com/magic/TOKEN-SECRET?x=QUERY-SECRET',
    );
    expect(visitor).toMatchObject({ route: '/*', status: 200 });
    expect(JSON.stringify([object, ok, visitor])).not.toMatch(/SECRET|secret|token/);
  });

  it('logs a failed request with its status', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', privacySafeRequestLogger());
    app.get('/boom/:id', () => {
      throw new Error('boom');
    });
    app.onError((_error, c) => c.text('error', 500));
    const [line] = await requestLines(app, 'https://example.com/boom/SECRET-ID');
    expect(line).toMatchObject({ route: '/boom/:id', status: 500 });
    expect(JSON.stringify(line)).not.toContain('SECRET');
  });
});

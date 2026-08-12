import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  privacySafeRequestLogger,
  privacySafeRequestPath,
} from '../../src/middleware/request-logger';
import type { AppEnv } from '../../src/types';

describe('privacy-safe request logger', () => {
  it('drops query and fragment material and normalises paths', () => {
    expect(privacySafeRequestPath('///reports?q=signed#grant')).toBe('/reports');
    expect(privacySafeRequestPath('')).toBe('/');
  });

  it('logs a structured bounded request record', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const app = new Hono<AppEnv>();
    app.use('*', privacySafeRequestLogger());
    app.get('/ok', c => c.text('ok'));

    const response = await app.request('https://example.com/ok?token=secret');
    expect(response.status).toBe(200);
    const record = String(log.mock.calls[0]?.[0]);
    expect(record).toContain('"path":"/ok"');
    expect(record).not.toContain('token');
    expect(record).not.toContain('secret');
    log.mockRestore();
  });
});

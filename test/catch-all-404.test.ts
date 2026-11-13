/**
 * The catch-all 404 for an unrouted path names the admin API (`hint`) only on
 * a host that serves it: the admin host (`ADMIN_API_DOMAIN`), or every host
 * when it is unset, as the admin mount's own host rule allows. A public
 * short-link or file host answers `{ error, path, message }` and nothing about
 * how routes are managed.
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../src/types';
import { clearAllRoutes, createSettlingExecutionContext } from './helpers';

const ADMIN_HOST = 'bifrost.example.com';
const HINT = 'Use the admin API to add routes: POST /api/routes';

async function notFound(
  host: string,
  adminDomain: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { default: worker } = await import('../src/index');
  const { ctx, settled } = createSettlingExecutionContext();
  const bindings = { ...(env as unknown as Bindings), ADMIN_API_DOMAIN: adminDomain } as Bindings;
  const response = await worker.fetch(new Request(`https://${host}/no-such-link`), bindings, ctx);
  const body = (await response.json()) as Record<string, unknown>;
  await settled();
  return { status: response.status, body };
}

describe('catch-all 404 hint', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  for (const host of ['links.example.com', 'example.com', 'secondary.example.net']) {
    it(`a public host (${host}) gets no admin-API hint`, async () => {
      const { status, body } = await notFound(host, ADMIN_HOST);
      expect(status).toBe(404);
      expect(body).toEqual({
        error: 'Not Found',
        path: '/no-such-link',
        message: 'No route configured for this path.',
      });
    });
  }

  it('the admin host keeps the hint', async () => {
    const { status, body } = await notFound(ADMIN_HOST, ADMIN_HOST);
    expect(status).toBe(404);
    expect(body).toEqual({
      error: 'Not Found',
      path: '/no-such-link',
      message: 'No route configured for this path.',
      hint: HINT,
    });
  });

  it('with no admin host configured, the admin API answers on every host, and so does the hint', async () => {
    const { body } = await notFound('links.example.com', undefined);
    expect(body['hint']).toBe(HINT);
  });
});

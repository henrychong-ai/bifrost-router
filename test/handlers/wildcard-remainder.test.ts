/**
 * The remainder a wildcard route appends to its target, through the real
 * router and route lookup (v1.37.2). It is taken from the RAW request path,
 * aligned segment by segment with the route's base as the lookup normalises
 * it. Slicing the raw path by the normalised base's length cut into the
 * remainder whenever the two differed in length (`//blog/post`,
 * `/%62log/post`), and a raw base segment holding an encoded `/` matched a
 * deeper route than it spells.
 */

import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawWildcardRemainder } from '../../src/kv/lookup';
import { clearAllRoutes, seedRoute } from '../helpers';

const HOST = 'links.example.com';

/** The upstream URLs the stubbed fetch saw. */
function upstream(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
}

/** The router's answer to `path` on HOST, without following redirects. */
async function visit(path: string): Promise<Response> {
  const response = await SELF.fetch(`https://${HOST}${path}`, { redirect: 'manual' });
  return response;
}

describe('wildcard remainder through the router', () => {
  beforeEach(async () => {
    await clearAllRoutes();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response('upstream', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('redirect preservePath', () => {
    beforeEach(async () => {
      await seedRoute(
        {
          path: '/blog/*',
          type: 'redirect',
          target: 'https://dest.example.net/base',
          preservePath: true,
          preserveQuery: false,
          enabled: true,
        },
        HOST,
      );
    });

    it.each([
      ['/blog/post', 'https://dest.example.net/base/post'],
      ['//blog/post', 'https://dest.example.net/base/post'],
      ['/%62log/post', 'https://dest.example.net/base/post'],
      ['/BLOG/post', 'https://dest.example.net/base/post'],
      ['/blog/a/b%20c', 'https://dest.example.net/base/a/b%20c'],
    ])('sends %s to %s', async (path, location) => {
      const response = await visit(path);
      await response.body?.cancel();
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(location);
    });
  });

  describe('proxy', () => {
    beforeEach(async () => {
      await seedRoute(
        {
          path: '/docs/v1/*',
          type: 'proxy',
          target: 'https://upstream.example.net/base',
          enabled: true,
        },
        HOST,
      );
    });

    it('answers 404 for a raw base segment that decodes to a separator, fetching nothing', async () => {
      for (const path of ['/docs%2Fv1/page', '/docs%2fv1/page', '/docs%5Cv1/page']) {
        const response = await visit(path);
        await response.body?.cancel();
        expect(response.status).toBe(404);
      }
      expect(upstream()).toEqual([]);
    });

    it.each(['/docs/v1/page', '/DOCS/v1/page', '/do%63s/v1/page', '//docs/v1/page'])(
      'forwards %s under the base, as the lookup matches it',
      async path => {
        const response = await visit(path);
        await response.body?.cancel();
        expect(response.status).toBe(200);
        expect(upstream()).toEqual(['https://upstream.example.net/base/page']);
      },
    );
  });
});

// KV refuses a key over 512 bytes even on read, so the lookup never asks for
// one: a long request path is a 404, or a shorter wildcard's match, never a 500
describe('long request paths', () => {
  beforeEach(async () => {
    await clearAllRoutes();
  });

  it('answers 404 for a path whose key would pass the KV limit', async () => {
    const response = await visit(`/${'a'.repeat(600)}`);
    await response.body?.cancel();
    expect(response.status).toBe(404);
  });

  it('still serves a shorter wildcard for such a path', async () => {
    await seedRoute(
      { path: '/long/*', type: 'redirect', target: 'https://dest.example.net/', enabled: true },
      HOST,
    );
    const response = await visit(`/long/${'b/'.repeat(300)}end`);
    await response.body?.cancel();
    expect(response.status).toBe(302);
  });
});

// The helper's own contract, without the router
describe('rawWildcardRemainder', () => {
  it.each([
    ['/blog/post', '/blog/*', '/post'],
    ['//blog/post', '/blog/*', '/post'],
    ['/%62log/post', '/blog/*', '/post'],
    ['/blog/', '/blog/*', '/'],
    ['/blog//a', '/blog/*', '//a'],
    ['/x/y', '/*', '/x/y'],
    ['/docs%2Fv1/page', '/docs/v1/*', null],
    ['/docs/v2/page', '/docs/v1/*', null],
    ['/docs/%zz/page', '/docs/*', '/%zz/page'],
    ['/do%zzcs/page', '/docs/*', null],
  ])('%s against %s gives %s', (raw, routePath, expected) => {
    expect(rawWildcardRemainder(raw, routePath)).toBe(expected);
  });
});

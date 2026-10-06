import { describe, expect, it } from 'vitest';
import {
  getWildcardCandidates,
  matchRoute,
  normalizePath,
  rawWildcardRemainder,
} from '../../src/kv/lookup';
import { routeKey } from '../../src/kv/schema';
import type { KVRouteConfig } from '../../src/types';

describe('normalizePath', () => {
  describe('query strings and hashes', () => {
    it('removes query strings', () => {
      expect(normalizePath('/blog?page=1')).toBe('/blog');
      expect(normalizePath('/search?q=test&limit=10')).toBe('/search');
    });

    it('removes hash fragments', () => {
      expect(normalizePath('/docs#section1')).toBe('/docs');
      expect(normalizePath('/api?key=val#hash')).toBe('/api');
    });
  });

  describe('trailing slashes', () => {
    it('removes trailing slashes', () => {
      expect(normalizePath('/blog/')).toBe('/blog');
      expect(normalizePath('/api/v1/')).toBe('/api/v1');
    });

    it('preserves root path', () => {
      expect(normalizePath('/')).toBe('/');
    });
  });

  describe('multiple slashes', () => {
    it('collapses multiple slashes', () => {
      expect(normalizePath('//blog')).toBe('/blog');
      expect(normalizePath('/api//v1///endpoint')).toBe('/api/v1/endpoint');
    });
  });

  describe('URL encoding', () => {
    it('decodes URL-encoded characters', () => {
      expect(normalizePath('/hello%20world')).toBe('/hello world');
      expect(normalizePath('/path%2Fwith%2Fslashes')).toBe('/path/with/slashes');
    });

    it('handles malformed encoding gracefully', () => {
      // Invalid encoding should keep original (but lowercased)
      expect(normalizePath('/invalid%ZZ')).toBe('/invalid%zz');
    });
  });

  describe('case normalization', () => {
    it('converts paths to lowercase', () => {
      expect(normalizePath('/LinkedIn')).toBe('/linkedin');
      expect(normalizePath('/GitHub')).toBe('/github');
      expect(normalizePath('/API/V1/Users')).toBe('/api/v1/users');
    });

    it('preserves already lowercase paths', () => {
      expect(normalizePath('/blog')).toBe('/blog');
      expect(normalizePath('/api/v1')).toBe('/api/v1');
    });

    it('handles all-uppercase paths', () => {
      expect(normalizePath('/README')).toBe('/readme');
      expect(normalizePath('/FAQ')).toBe('/faq');
    });
  });

  describe('leading slash', () => {
    it('adds leading slash if missing', () => {
      expect(normalizePath('blog')).toBe('/blog');
      expect(normalizePath('api/v1')).toBe('/api/v1');
    });
  });

  describe('combined normalization', () => {
    it('handles complex paths', () => {
      expect(normalizePath('//api//v1//?query=1#hash')).toBe('/api/v1');
      expect(normalizePath('/blog%20posts/')).toBe('/blog posts');
    });
  });
});

describe('getWildcardCandidates', () => {
  it('generates candidates from most to least specific', () => {
    const candidates = getWildcardCandidates('/blog/post/123');
    expect(candidates).toEqual(['/blog/post/*', '/blog/*', '/*']);
  });

  it('handles single segment paths', () => {
    const candidates = getWildcardCandidates('/blog');
    expect(candidates).toEqual(['/*']);
  });

  it('handles root path', () => {
    const candidates = getWildcardCandidates('/');
    expect(candidates).toEqual([]);
  });
});

describe('rawWildcardRemainder', () => {
  it('extracts the raw remainder after the wildcard base', () => {
    expect(rawWildcardRemainder('/blog/my-post', '/blog/*')).toBe('/my-post');
    expect(rawWildcardRemainder('/api/v1/users', '/api/*')).toBe('/v1/users');
  });

  it('returns / when nothing follows the base', () => {
    expect(rawWildcardRemainder('/blog/', '/blog/*')).toBe('/');
    expect(rawWildcardRemainder('/blog', '/blog/*')).toBe('/');
  });

  it('returns null for a path that does not reach the base, or a non-wildcard route', () => {
    expect(rawWildcardRemainder('/', '/blog/*')).toBeNull();
    expect(rawWildcardRemainder('/blog', '/blog')).toBeNull();
    expect(rawWildcardRemainder('/api/v1', '/api/v1')).toBeNull();
  });
});

const wildcardRoute = (path: string, enabled = true): KVRouteConfig => ({
  path,
  type: 'redirect',
  target: `https://example.com${path}`,
  enabled,
  createdAt: 0,
  updatedAt: 0,
});

// KV values are read as text and parsed by the lookup, so the mocks store text
const stored = (route: KVRouteConfig | undefined): string | null =>
  route === undefined ? null : JSON.stringify(route);

const createKv = (routes: ReadonlyMap<string, KVRouteConfig>): KVNamespace =>
  ({
    get: async (key: string) => stored(routes.get(key)),
  }) as unknown as KVNamespace;

describe('matchRoute wildcard lookup', () => {
  const domain = 'lookup.example.com';
  const deepPath = '/a/b/c/d/e/f/g/h';

  it('preserves most-specific wildcard precedence regardless of completion order', async () => {
    const specific = wildcardRoute('/a/b/*');
    const root = wildcardRoute('/*');
    const kv = {
      async get(key: string) {
        if (key === routeKey(domain, '/a/b/*')) {
          await scheduler.wait(5);
          return stored(specific);
        }
        return key === routeKey(domain, '/*') ? stored(root) : null;
      },
    } as unknown as KVNamespace;

    await expect(matchRoute(kv, domain, deepPath)).resolves.toEqual(specific);
  });

  it('falls through a disabled specific wildcard to the next enabled candidate', async () => {
    const disabled = wildcardRoute('/a/b/*', false);
    const root = wildcardRoute('/*');
    const kv = createKv(
      new Map([
        [routeKey(domain, '/a/b/*'), disabled],
        [routeKey(domain, '/*'), root],
      ]),
    );

    await expect(matchRoute(kv, domain, deepPath)).resolves.toEqual(root);
  });

  it('loads wildcard candidates concurrently after an exact miss', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const kv = {
      async get(key: string) {
        if (key === routeKey(domain, deepPath)) return null;
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await scheduler.wait(5);
        activeReads -= 1;
        return null;
      },
    } as unknown as KVNamespace;

    await expect(matchRoute(kv, domain, deepPath)).resolves.toBeNull();
    expect(maxActiveReads).toBe(getWildcardCandidates(deepPath).length);
  });
});

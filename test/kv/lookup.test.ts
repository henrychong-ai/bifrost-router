import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  getWildcardCandidates,
  getWildcardRemainder,
  matchRoute,
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

describe('getWildcardRemainder', () => {
  it('extracts remainder after wildcard', () => {
    expect(getWildcardRemainder('/blog/my-post', '/blog/*')).toBe('/my-post');
    expect(getWildcardRemainder('/api/v1/users', '/api/*')).toBe('/v1/users');
  });

  it('returns / for exact wildcard match', () => {
    expect(getWildcardRemainder('/blog', '/blog/*')).toBe('/');
  });

  it('returns empty string for non-wildcard routes', () => {
    expect(getWildcardRemainder('/blog', '/blog')).toBe('');
    expect(getWildcardRemainder('/api/v1', '/api/v1')).toBe('');
  });
});

describe('matchRoute wildcard lookup', () => {
  const domain = 'lookup.example.com';
  const deepPath = '/a/b/c/d/e/f/g/h';

  const wildcardRoute = (path: string, enabled = true): KVRouteConfig => ({
    path,
    type: 'redirect',
    target: `https://example.com${path}`,
    enabled,
    createdAt: 0,
    updatedAt: 0,
  });

  const createKv = (routes: ReadonlyMap<string, KVRouteConfig>): KVNamespace =>
    ({
      get: async (key: string) => routes.get(key) ?? null,
    }) as unknown as KVNamespace;

  it('preserves most-specific wildcard precedence regardless of completion order', async () => {
    const specific = wildcardRoute('/a/b/*');
    const root = wildcardRoute('/*');
    const kv = {
      async get(key: string) {
        if (key === routeKey(domain, '/a/b/*')) {
          await scheduler.wait(5);
          return specific;
        }
        return key === routeKey(domain, '/*') ? root : null;
      },
    } as unknown as KVNamespace;

    await expect(matchRoute(kv, domain, deepPath)).resolves.toBe(specific);
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

    await expect(matchRoute(kv, domain, deepPath)).resolves.toBe(root);
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

import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  getWildcardCandidates,
  getWildcardRemainder,
} from '../../src/kv/lookup';

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
      expect(normalizePath('/path%2Fwith%2Fslashes')).toBe(
        '/path/with/slashes',
      );
    });

    it('handles malformed encoding gracefully', () => {
      // Invalid encoding should keep original
      expect(normalizePath('/invalid%ZZ')).toBe('/invalid%ZZ');
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

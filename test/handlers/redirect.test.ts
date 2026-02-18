import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { handleRedirect } from '../../src/handlers/redirect';
import type { AppEnv, KVRouteConfig } from '../../src/types';

describe('handleRedirect', () => {
  describe('basic redirects', () => {
    it('redirects with default 302 status', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/github', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/github'),
        env,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://github.com/test');
    });

    it('redirects with custom status code 301', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/old-page',
        type: 'redirect',
        target: 'https://example.com/new-page',
        statusCode: 301,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/old-page', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/old-page'),
        env,
      );

      expect(response.status).toBe(301);
    });

    it('redirects with 307 preserving method', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/api',
        type: 'redirect',
        target: 'https://api.example.com',
        statusCode: 307,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/api', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/api'),
        env,
      );

      expect(response.status).toBe(307);
    });

    it('redirects with 308 permanent preserving method', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/permanent',
        type: 'redirect',
        target: 'https://example.com/permanent',
        statusCode: 308,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/permanent', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/permanent'),
        env,
      );

      expect(response.status).toBe(308);
    });
  });

  describe('query parameter handling', () => {
    it('preserves query params by default', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/search',
        type: 'redirect',
        target: 'https://google.com/search',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/search', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/search?q=test&page=1'),
        env,
      );

      expect(response.status).toBe(302);
      const location = response.headers.get('Location');
      expect(location).toContain('q=test');
      expect(location).toContain('page=1');
    });

    it('does not override existing query params in target', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/search',
        type: 'redirect',
        target: 'https://google.com/search?source=app',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/search', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/search?source=web&q=test'),
        env,
      );

      const location = response.headers.get('Location');
      // Original source=app should be preserved, not overridden
      expect(location).toContain('source=app');
      // New param should be added
      expect(location).toContain('q=test');
    });

    it('skips query preservation when preserveQuery is false', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/clean',
        type: 'redirect',
        target: 'https://example.com/clean',
        preserveQuery: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/clean', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/clean?unwanted=true'),
        env,
      );

      expect(response.headers.get('Location')).toBe(
        'https://example.com/clean',
      );
    });

    it('handles empty query string', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/page',
        type: 'redirect',
        target: 'https://example.com/page',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/page', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/page'),
        env,
      );

      expect(response.headers.get('Location')).toBe('https://example.com/page');
    });
  });

  describe('path preservation for wildcards', () => {
    it('does not preserve path by default', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/*',
        type: 'redirect',
        target: 'https://example.com/',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/*', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/linkedin'),
        env,
      );

      expect(response.headers.get('Location')).toBe('https://example.com/');
    });

    it('preserves path when preservePath is true', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/*',
        type: 'redirect',
        target: 'https://example.com/',
        preservePath: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/*', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/linkedin'),
        env,
      );

      expect(response.headers.get('Location')).toBe(
        'https://example.com/linkedin',
      );
    });

    it('preserves path with nested wildcard', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/blog/*',
        type: 'redirect',
        target: 'https://blog.example.com/',
        preservePath: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/blog/*', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/blog/my-post'),
        env,
      );

      expect(response.headers.get('Location')).toBe(
        'https://blog.example.com/my-post',
      );
    });

    it('handles root path with wildcard', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/*',
        type: 'redirect',
        target: 'https://example.com/',
        preservePath: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/*', c => handleRedirect(c, route));

      const response = await app.fetch(new Request('http://localhost/'), env);

      expect(response.headers.get('Location')).toBe('https://example.com/');
    });

    it('preserves both path and query when both enabled', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/*',
        type: 'redirect',
        target: 'https://example.com/',
        preservePath: true,
        preserveQuery: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/*', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/linkedin?ref=twitter'),
        env,
      );

      const location = response.headers.get('Location');
      expect(location).toBe('https://example.com/linkedin?ref=twitter');
    });

    it('preserves path but not query when preserveQuery is false', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/*',
        type: 'redirect',
        target: 'https://example.com/',
        preservePath: true,
        preserveQuery: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/*', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/linkedin?ref=twitter'),
        env,
      );

      expect(response.headers.get('Location')).toBe(
        'https://example.com/linkedin',
      );
    });

    it('handles target with existing path correctly', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/*',
        type: 'redirect',
        target: 'https://example.com/base',
        preservePath: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/*', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/extra/path'),
        env,
      );

      expect(response.headers.get('Location')).toBe(
        'https://example.com/base/extra/path',
      );
    });

    it('does not affect non-wildcard routes', async () => {
      const app = new Hono<AppEnv>();
      const route: KVRouteConfig = {
        path: '/specific',
        type: 'redirect',
        target: 'https://example.com/target',
        preservePath: true, // Should have no effect on non-wildcard
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      app.get('/specific', c => handleRedirect(c, route));

      const response = await app.fetch(
        new Request('http://localhost/specific'),
        env,
      );

      expect(response.headers.get('Location')).toBe(
        'https://example.com/target',
      );
    });
  });
});

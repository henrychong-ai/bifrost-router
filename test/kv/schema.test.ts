import { describe, it, expect } from 'vitest';
import {
  routeKey,
  parseRouteKey,
  domainPrefix,
  RouteConfigSchema,
  CreateRouteSchema,
  UpdateRouteSchema,
  SCHEMA_VERSION,
} from '../../src/kv/schema';
import { R2_BUCKETS } from '../../src/types';

describe('routeKey', () => {
  it('constructs a key from domain and path', () => {
    expect(routeKey('link.example.com', '/github')).toBe('link.example.com:/github');
  });

  it('handles root path', () => {
    expect(routeKey('example.com', '/')).toBe('example.com:/');
  });

  it('handles wildcard paths', () => {
    expect(routeKey('link.example.com', '/blog/*')).toBe('link.example.com:/blog/*');
  });

  it('handles paths with special characters', () => {
    expect(routeKey('link.example.com', '/hello world')).toBe('link.example.com:/hello world');
    expect(routeKey('link.example.com', '/path/with-dashes')).toBe(
      'link.example.com:/path/with-dashes',
    );
    expect(routeKey('link.example.com', '/path/with_underscores')).toBe(
      'link.example.com:/path/with_underscores',
    );
  });

  it('handles deeply nested paths', () => {
    expect(routeKey('example.com', '/a/b/c/d/e')).toBe('example.com:/a/b/c/d/e');
  });
});

describe('parseRouteKey', () => {
  it('parses a valid key into domain and path', () => {
    const [domain, path] = parseRouteKey('link.example.com:/github');
    expect(domain).toBe('link.example.com');
    expect(path).toBe('/github');
  });

  it('parses root path key', () => {
    const [domain, path] = parseRouteKey('example.com:/');
    expect(domain).toBe('example.com');
    expect(path).toBe('/');
  });

  it('parses wildcard path key', () => {
    const [domain, path] = parseRouteKey('link.example.com:/blog/*');
    expect(domain).toBe('link.example.com');
    expect(path).toBe('/blog/*');
  });

  it('handles paths with special characters', () => {
    const [domain, path] = parseRouteKey('link.example.com:/hello world');
    expect(domain).toBe('link.example.com');
    expect(path).toBe('/hello world');
  });

  it('throws on invalid key without colon', () => {
    expect(() => parseRouteKey('invalid-key-no-colon')).toThrow('Invalid route key format');
  });

  it('handles key with multiple colons (only splits on first)', () => {
    const [domain, path] = parseRouteKey('link.example.com:/path:with:colons');
    expect(domain).toBe('link.example.com');
    expect(path).toBe('/path:with:colons');
  });
});

describe('domainPrefix', () => {
  it('creates a prefix for domain listing', () => {
    expect(domainPrefix('link.example.com')).toBe('link.example.com:');
  });

  it('creates prefix for various domains', () => {
    expect(domainPrefix('example.com')).toBe('example.com:');
    expect(domainPrefix('secondary.example.com')).toBe('secondary.example.com:');
    expect(domainPrefix('user.example.net')).toBe('user.example.net:');
  });
});

describe('RouteConfigSchema', () => {
  describe('valid inputs', () => {
    it('accepts a minimal redirect route', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/your-username',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.path).toBe('/github');
        expect(result.data.type).toBe('redirect');
        expect(result.data.target).toBe('https://github.com/your-username');
        // Check defaults
        expect(result.data.preserveQuery).toBe(true);
        expect(result.data.enabled).toBe(true);
        expect(result.data.forceDownload).toBe(false);
        expect(result.data.preservePath).toBe(false);
      }
    });

    it('accepts a proxy route', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/blog',
        type: 'proxy',
        target: 'https://blog.example.com',
      });
      expect(result.success).toBe(true);
    });

    it('accepts an r2 route', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/files/doc.pdf',
        type: 'r2',
        target: 'documents/doc.pdf',
      });
      expect(result.success).toBe(true);
    });

    it('accepts all optional fields', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/full',
        type: 'redirect',
        target: 'https://example.com',
        statusCode: 301,
        preserveQuery: false,
        preservePath: true,
        cacheControl: 'public, max-age=3600',
        hostHeader: 'example.com',
        forceDownload: true,
        bucket: 'assets',
        enabled: false,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.statusCode).toBe(301);
        expect(result.data.preserveQuery).toBe(false);
        expect(result.data.preservePath).toBe(true);
        expect(result.data.cacheControl).toBe('public, max-age=3600');
        expect(result.data.hostHeader).toBe('example.com');
        expect(result.data.forceDownload).toBe(true);
        expect(result.data.bucket).toBe('assets');
        expect(result.data.enabled).toBe(false);
      }
    });

    it('accepts wildcard paths', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/blog/*',
        type: 'proxy',
        target: 'https://blog.example.com',
      });
      expect(result.success).toBe(true);
    });

    it('accepts all valid status codes', () => {
      for (const code of [301, 302, 307, 308]) {
        const result = RouteConfigSchema.safeParse({
          path: '/test',
          type: 'redirect',
          target: 'https://example.com',
          statusCode: code,
        });
        expect(result.success).toBe(true);
      }
    });

    it('accepts all valid R2 buckets', () => {
      for (const bucket of R2_BUCKETS) {
        const result = RouteConfigSchema.safeParse({
          path: '/test',
          type: 'r2',
          target: 'key.pdf',
          bucket,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('invalid inputs', () => {
    it('rejects missing path', () => {
      const result = RouteConfigSchema.safeParse({
        type: 'redirect',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing type', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing target', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        type: 'redirect',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid type', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        type: 'invalid',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid status code', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        type: 'redirect',
        target: 'https://example.com',
        statusCode: 200,
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty path', () => {
      const result = RouteConfigSchema.safeParse({
        path: '',
        type: 'redirect',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('rejects path without leading slash', () => {
      const result = RouteConfigSchema.safeParse({
        path: 'no-slash',
        type: 'redirect',
        target: 'https://example.com',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty target', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        type: 'redirect',
        target: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid bucket name', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        type: 'r2',
        target: 'key.pdf',
        bucket: 'nonexistent-bucket',
      });
      expect(result.success).toBe(false);
    });

    it('rejects wrong field types', () => {
      const result = RouteConfigSchema.safeParse({
        path: '/test',
        type: 'redirect',
        target: 'https://example.com',
        preserveQuery: 'yes', // should be boolean
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('CreateRouteSchema', () => {
  it('is the same as RouteConfigSchema', () => {
    // CreateRouteSchema is an alias for RouteConfigSchema
    const input = {
      path: '/create-test',
      type: 'redirect' as const,
      target: 'https://example.com',
    };
    const configResult = RouteConfigSchema.safeParse(input);
    const createResult = CreateRouteSchema.safeParse(input);
    expect(configResult.success).toBe(createResult.success);
  });
});

describe('UpdateRouteSchema', () => {
  it('requires path', () => {
    const result = UpdateRouteSchema.safeParse({
      target: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('accepts path with optional fields', () => {
    const result = UpdateRouteSchema.safeParse({
      path: '/update-test',
    });
    expect(result.success).toBe(true);
  });

  it('accepts path with some optional overrides', () => {
    const result = UpdateRouteSchema.safeParse({
      path: '/update-test',
      target: 'https://updated.com',
      enabled: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/update-test');
      expect(result.data.target).toBe('https://updated.com');
      expect(result.data.enabled).toBe(false);
    }
  });
});

describe('SCHEMA_VERSION', () => {
  it('is a valid semver string', () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is version 2.0.0', () => {
    expect(SCHEMA_VERSION).toBe('2.0.0');
  });
});

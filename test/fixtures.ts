import type { KVRouteConfig } from '../src/types';

/**
 * Test fixtures for route configurations
 */
export const fixtures = {
  redirectRoute: {
    path: '/github',
    type: 'redirect' as const,
    target: 'https://github.com/henrychong-ai',
    statusCode: 302 as const,
    preserveQuery: true,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies KVRouteConfig,

  proxyRoute: {
    path: '/blog/*',
    type: 'proxy' as const,
    target: 'https://blog.example.com',
    cacheControl: 'public, max-age=3600',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies KVRouteConfig,

  r2Route: {
    path: '/media-kit/download',
    type: 'r2' as const,
    target: 'media-kit/henrychong-media-kit.zip',
    cacheControl: 'public, max-age=86400',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies KVRouteConfig,

  disabledRoute: {
    path: '/disabled',
    type: 'redirect' as const,
    target: 'https://example.com',
    enabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } satisfies KVRouteConfig,
};

/**
 * Create a mock route with custom overrides
 */
export function createMockRoute(
  overrides: Partial<KVRouteConfig> = {},
): KVRouteConfig {
  return {
    path: '/test',
    type: 'redirect',
    target: 'https://example.com',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Create test API headers with admin key
 */
export function createAdminHeaders(apiKey = 'test-api-key-12345'): Headers {
  return new Headers({
    'X-Admin-Key': apiKey,
    'Content-Type': 'application/json',
  });
}

/**
 * Test constants
 */
export const TEST_API_KEY = 'test-api-key-12345';
export const INVALID_API_KEY = 'invalid-key';

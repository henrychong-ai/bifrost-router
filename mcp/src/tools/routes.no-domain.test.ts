import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EdgeRouterClient } from '@bifrost/shared';
import { SUPPORTED_DOMAINS } from '@bifrost/shared';
import {
  createRoute,
  deleteRoute,
  getRoute,
  handleTransferRoute,
  listRoutes,
  migrateRoute,
  toggleRoute,
  updateRoute,
} from './routes';

/**
 * v1.34.1 — every route handler that takes a domain refuses to run without one
 * and says exactly what to do about it: every supported domain is listed, and
 * the remedy names EDGE_ROUTER_DOMAIN as the MCP server's environment (the
 * process's setting, never something a client sends). No client call is made.
 */
describe('no-domain guard on every route tool', () => {
  let mockClient: EdgeRouterClient;
  beforeEach(() => {
    mockClient = {
      listRoutes: vi.fn(),
      getRoute: vi.fn(),
      createRoute: vi.fn(),
      updateRoute: vi.fn(),
      deleteRoute: vi.fn(),
      toggleRoute: vi.fn(),
      migrateRoute: vi.fn(),
      transferRoute: vi.fn(),
    } as unknown as EdgeRouterClient;
  });

  const CASES = [
    ['list_routes', listRoutes, {}],
    ['get_route', getRoute, { path: '/x' }],
    ['create_route', createRoute, { path: '/x', type: 'redirect', target: 'https://example.com' }],
    ['update_route', updateRoute, { path: '/x' }],
    ['delete_route', deleteRoute, { path: '/x' }],
    ['toggle_route', toggleRoute, { path: '/x', enabled: true }],
    ['migrate_route', migrateRoute, { oldPath: '/a', newPath: '/b' }],
  ] as const;

  it.each(CASES)(
    '%s without a domain returns the actionable error',
    async (_tool, handler, args) => {
      const result = await (
        handler as (c: EdgeRouterClient, a: unknown, d?: string) => Promise<string>
      )(mockClient, args, undefined);
      expect(result).toContain('No domain specified');
      for (const domain of SUPPORTED_DOMAINS) {
        expect(result).toContain(domain);
      }
      expect(result).toContain("EDGE_ROUTER_DOMAIN in the MCP server's environment");
      for (const fn of Object.values(mockClient)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it('transfer_route: both domains are explicit, never defaulted, and the error names the missing one', async () => {
    const noTarget = await handleTransferRoute(mockClient, {
      path: '/x',
      from_domain: 'links.example.com',
    });
    expect(noTarget).toContain('transfer_route is missing to_domain');
    for (const domain of SUPPORTED_DOMAINS) {
      expect(noTarget).toContain(domain);
    }
    const noSource = await handleTransferRoute(mockClient, {
      path: '/x',
      to_domain: 'links.example.com',
    });
    expect(noSource).toContain('transfer_route is missing from_domain');
    const neither = await handleTransferRoute(mockClient, { path: '/x' });
    expect(neither).toContain('transfer_route is missing from_domain and to_domain');
    expect(neither).toContain('never guessed');
    expect(mockClient.transferRoute).not.toHaveBeenCalled();
  });
});

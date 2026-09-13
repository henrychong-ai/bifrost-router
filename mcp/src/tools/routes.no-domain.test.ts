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
import { createQr, deleteQr, getQr, getRouteQr, listQrs, updateQr } from './qr';
import { getSlugStats } from './analytics';

/**
 * v1.35.0 — there is no default domain. Every stdio handler that needs one
 * refuses without it, lists every supported domain so an agent recovers in one
 * retry, and makes no client call. The low-level stdio Server validates
 * nothing, so these guards ARE the enforcement on that transport.
 */
describe('no-domain guard on every domain-required tool', () => {
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
      listQrs: vi.fn(),
      getQr: vi.fn(),
      createQr: vi.fn(),
      updateQr: vi.fn(),
      deleteQr: vi.fn(),
      getRouteQrSvg: vi.fn(),
      getSlugStats: vi.fn(),
    } as unknown as EdgeRouterClient;
  });

  /** The 14 tools that require a domain: 7 route + 6 QR + get_slug_stats. */
  const CASES = [
    ['list_routes', listRoutes, {}],
    ['get_route', getRoute, { path: '/x' }],
    ['create_route', createRoute, { path: '/x', type: 'redirect', target: 'https://example.com' }],
    ['update_route', updateRoute, { path: '/x' }],
    ['delete_route', deleteRoute, { path: '/x' }],
    ['toggle_route', toggleRoute, { path: '/x', enabled: true }],
    ['migrate_route', migrateRoute, { oldPath: '/a', newPath: '/b' }],
    ['list_qrs', listQrs, {}],
    ['get_qr', getQr, { id: 'abc' }],
    ['create_qr', createQr, { type: 'url', payload: { url: 'https://example.com' } }],
    ['update_qr', updateQr, { id: 'abc', description: 'x' }],
    ['delete_qr', deleteQr, { id: 'abc' }],
    ['get_route_qr', getRouteQr, { path: '/x' }],
    ['get_slug_stats', getSlugStats, { slug: '/x' }],
  ] as const;

  it('covers all 14 domain-required tools', () => {
    expect(CASES).toHaveLength(14);
  });

  it.each(CASES)(
    '%s without a domain returns the actionable error and calls nothing',
    async (_tool, handler, args) => {
      const result = await (handler as (c: EdgeRouterClient, a: unknown) => Promise<string>)(
        mockClient,
        args,
      );
      expect(result).toContain('No domain specified');
      for (const domain of SUPPORTED_DOMAINS) {
        expect(result).toContain(domain);
      }
      // The environment variable is gone: never point the operator at it again.
      expect(result).not.toContain('EDGE_ROUTER_DOMAIN');
      for (const fn of Object.values(mockClient)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(CASES)('%s refuses an empty-string domain too', async (_tool, handler, args) => {
    const result = await (handler as (c: EdgeRouterClient, a: unknown) => Promise<string>)(
      mockClient,
      { ...args, domain: '' },
    );
    expect(result).toContain('No domain specified');
    for (const fn of Object.values(mockClient)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  /**
   * The stdio server hands raw JSON-RPC `arguments` to the handlers with no
   * validation, so a non-string `domain` is exactly as reachable as a missing
   * key. Anything that is not a non-empty string must be refused before the
   * client is touched — a number or an object reaching `client.deleteRoute`
   * would be stringified into a query parameter and hit whatever the API
   * defaults to.
   */
  const NON_STRING_DOMAINS: [string, unknown][] = [
    ['a number', 123],
    ['null', null],
    ['true', true],
    ['an object', {}],
    ['an array', []],
  ];

  const NON_STRING_MATRIX = CASES.flatMap(([tool, handler, args]) =>
    NON_STRING_DOMAINS.map(([label, domain]) => [tool, label, handler, args, domain] as const),
  );

  it('covers every tool against every non-string domain', () => {
    expect(NON_STRING_MATRIX).toHaveLength(CASES.length * NON_STRING_DOMAINS.length);
  });

  it.each(NON_STRING_MATRIX)(
    '%s refuses %s as a domain and calls nothing',
    async (_tool, _label, handler, args, domain) => {
      const result = await (handler as (c: EdgeRouterClient, a: unknown) => Promise<string>)(
        mockClient,
        { ...args, domain },
      );
      expect(result).toContain('No domain specified');
      for (const fn of Object.values(mockClient)) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  /**
   * A tools/call with no `arguments` object reaches the handler as `{}`
   * (mcp/src/index.ts defaults it), so every family must answer with the
   * actionable error rather than throwing on a missing property.
   */
  it.each([
    ['route family (list_routes)', listRoutes],
    ['QR family (list_qrs)', listQrs],
    ['analytics family (get_slug_stats)', getSlugStats],
  ] as const)('%s: an empty args object yields the no-domain error', async (_family, handler) => {
    const result = await (handler as (c: EdgeRouterClient, a: unknown) => Promise<string>)(
      mockClient,
      {},
    );
    expect(result).toContain('No domain specified');
    for (const fn of Object.values(mockClient)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  /**
   * Which fields the error reports as missing, read out of the message by NAME.
   * The remedy sentence that follows always mentions both field names ("Pass
   * both from_domain and to_domain explicitly"), so asserting on the whole
   * string — or on punctuation like "to_domain." — cannot tell the three cases
   * apart. Parse the list instead.
   */
  const missingFields = (message: string): string[] => {
    const match = message.match(/transfer_route is missing ([^.]+)\./);
    return match ? match[1].split(' and ') : [];
  };

  it('transfer_route: both domains are explicit, never defaulted, and the error names the missing one', async () => {
    const noTarget = await handleTransferRoute(mockClient, {
      path: '/x',
      from_domain: 'links.example.com',
    });
    expect(missingFields(noTarget)).toEqual(['to_domain']);
    for (const domain of SUPPORTED_DOMAINS) {
      expect(noTarget).toContain(domain);
    }
    const noSource = await handleTransferRoute(mockClient, {
      path: '/x',
      to_domain: 'links.example.com',
    });
    expect(missingFields(noSource)).toEqual(['from_domain']);
    const neither = await handleTransferRoute(mockClient, { path: '/x' });
    expect(missingFields(neither)).toEqual(['from_domain', 'to_domain']);
    expect(neither).toContain('never guessed');
    expect(neither).not.toContain('EDGE_ROUTER_DOMAIN');
    expect(mockClient.transferRoute).not.toHaveBeenCalled();
  });

  // Each transfer field is guarded independently: a non-string in one is
  // refused even when the other is a real domain, and the error names the bad
  // field. A transfer deletes at the source, so this is the field that matters
  // most.
  it.each(NON_STRING_DOMAINS)(
    'transfer_route refuses %s in from_domain while to_domain is valid',
    async (_label, domain) => {
      const result = await handleTransferRoute(mockClient, {
        path: '/x',
        from_domain: domain as string,
        to_domain: 'links.example.com',
      });
      expect(missingFields(result)).toEqual(['from_domain']);
      expect(mockClient.transferRoute).not.toHaveBeenCalled();
    },
  );

  it.each(NON_STRING_DOMAINS)(
    'transfer_route refuses %s in to_domain while from_domain is valid',
    async (_label, domain) => {
      const result = await handleTransferRoute(mockClient, {
        path: '/x',
        from_domain: 'links.example.com',
        to_domain: domain as string,
      });
      expect(missingFields(result)).toEqual(['to_domain']);
      expect(mockClient.transferRoute).not.toHaveBeenCalled();
    },
  );

  it.each(NON_STRING_DOMAINS)(
    'transfer_route refuses %s in both fields',
    async (_label, domain) => {
      const result = await handleTransferRoute(mockClient, {
        path: '/x',
        from_domain: domain as string,
        to_domain: domain as string,
      });
      expect(missingFields(result)).toEqual(['from_domain', 'to_domain']);
      expect(mockClient.transferRoute).not.toHaveBeenCalled();
    },
  );

  // item 4 — the happy path. Without this the guards could be "correct" by
  // refusing everything: prove a valid transfer reaches the client with the two
  // domains in the right ORDER (swapping them would delete from the wrong one)
  // and that the report names the destination.
  it('a valid transfer calls the client with (path, fromDomain, toDomain) in that order', async () => {
    const transferRoute = vi.fn().mockResolvedValue({
      path: '/x',
      type: 'redirect',
      target: 'https://target.example.com',
      enabled: true,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    const client = { ...mockClient, transferRoute } as unknown as EdgeRouterClient;

    const result = await handleTransferRoute(client, {
      path: '/x',
      from_domain: 'links.example.com',
      to_domain: 'secondary.example.net',
    });

    expect(transferRoute).toHaveBeenCalledTimes(1);
    expect(transferRoute).toHaveBeenCalledWith('/x', 'links.example.com', 'secondary.example.net');
    expect(result).toContain('Route transferred successfully!');
    expect(result).toContain('From: links.example.com');
    expect(result).toContain('To: secondary.example.net');
    // The route details are rendered against the DESTINATION domain.
    expect(result).toContain('Domain: secondary.example.net');
  });
});

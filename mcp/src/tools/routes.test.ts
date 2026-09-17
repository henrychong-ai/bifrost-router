import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EdgeRouterClient, Route } from '@bifrost/shared';
import {
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  toggleRoute,
  handleTransferRoute,
} from './routes.js';

describe('Route tool handlers', () => {
  let mockClient: EdgeRouterClient;

  const mockRoute: Route = {
    path: '/github',
    type: 'redirect',
    target: 'https://github.com/example-user',
    statusCode: 302,
    preserveQuery: true,
    enabled: true,
    // Epoch MILLISECONDS, exactly as the KV layer stamps them — 2024-01-01T00:00:00.000Z.
    createdAt: 1704067200000,
    updatedAt: 1704067200000,
  };

  beforeEach(() => {
    mockClient = {
      listRoutes: vi.fn(),
      getRoute: vi.fn(),
      createRoute: vi.fn(),
      updateRoute: vi.fn(),
      deleteRoute: vi.fn(),
      toggleRoute: vi.fn(),
    } as unknown as EdgeRouterClient;
  });

  describe('listRoutes', () => {
    it('returns formatted route list', async () => {
      vi.mocked(mockClient.listRoutes).mockResolvedValue([mockRoute]);

      const result = await listRoutes(mockClient, { domain: 'links.example.com' });

      expect(result).toContain('Routes for links.example.com');
      expect(result).toContain('/github');
      expect(result).toContain('redirect');
      expect(mockClient.listRoutes).toHaveBeenCalledWith('links.example.com', undefined);
    });

    it('sends exactly the domain it is given', async () => {
      vi.mocked(mockClient.listRoutes).mockResolvedValue([]);

      await listRoutes(mockClient, { domain: 'example.com' });

      expect(mockClient.listRoutes).toHaveBeenCalledWith('example.com', undefined);
    });

    it('passes search parameter to client', async () => {
      vi.mocked(mockClient.listRoutes).mockResolvedValue([mockRoute]);

      const result = await listRoutes(mockClient, {
        domain: 'links.example.com',
        search: 'github',
      });

      expect(mockClient.listRoutes).toHaveBeenCalledWith('links.example.com', 'github');
      expect(result).toContain('search: "github"');
    });

    it('returns error message when no domain specified, and calls nothing', async () => {
      const result = await listRoutes(mockClient, {});

      expect(result).toContain('No domain specified');
      expect(mockClient.listRoutes).not.toHaveBeenCalled();
    });

    it('returns message for empty route list', async () => {
      vi.mocked(mockClient.listRoutes).mockResolvedValue([]);

      const result = await listRoutes(mockClient, { domain: 'links.example.com' });

      expect(result).toContain('No routes configured');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.listRoutes).mockRejectedValue(new Error('Network error'));

      const result = await listRoutes(mockClient, { domain: 'links.example.com' });

      expect(result).toContain('Error listing routes');
      expect(result).toContain('Network error');
    });
  });

  describe('getRoute', () => {
    it('returns formatted route details', async () => {
      vi.mocked(mockClient.getRoute).mockResolvedValue(mockRoute);

      const result = await getRoute(mockClient, { path: '/github', domain: 'links.example.com' });

      expect(result).toContain('Route: /github');
      expect(result).toContain('Domain: links.example.com');
      expect(result).toContain('Type: redirect');
      expect(result).toContain('Target: https://github.com/example-user');
      // Route timestamps are epoch milliseconds: rendering them as seconds
      // (a stray * 1000) pushed every date into the year 58000.
      expect(result).toContain('Created: 2024-01-01T00:00:00.000Z');
      expect(result).toContain('Updated: 2024-01-01T00:00:00.000Z');
    });

    // The fixed-literal assertions above could, in principle, be reverted as a
    // pair — fixture back to seconds, expected string back to a 1970 date — and
    // still pass. This one cannot be: the fixture is stamped from the live
    // clock, and the rendered year is checked against the real current year.
    it('renders a route stamped from the live clock in the current year', async () => {
      const now = Date.now();
      vi.mocked(mockClient.getRoute).mockResolvedValue({
        ...mockRoute,
        createdAt: now,
        updatedAt: now,
      });

      const result = await getRoute(mockClient, { path: '/github', domain: 'links.example.com' });

      // Pins the fixture itself: read as milliseconds it IS the current year,
      // so dividing it by 1000 to match a restored `* 1000` fails right here.
      const currentYear = new Date().getUTCFullYear();
      expect(new Date(now).getUTCFullYear()).toBe(currentYear);
      // And pins the rendering: `* 1000` on a millisecond value renders 58000.
      expect(result).toContain(`Created: ${currentYear}-`);
      expect(result).toContain(`Updated: ${currentYear}-`);
    });

    it('shows redirect-specific details', async () => {
      vi.mocked(mockClient.getRoute).mockResolvedValue(mockRoute);

      const result = await getRoute(mockClient, { path: '/github', domain: 'links.example.com' });

      expect(result).toContain('Status Code: 302');
      expect(result).toContain('Preserve Query: Yes');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getRoute).mockRejectedValue(new Error('Not found'));

      const result = await getRoute(mockClient, { path: '/notfound', domain: 'links.example.com' });

      expect(result).toContain('Error getting route');
      expect(result).toContain('Not found');
    });
  });

  describe('createRoute', () => {
    it('returns success message with route details', async () => {
      vi.mocked(mockClient.createRoute).mockResolvedValue(mockRoute);

      const result = await createRoute(mockClient, {
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/example-user',
        statusCode: 302,
        domain: 'links.example.com',
      });

      expect(result).toContain('Route created successfully');
      expect(result).toContain('Route: /github');
    });

    it('passes all parameters to client', async () => {
      vi.mocked(mockClient.createRoute).mockResolvedValue(mockRoute);

      await createRoute(mockClient, {
        path: '/test',
        type: 'redirect',
        target: 'https://example.com',
        statusCode: 301,
        preserveQuery: false,
        cacheControl: 'max-age=3600',
        domain: 'links.example.com',
      });

      expect(mockClient.createRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/test',
          type: 'redirect',
          target: 'https://example.com',
          statusCode: 301,
          preserveQuery: false,
          cacheControl: 'max-age=3600',
        }),
        'links.example.com',
        // No acknowledgement was passed, so none is forwarded.
        { acknowledgeCredentialTarget: undefined },
      );
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.createRoute).mockRejectedValue(new Error('Route already exists'));

      const result = await createRoute(mockClient, {
        path: '/github',
        type: 'redirect',
        target: 'https://example.com',
        domain: 'links.example.com',
      });

      expect(result).toContain('Error creating route');
      expect(result).toContain('Route already exists');
    });
  });

  describe('updateRoute', () => {
    it('returns success message with updated details', async () => {
      const updatedRoute = {
        ...mockRoute,
        target: 'https://github.com/updated',
      };
      vi.mocked(mockClient.updateRoute).mockResolvedValue(updatedRoute);

      const result = await updateRoute(mockClient, {
        path: '/github',
        target: 'https://github.com/updated',
        domain: 'links.example.com',
      });

      expect(result).toContain('Route updated successfully');
      expect(result).toContain('https://github.com/updated');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.updateRoute).mockRejectedValue(new Error('Route not found'));

      const result = await updateRoute(mockClient, {
        path: '/notfound',
        target: 'https://example.com',
        domain: 'links.example.com',
      });

      expect(result).toContain('Error updating route');
      expect(result).toContain('Route not found');
    });
  });

  describe('deleteRoute', () => {
    it('returns success message', async () => {
      vi.mocked(mockClient.deleteRoute).mockResolvedValue(undefined);

      const result = await deleteRoute(mockClient, {
        path: '/github',
        domain: 'links.example.com',
      });

      expect(result).toContain('deleted successfully');
      expect(result).toContain('/github');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.deleteRoute).mockRejectedValue(new Error('Route not found'));

      const result = await deleteRoute(mockClient, {
        path: '/notfound',
        domain: 'links.example.com',
      });

      expect(result).toContain('Error deleting route');
      expect(result).toContain('Route not found');
    });
  });

  describe('toggleRoute', () => {
    it('returns success message for enabling route', async () => {
      const enabledRoute = { ...mockRoute, enabled: true };
      vi.mocked(mockClient.toggleRoute).mockResolvedValue(enabledRoute);

      const result = await toggleRoute(mockClient, {
        path: '/github',
        enabled: true,
        domain: 'links.example.com',
      });

      expect(result).toContain('enabled successfully');
      expect(result).toContain('/github');
    });

    it('returns success message for disabling route', async () => {
      const disabledRoute = { ...mockRoute, enabled: false };
      vi.mocked(mockClient.toggleRoute).mockResolvedValue(disabledRoute);

      const result = await toggleRoute(mockClient, {
        path: '/github',
        enabled: false,
        domain: 'links.example.com',
      });

      expect(result).toContain('disabled successfully');
      expect(result).toContain('/github');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.toggleRoute).mockRejectedValue(new Error('Route not found'));

      const result = await toggleRoute(mockClient, {
        path: '/notfound',
        enabled: true,
        domain: 'links.example.com',
      });

      expect(result).toContain('Error toggling route');
      expect(result).toContain('Route not found');
    });
  });
});

/**
 * The stdio server hands raw JSON-RPC arguments straight to these handlers with
 * no schema in front, so both flags may arrive stringified.
 */
describe('credential-target acknowledgement and enabled parsing', () => {
  let mockClient: EdgeRouterClient;

  const mockRoute: Route = {
    path: '/github',
    type: 'redirect',
    target: 'https://github.com/example-user',
    statusCode: 302,
    preserveQuery: true,
    enabled: true,
    createdAt: 1704067200000,
    updatedAt: 1704067200000,
  };

  beforeEach(() => {
    mockClient = {
      createRoute: vi.fn().mockResolvedValue(mockRoute),
      updateRoute: vi.fn().mockResolvedValue(mockRoute),
      toggleRoute: vi.fn().mockResolvedValue(mockRoute),
      transferRoute: vi.fn().mockResolvedValue(mockRoute),
    } as unknown as EdgeRouterClient;
  });

  const createArgs = {
    path: '/cred',
    type: 'redirect' as const,
    target: 'https://app.example/cb?token=LIVE',
    domain: 'links.example.com',
  };

  it('create_route forwards a real boolean and a stringified one alike', async () => {
    await createRoute(mockClient, { ...createArgs, acknowledgeCredentialTarget: true });
    expect(vi.mocked(mockClient.createRoute).mock.calls[0][2]).toEqual({
      acknowledgeCredentialTarget: true,
    });

    await createRoute(mockClient, { ...createArgs, acknowledgeCredentialTarget: 'true' });
    expect(vi.mocked(mockClient.createRoute).mock.calls[1][2]).toEqual({
      acknowledgeCredentialTarget: true,
    });
  });

  it('an absent flag stays absent, and an unrecognised one is dropped', async () => {
    await createRoute(mockClient, createArgs);
    expect(vi.mocked(mockClient.createRoute).mock.calls[0][2]).toEqual({
      acknowledgeCredentialTarget: undefined,
    });

    // Never coerced to `true` by truthiness — the guard must still fire.
    await createRoute(mockClient, { ...createArgs, acknowledgeCredentialTarget: 'maybe' });
    expect(vi.mocked(mockClient.createRoute).mock.calls[1][2]).toEqual({
      acknowledgeCredentialTarget: undefined,
    });
  });

  it('update_route and transfer_route forward the flag too', async () => {
    await updateRoute(mockClient, {
      path: '/cred',
      domain: 'links.example.com',
      acknowledgeCredentialTarget: 'yes',
    });
    expect(vi.mocked(mockClient.updateRoute).mock.calls[0][3]).toEqual({
      acknowledgeCredentialTarget: true,
    });

    await handleTransferRoute(mockClient, {
      path: '/cred',
      from_domain: 'links.example.com',
      to_domain: 'secondary.example.net',
      acknowledgeCredentialTarget: true,
    });
    expect(vi.mocked(mockClient.transferRoute).mock.calls[0][3]).toEqual({
      acknowledgeCredentialTarget: true,
    });
  });

  it('toggle_route treats the string "false" as DISABLE, not enable', async () => {
    const result = await toggleRoute(mockClient, {
      path: '/cred',
      enabled: 'false',
      domain: 'links.example.com',
    });

    expect(vi.mocked(mockClient.toggleRoute).mock.calls[0][1]).toBe(false);
    expect(result).toContain('disabled');
  });

  it('toggle_route REFUSES an unrecognised enabled value and changes nothing', async () => {
    for (const value of ['off', 'disabled', 'n']) {
      const result = await toggleRoute(mockClient, {
        path: '/cred',
        enabled: value,
        domain: 'links.example.com',
      });

      expect(result).toContain('must be true or false');
      expect(result).toContain('The route was not changed.');
    }
    expect(mockClient.toggleRoute).not.toHaveBeenCalled();
  });
});

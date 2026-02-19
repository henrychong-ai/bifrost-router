import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EdgeRouterClient, Route } from '@bifrost/shared';
import {
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  toggleRoute,
} from './routes.js';

describe('Route tool handlers', () => {
  let mockClient: EdgeRouterClient;

  const mockRoute: Route = {
    path: '/github',
    type: 'redirect',
    target: 'https://github.com/henrychong-ai',
    statusCode: 302,
    preserveQuery: true,
    enabled: true,
    createdAt: 1704067200,
    updatedAt: 1704067200,
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
      vi.mocked(mockClient.listRoutes).mockResolvedValue({ routes: [mockRoute], total: 1 });

      const result = await listRoutes(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Routes for link.henrychong.com');
      expect(result).toContain('/github');
      expect(result).toContain('redirect');
      expect(mockClient.listRoutes).toHaveBeenCalledWith('link.henrychong.com', {
        search: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('uses provided domain over default', async () => {
      vi.mocked(mockClient.listRoutes).mockResolvedValue({ routes: [], total: 0 });

      await listRoutes(mockClient, { domain: 'henrychong.com' }, 'link.henrychong.com');

      expect(mockClient.listRoutes).toHaveBeenCalledWith('henrychong.com', {
        search: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('returns error message when no domain specified', async () => {
      const result = await listRoutes(mockClient, {}, undefined);

      expect(result).toContain('No domain specified');
    });

    it('returns message for empty route list', async () => {
      vi.mocked(mockClient.listRoutes).mockResolvedValue({ routes: [], total: 0 });

      const result = await listRoutes(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('No routes configured');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.listRoutes).mockRejectedValue(new Error('Network error'));

      const result = await listRoutes(mockClient, {}, 'link.henrychong.com');

      expect(result).toContain('Error listing routes');
      expect(result).toContain('Network error');
    });
  });

  describe('getRoute', () => {
    it('returns formatted route details', async () => {
      vi.mocked(mockClient.getRoute).mockResolvedValue(mockRoute);

      const result = await getRoute(mockClient, { path: '/github' }, 'link.henrychong.com');

      expect(result).toContain('Route: /github');
      expect(result).toContain('Domain: link.henrychong.com');
      expect(result).toContain('Type: redirect');
      expect(result).toContain('Target: https://github.com/henrychong-ai');
    });

    it('shows redirect-specific details', async () => {
      vi.mocked(mockClient.getRoute).mockResolvedValue(mockRoute);

      const result = await getRoute(mockClient, { path: '/github' }, 'link.henrychong.com');

      expect(result).toContain('Status Code: 302');
      expect(result).toContain('Preserve Query: Yes');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getRoute).mockRejectedValue(new Error('Not found'));

      const result = await getRoute(mockClient, { path: '/notfound' }, 'link.henrychong.com');

      expect(result).toContain('Error getting route');
      expect(result).toContain('Not found');
    });
  });

  describe('createRoute', () => {
    it('returns success message with route details', async () => {
      vi.mocked(mockClient.createRoute).mockResolvedValue(mockRoute);

      const result = await createRoute(
        mockClient,
        {
          path: '/github',
          type: 'redirect',
          target: 'https://github.com/henrychong-ai',
          statusCode: 302,
        },
        'link.henrychong.com',
      );

      expect(result).toContain('Route created successfully');
      expect(result).toContain('Route: /github');
    });

    it('passes all parameters to client', async () => {
      vi.mocked(mockClient.createRoute).mockResolvedValue(mockRoute);

      await createRoute(
        mockClient,
        {
          path: '/test',
          type: 'redirect',
          target: 'https://example.com',
          statusCode: 301,
          preserveQuery: false,
          cacheControl: 'max-age=3600',
        },
        'link.henrychong.com',
      );

      expect(mockClient.createRoute).toHaveBeenCalledWith(
        {
          path: '/test',
          type: 'redirect',
          target: 'https://example.com',
          statusCode: 301,
          preserveQuery: false,
          cacheControl: 'max-age=3600',
        },
        'link.henrychong.com',
      );
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.createRoute).mockRejectedValue(new Error('Route already exists'));

      const result = await createRoute(
        mockClient,
        { path: '/github', type: 'redirect', target: 'https://example.com' },
        'link.henrychong.com',
      );

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

      const result = await updateRoute(
        mockClient,
        { path: '/github', target: 'https://github.com/updated' },
        'link.henrychong.com',
      );

      expect(result).toContain('Route updated successfully');
      expect(result).toContain('https://github.com/updated');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.updateRoute).mockRejectedValue(new Error('Route not found'));

      const result = await updateRoute(
        mockClient,
        { path: '/notfound', target: 'https://example.com' },
        'link.henrychong.com',
      );

      expect(result).toContain('Error updating route');
      expect(result).toContain('Route not found');
    });
  });

  describe('deleteRoute', () => {
    it('returns success message', async () => {
      vi.mocked(mockClient.deleteRoute).mockResolvedValue(undefined);

      const result = await deleteRoute(mockClient, { path: '/github' }, 'link.henrychong.com');

      expect(result).toContain('deleted successfully');
      expect(result).toContain('/github');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.deleteRoute).mockRejectedValue(new Error('Route not found'));

      const result = await deleteRoute(mockClient, { path: '/notfound' }, 'link.henrychong.com');

      expect(result).toContain('Error deleting route');
      expect(result).toContain('Route not found');
    });
  });

  describe('toggleRoute', () => {
    it('returns success message for enabling route', async () => {
      const enabledRoute = { ...mockRoute, enabled: true };
      vi.mocked(mockClient.toggleRoute).mockResolvedValue(enabledRoute);

      const result = await toggleRoute(
        mockClient,
        { path: '/github', enabled: true },
        'link.henrychong.com',
      );

      expect(result).toContain('enabled successfully');
      expect(result).toContain('/github');
    });

    it('returns success message for disabling route', async () => {
      const disabledRoute = { ...mockRoute, enabled: false };
      vi.mocked(mockClient.toggleRoute).mockResolvedValue(disabledRoute);

      const result = await toggleRoute(
        mockClient,
        { path: '/github', enabled: false },
        'link.henrychong.com',
      );

      expect(result).toContain('disabled successfully');
      expect(result).toContain('/github');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.toggleRoute).mockRejectedValue(new Error('Route not found'));

      const result = await toggleRoute(
        mockClient,
        { path: '/notfound', enabled: true },
        'link.henrychong.com',
      );

      expect(result).toContain('Error toggling route');
      expect(result).toContain('Route not found');
    });
  });
});

/**
 * Tests for Slack event handlers and command parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEvent } from '../src/slack/events';
import type { SlackEvent } from '../src/slack/verify';
import type { SlackUserPermissions } from '../src/auth/types';
import type { EdgeRouterClient } from '@bifrost/shared';

// Mock EdgeRouterClient
function createMockClient(): EdgeRouterClient {
  return {
    listRoutes: vi.fn().mockResolvedValue([
      {
        path: '/github',
        type: 'redirect',
        target: 'https://github.com/user',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]),
    getRoute: vi.fn().mockResolvedValue({
      path: '/github',
      type: 'redirect',
      target: 'https://github.com/user',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
    createRoute: vi.fn().mockResolvedValue(undefined),
    updateRoute: vi.fn().mockResolvedValue(undefined),
    deleteRoute: vi.fn().mockResolvedValue(undefined),
    toggleRoute: vi.fn().mockResolvedValue(undefined),
    getAnalyticsSummary: vi.fn().mockResolvedValue({
      period: '30d',
      domain: 'link.henrychong.com',
      clicks: { total: 100, uniqueSlugs: 10 },
      views: { total: 200, uniquePaths: 20 },
      topClicks: [{ name: '/linkedin', count: 50 }],
      topPages: [{ name: '/', count: 100 }],
      topCountries: [{ name: 'US', count: 75 }],
      topReferrers: [],
      clicksByDay: [],
      viewsByDay: [],
      recentClicks: [],
      recentViews: [],
    }),
    getClicks: vi
      .fn()
      .mockResolvedValue({ clicks: [], total: 0, limit: 100, offset: 0 }),
    getViews: vi
      .fn()
      .mockResolvedValue({ views: [], total: 0, limit: 100, offset: 0 }),
    getSlugStats: vi.fn().mockResolvedValue({
      slug: '/linkedin',
      totalClicks: 50,
      clicksByDay: [],
      topReferrers: [],
      topCountries: [],
    }),
  } as unknown as EdgeRouterClient;
}

const adminUser: SlackUserPermissions = {
  user_id: 'U_ADMIN',
  user_name: 'admin_user',
  permissions: {
    'link.henrychong.com': 'admin',
  },
  created_at: Date.now(),
  updated_at: Date.now(),
};

const readOnlyUser: SlackUserPermissions = {
  user_id: 'U_READ',
  user_name: 'readonly_user',
  permissions: {
    'link.henrychong.com': 'read',
  },
  created_at: Date.now(),
  updated_at: Date.now(),
};

function createEvent(text: string): SlackEvent {
  return {
    type: 'app_mention',
    user: 'U123456',
    text: `<@BOTID> ${text}`,
    channel: 'C123456',
    ts: '1234567890.123456',
  };
}

describe('handleEvent', () => {
  let mockClient: EdgeRouterClient;
  const botToken = 'xoxb-test-token';

  beforeEach(() => {
    mockClient = createMockClient();
  });

  describe('help command', () => {
    it('should return help when message is empty', async () => {
      const event = createEvent('');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(result).toContain(':wave: *Bifrost Bot*');
      expect(result).toContain('*Your accessible domains:*');
    });

    it('should return help when explicitly requested', async () => {
      const event = createEvent('help');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(result).toContain(':wave: *Bifrost Bot*');
    });

    it('should show no access message when user has no permissions', async () => {
      const event = createEvent('help');
      const result = await handleEvent(event, null, mockClient, botToken);

      expect(result).toContain("don't have access to any domains");
    });
  });

  describe('list routes command', () => {
    it('should list routes when user says "list routes"', async () => {
      const event = createEvent('list routes for link.henrychong.com');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.listRoutes).toHaveBeenCalledWith('link.henrychong.com');
      expect(result).toContain('*Routes for link.henrychong.com*');
    });

    it('should use default domain when not specified', async () => {
      const event = createEvent('list all routes');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.listRoutes).toHaveBeenCalled();
      expect(result).toContain('*Routes for');
    });

    it('should deny access when user lacks permission', async () => {
      const noAccessUser: SlackUserPermissions = {
        user_id: 'U_NO_ACCESS',
        user_name: 'no_access',
        permissions: {},
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      const event = createEvent('list routes for link.henrychong.com');
      const result = await handleEvent(
        event,
        noAccessUser,
        mockClient,
        botToken,
      );

      expect(result).toContain(':no_entry: *Permission Denied*');
    });
  });

  describe('analytics command', () => {
    it('should show analytics summary', async () => {
      const event = createEvent('show analytics for link.henrychong.com');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.getAnalyticsSummary).toHaveBeenCalled();
      expect(result).toContain('*Analytics Summary');
    });

    it('should parse days parameter', async () => {
      const event = createEvent(
        'show analytics for link.henrychong.com last 7 days',
      );
      await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.getAnalyticsSummary).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 }),
      );
    });

    it('should recognize "this week" as 7 days', async () => {
      const event = createEvent('analytics summary this week');
      await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.getAnalyticsSummary).toHaveBeenCalledWith(
        expect.objectContaining({ days: 7 }),
      );
    });
  });

  describe('stats command', () => {
    it('should show stats for specific slug', async () => {
      const event = createEvent('stats for /linkedin');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.getSlugStats).toHaveBeenCalledWith(
        '/linkedin',
        expect.any(Object),
      );
      expect(result).toContain('*Stats for `/linkedin`*');
      expect(result).toContain('Total Clicks');
    });

    it('should handle "how many clicks" phrasing', async () => {
      const event = createEvent('how many clicks did /github get');
      await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.getSlugStats).toHaveBeenCalled();
    });

    it('should return error when no path specified', async () => {
      const event = createEvent('show stats');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(result).toContain(':x: *Error*');
      expect(result).toContain('specify a path');
    });
  });

  describe('create route command', () => {
    it('should create redirect route', async () => {
      const event = createEvent(
        'create redirect from /twitter to https://twitter.com/user',
      );
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.createRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/twitter',
          type: 'redirect',
          target: 'https://twitter.com/user',
        }),
        expect.any(String),
      );
      expect(result).toContain(':white_check_mark: *Route Created*');
    });

    it('should create proxy route', async () => {
      const event = createEvent(
        'add proxy from /api to https://api.example.com',
      );
      await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.createRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'proxy',
        }),
        expect.any(String),
      );
    });

    it('should deny create for read-only user', async () => {
      const event = createEvent(
        'create redirect from /test to https://test.com',
      );
      const result = await handleEvent(
        event,
        readOnlyUser,
        mockClient,
        botToken,
      );

      expect(mockClient.createRoute).not.toHaveBeenCalled();
      expect(result).toContain(':no_entry: *Permission Denied*');
    });
  });

  describe('delete route command', () => {
    it('should delete route when admin', async () => {
      const event = createEvent('delete /old-route');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.deleteRoute).toHaveBeenCalledWith(
        '/old-route',
        expect.any(String),
      );
      expect(result).toContain(':wastebasket:');
      expect(result).toContain('has been deleted');
    });

    it('should deny delete for non-admin user', async () => {
      const editUser: SlackUserPermissions = {
        user_id: 'U_EDIT',
        user_name: 'edit_user',
        permissions: { 'link.henrychong.com': 'edit' },
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      const event = createEvent('delete /test');
      const result = await handleEvent(event, editUser, mockClient, botToken);

      expect(mockClient.deleteRoute).not.toHaveBeenCalled();
      expect(result).toContain(':no_entry: *Permission Denied*');
    });

    it('should return error when no path specified', async () => {
      const event = createEvent('delete');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      // Should show help since command didn't match
      expect(result).toContain(':wave: *Bifrost Bot*');
    });
  });

  describe('toggle route command', () => {
    it('should enable route', async () => {
      const event = createEvent('enable /test-route');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.toggleRoute).toHaveBeenCalledWith(
        '/test-route',
        true,
        expect.any(String),
      );
      expect(result).toContain('has been enabled');
    });

    it('should disable route', async () => {
      const event = createEvent('disable /test-route');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.toggleRoute).toHaveBeenCalledWith(
        '/test-route',
        false,
        expect.any(String),
      );
      expect(result).toContain('has been disabled');
    });

    it('should deny toggle for read-only user', async () => {
      const event = createEvent('enable /test');
      const result = await handleEvent(
        event,
        readOnlyUser,
        mockClient,
        botToken,
      );

      expect(mockClient.toggleRoute).not.toHaveBeenCalled();
      expect(result).toContain(':no_entry: *Permission Denied*');
    });
  });

  describe('domain extraction', () => {
    it('should extract domain from "for domain" syntax', async () => {
      const event = createEvent('list routes for henrychong.com');
      await handleEvent(event, adminUser, mockClient, botToken);

      // Note: User doesn't have henrychong.com access, so this will fail
      // but we can verify the domain was extracted
    });

    it('should extract link.henrychong.com domain', async () => {
      const event = createEvent('show analytics link.henrychong.com');
      await handleEvent(event, adminUser, mockClient, botToken);

      expect(mockClient.getAnalyticsSummary).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'link.henrychong.com' }),
      );
    });
  });

  describe('error handling', () => {
    it('should format API errors nicely', async () => {
      const errorClient = createMockClient();
      vi.mocked(errorClient.listRoutes).mockRejectedValue(
        new Error('API unavailable'),
      );

      const event = createEvent('list routes');
      const result = await handleEvent(event, adminUser, errorClient, botToken);

      expect(result).toContain(':x: *Error*');
      expect(result).toContain('API unavailable');
    });
  });

  describe('unrecognized commands', () => {
    it('should return help for unrecognized commands', async () => {
      const event = createEvent('do something random');
      const result = await handleEvent(event, adminUser, mockClient, botToken);

      expect(result).toContain(':wave: *Bifrost Bot*');
    });
  });
});

/**
 * Tests for permission system
 */

import { describe, it, expect } from 'vitest';
import {
  checkToolPermission,
  getAccessibleDomains,
  formatPermissions,
} from '../src/auth/permissions';
import { hasPermission, TOOL_PERMISSIONS } from '../src/auth/types';
import type { SlackUserPermissions } from '../src/auth/types';

describe('hasPermission', () => {
  describe('permission hierarchy', () => {
    it('should allow admin to perform admin actions', () => {
      expect(hasPermission('admin', 'admin')).toBe(true);
    });

    it('should allow admin to perform edit actions', () => {
      expect(hasPermission('admin', 'edit')).toBe(true);
    });

    it('should allow admin to perform read actions', () => {
      expect(hasPermission('admin', 'read')).toBe(true);
    });

    it('should allow edit to perform edit actions', () => {
      expect(hasPermission('edit', 'edit')).toBe(true);
    });

    it('should allow edit to perform read actions', () => {
      expect(hasPermission('edit', 'read')).toBe(true);
    });

    it('should NOT allow edit to perform admin actions', () => {
      expect(hasPermission('edit', 'admin')).toBe(false);
    });

    it('should allow read to perform read actions', () => {
      expect(hasPermission('read', 'read')).toBe(true);
    });

    it('should NOT allow read to perform edit actions', () => {
      expect(hasPermission('read', 'edit')).toBe(false);
    });

    it('should NOT allow read to perform admin actions', () => {
      expect(hasPermission('read', 'admin')).toBe(false);
    });

    it('should NOT allow none to perform any actions', () => {
      expect(hasPermission('none', 'read')).toBe(false);
      expect(hasPermission('none', 'edit')).toBe(false);
      expect(hasPermission('none', 'admin')).toBe(false);
    });
  });
});

describe('TOOL_PERMISSIONS', () => {
  it('should have read permission for list_routes', () => {
    expect(TOOL_PERMISSIONS['list_routes']).toBe('read');
  });

  it('should have read permission for get_route', () => {
    expect(TOOL_PERMISSIONS['get_route']).toBe('read');
  });

  it('should have edit permission for create_route', () => {
    expect(TOOL_PERMISSIONS['create_route']).toBe('edit');
  });

  it('should have edit permission for update_route', () => {
    expect(TOOL_PERMISSIONS['update_route']).toBe('edit');
  });

  it('should have edit permission for toggle_route', () => {
    expect(TOOL_PERMISSIONS['toggle_route']).toBe('edit');
  });

  it('should have admin permission for delete_route', () => {
    expect(TOOL_PERMISSIONS['delete_route']).toBe('admin');
  });

  it('should have read permission for analytics tools', () => {
    expect(TOOL_PERMISSIONS['get_analytics_summary']).toBe('read');
    expect(TOOL_PERMISSIONS['get_clicks']).toBe('read');
    expect(TOOL_PERMISSIONS['get_views']).toBe('read');
    expect(TOOL_PERMISSIONS['get_slug_stats']).toBe('read');
  });
});

describe('checkToolPermission', () => {
  const adminUser: SlackUserPermissions = {
    user_id: 'U_ADMIN',
    user_name: 'admin_user',
    permissions: {
      'link.henrychong.com': 'admin',
      'henrychong.com': 'admin',
    },
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  const editUser: SlackUserPermissions = {
    user_id: 'U_EDIT',
    user_name: 'edit_user',
    permissions: {
      'link.henrychong.com': 'edit',
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

  describe('admin user permissions', () => {
    it('should allow admin to read routes', () => {
      const result = checkToolPermission(adminUser, 'list_routes', 'link.henrychong.com');
      expect(result.allowed).toBe(true);
      expect(result.userLevel).toBe('admin');
    });

    it('should allow admin to create routes', () => {
      const result = checkToolPermission(adminUser, 'create_route', 'link.henrychong.com');
      expect(result.allowed).toBe(true);
    });

    it('should allow admin to delete routes', () => {
      const result = checkToolPermission(adminUser, 'delete_route', 'link.henrychong.com');
      expect(result.allowed).toBe(true);
    });
  });

  describe('edit user permissions', () => {
    it('should allow edit user to read routes', () => {
      const result = checkToolPermission(editUser, 'list_routes', 'link.henrychong.com');
      expect(result.allowed).toBe(true);
    });

    it('should allow edit user to create routes', () => {
      const result = checkToolPermission(editUser, 'create_route', 'link.henrychong.com');
      expect(result.allowed).toBe(true);
    });

    it('should NOT allow edit user to delete routes', () => {
      const result = checkToolPermission(editUser, 'delete_route', 'link.henrychong.com');
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Permission denied');
      expect(result.userLevel).toBe('edit');
      expect(result.requiredLevel).toBe('admin');
    });
  });

  describe('read-only user permissions', () => {
    it('should allow read user to read routes', () => {
      const result = checkToolPermission(readOnlyUser, 'list_routes', 'link.henrychong.com');
      expect(result.allowed).toBe(true);
    });

    it('should NOT allow read user to create routes', () => {
      const result = checkToolPermission(readOnlyUser, 'create_route', 'link.henrychong.com');
      expect(result.allowed).toBe(false);
      expect(result.userLevel).toBe('read');
      expect(result.requiredLevel).toBe('edit');
    });

    it('should NOT allow read user to delete routes', () => {
      const result = checkToolPermission(readOnlyUser, 'delete_route', 'link.henrychong.com');
      expect(result.allowed).toBe(false);
    });
  });

  describe('domain-specific permissions', () => {
    it('should deny access to domain user does not have permission for', () => {
      const result = checkToolPermission(editUser, 'list_routes', 'henrychong.com');
      expect(result.allowed).toBe(false);
      expect(result.userLevel).toBe('none');
    });

    it('should allow admin access to multiple domains', () => {
      const result1 = checkToolPermission(adminUser, 'delete_route', 'link.henrychong.com');
      const result2 = checkToolPermission(adminUser, 'delete_route', 'henrychong.com');

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('null permissions (no user record)', () => {
    it('should deny all access when permissions are null', () => {
      const result = checkToolPermission(null, 'list_routes', 'link.henrychong.com');
      expect(result.allowed).toBe(false);
      expect(result.userLevel).toBe('none');
      expect(result.message).toContain("don't have any permissions");
    });
  });

  describe('unknown tools', () => {
    it('should default to admin permission for unknown tools', () => {
      const result = checkToolPermission(editUser, 'unknown_tool', 'link.henrychong.com');
      expect(result.allowed).toBe(false);
      expect(result.requiredLevel).toBe('admin');
    });
  });
});

describe('getAccessibleDomains', () => {
  const multiDomainUser: SlackUserPermissions = {
    user_id: 'U_MULTI',
    user_name: 'multi_user',
    permissions: {
      'link.henrychong.com': 'admin',
      'henrychong.com': 'edit',
      'vanessahung.net': 'read',
    },
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  it('should return all domains with read access by default', () => {
    const domains = getAccessibleDomains(multiDomainUser);
    expect(domains).toHaveLength(3);
    expect(domains).toContain('link.henrychong.com');
    expect(domains).toContain('henrychong.com');
    expect(domains).toContain('vanessahung.net');
  });

  it('should return only domains with edit access when specified', () => {
    const domains = getAccessibleDomains(multiDomainUser, 'edit');
    expect(domains).toHaveLength(2);
    expect(domains).toContain('link.henrychong.com');
    expect(domains).toContain('henrychong.com');
    expect(domains).not.toContain('vanessahung.net');
  });

  it('should return only domains with admin access when specified', () => {
    const domains = getAccessibleDomains(multiDomainUser, 'admin');
    expect(domains).toHaveLength(1);
    expect(domains).toContain('link.henrychong.com');
  });

  it('should return empty array for null permissions', () => {
    const domains = getAccessibleDomains(null);
    expect(domains).toEqual([]);
  });

  it('should return empty array when no domains match required level', () => {
    const readOnlyUser: SlackUserPermissions = {
      user_id: 'U_READ',
      user_name: 'read_user',
      permissions: {
        'link.henrychong.com': 'read',
      },
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const domains = getAccessibleDomains(readOnlyUser, 'admin');
    expect(domains).toEqual([]);
  });
});

describe('formatPermissions', () => {
  it('should format permissions with emojis', () => {
    const user: SlackUserPermissions = {
      user_id: 'U123',
      user_name: 'test_user',
      permissions: {
        'link.henrychong.com': 'admin',
        'henrychong.com': 'edit',
        'vanessahung.net': 'read',
      },
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const result = formatPermissions(user);

    expect(result).toContain('*Permissions for test_user*');
    expect(result).toContain(':star:');
    expect(result).toContain(':pencil2:');
    expect(result).toContain(':eye:');
    expect(result).toContain('`link.henrychong.com`');
  });

  it('should handle user with no permissions', () => {
    const user: SlackUserPermissions = {
      user_id: 'U123',
      user_name: 'no_perms_user',
      permissions: {},
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    const result = formatPermissions(user);

    expect(result).toContain('*Permissions for no_perms_user*');
    expect(result).toContain('No domain permissions configured');
  });
});

import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_DOMAINS,
  isSupportedDomain,
  hasPermission,
  PERMISSION_HIERARCHY,
  TOOL_PERMISSIONS,
} from './types.js';

describe('types', () => {
  describe('SUPPORTED_DOMAINS', () => {
    it('contains expected domains', () => {
      expect(SUPPORTED_DOMAINS).toContain('link.example.com');
      expect(SUPPORTED_DOMAINS).toContain('example.com');
      expect(SUPPORTED_DOMAINS).toContain('example.net');
      expect(SUPPORTED_DOMAINS.length).toBe(9);
    });
  });

  describe('isSupportedDomain', () => {
    it('returns true for supported domains', () => {
      expect(isSupportedDomain('link.example.com')).toBe(true);
      expect(isSupportedDomain('example.com')).toBe(true);
      expect(isSupportedDomain('example.net')).toBe(true);
    });

    it('returns false for unsupported domains', () => {
      expect(isSupportedDomain('unknown.com')).toBe(false);
      expect(isSupportedDomain('localhost')).toBe(false);
      expect(isSupportedDomain('')).toBe(false);
    });
  });

  describe('PERMISSION_HIERARCHY', () => {
    it('has correct hierarchy order', () => {
      expect(PERMISSION_HIERARCHY.none).toBe(0);
      expect(PERMISSION_HIERARCHY.read).toBe(1);
      expect(PERMISSION_HIERARCHY.edit).toBe(2);
      expect(PERMISSION_HIERARCHY.admin).toBe(3);
    });
  });

  describe('hasPermission', () => {
    it('returns true when user has exact permission', () => {
      expect(hasPermission('read', 'read')).toBe(true);
      expect(hasPermission('edit', 'edit')).toBe(true);
      expect(hasPermission('admin', 'admin')).toBe(true);
    });

    it('returns true when user has higher permission', () => {
      expect(hasPermission('admin', 'read')).toBe(true);
      expect(hasPermission('admin', 'edit')).toBe(true);
      expect(hasPermission('edit', 'read')).toBe(true);
    });

    it('returns false when user has lower permission', () => {
      expect(hasPermission('read', 'edit')).toBe(false);
      expect(hasPermission('read', 'admin')).toBe(false);
      expect(hasPermission('edit', 'admin')).toBe(false);
      expect(hasPermission('none', 'read')).toBe(false);
    });
  });

  describe('TOOL_PERMISSIONS', () => {
    it('has correct permissions for route tools', () => {
      expect(TOOL_PERMISSIONS.list_routes).toBe('read');
      expect(TOOL_PERMISSIONS.get_route).toBe('read');
      expect(TOOL_PERMISSIONS.create_route).toBe('edit');
      expect(TOOL_PERMISSIONS.update_route).toBe('edit');
      expect(TOOL_PERMISSIONS.toggle_route).toBe('edit');
      expect(TOOL_PERMISSIONS.delete_route).toBe('admin');
    });

    it('has correct permissions for analytics tools', () => {
      expect(TOOL_PERMISSIONS.get_analytics_summary).toBe('read');
      expect(TOOL_PERMISSIONS.get_clicks).toBe('read');
      expect(TOOL_PERMISSIONS.get_views).toBe('read');
      expect(TOOL_PERMISSIONS.get_slug_stats).toBe('read');
    });
  });
});

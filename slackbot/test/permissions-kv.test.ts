/**
 * Tests for KV-backed permission CRUD functions
 *
 * Uses vi.fn() mocking for KV operations, matching the existing slackbot test pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getUserPermissions,
  setUserPermissions,
  deleteUserPermissions,
} from '../src/auth/permissions';
import type { SlackUserPermissions } from '../src/auth/types';

function makePermissions(overrides: Partial<SlackUserPermissions> = {}): SlackUserPermissions {
  return {
    user_id: 'U_TEST_001',
    user_name: 'test_user',
    permissions: { 'links.example.com': 'admin' },
    created_at: 1700000000000,
    updated_at: 1700000000000,
    ...overrides,
  };
}

describe('KV permission CRUD', () => {
  let mockKV: KVNamespace;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    mockKV = {
      get: vi.fn(async (key: string, type?: string) => {
        const value = store.get(key);
        if (!value) return null;
        return type === 'json' ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace;
  });

  describe('getUserPermissions', () => {
    it('returns null for a non-existent user', async () => {
      const result = await getUserPermissions(mockKV, 'U_NONEXISTENT');
      expect(result).toBeNull();
      expect(mockKV.get).toHaveBeenCalledWith('slack-permissions:U_NONEXISTENT', 'json');
    });

    it('returns stored permissions for an existing user', async () => {
      const perms = makePermissions();
      store.set('slack-permissions:U_TEST_001', JSON.stringify(perms));

      const result = await getUserPermissions(mockKV, 'U_TEST_001');
      expect(result).toEqual(perms);
    });
  });

  describe('setUserPermissions', () => {
    it('stores permissions that can be retrieved', async () => {
      const perms = makePermissions();
      await setUserPermissions(mockKV, perms);

      expect(mockKV.put).toHaveBeenCalledWith(
        'slack-permissions:U_TEST_001',
        JSON.stringify(perms),
      );
      expect(store.has('slack-permissions:U_TEST_001')).toBe(true);

      const result = await getUserPermissions(mockKV, 'U_TEST_001');
      expect(result).toEqual(perms);
    });

    it('overwrites existing permissions on second write', async () => {
      const first = makePermissions({ permissions: { 'links.example.com': 'read' } });
      const second = makePermissions({ permissions: { 'links.example.com': 'admin' } });

      await setUserPermissions(mockKV, first);
      await setUserPermissions(mockKV, second);

      const result = await getUserPermissions(mockKV, 'U_TEST_001');
      expect(result?.permissions['links.example.com']).toBe('admin');
    });
  });

  describe('deleteUserPermissions', () => {
    it('removes permissions so they return null', async () => {
      const perms = makePermissions();
      await setUserPermissions(mockKV, perms);
      expect(store.has('slack-permissions:U_TEST_001')).toBe(true);

      await deleteUserPermissions(mockKV, 'U_TEST_001');
      expect(mockKV.delete).toHaveBeenCalledWith('slack-permissions:U_TEST_001');

      const result = await getUserPermissions(mockKV, 'U_TEST_001');
      expect(result).toBeNull();
    });

    it('does not throw when deleting a non-existent user', async () => {
      await expect(deleteUserPermissions(mockKV, 'U_GHOST')).resolves.not.toThrow();
    });
  });

  describe('KV key format', () => {
    it('uses "slack-permissions:" prefix for storage keys', async () => {
      const perms = makePermissions({ user_id: 'U_KEY_TEST' });
      await setUserPermissions(mockKV, perms);

      expect(mockKV.put).toHaveBeenCalledWith('slack-permissions:U_KEY_TEST', expect.any(String));
    });

    it('does not store under the user_id alone (no prefix)', async () => {
      const perms = makePermissions({ user_id: 'U_PREFIX_CHECK' });
      await setUserPermissions(mockKV, perms);

      expect(store.has('U_PREFIX_CHECK')).toBe(false);
      expect(store.has('slack-permissions:U_PREFIX_CHECK')).toBe(true);
    });
  });

  describe('round-trip integrity', () => {
    it('preserves all fields through set and get', async () => {
      const perms = makePermissions({
        user_id: 'U_ROUNDTRIP',
        user_name: 'roundtrip_user',
        permissions: {
          'links.example.com': 'admin',
          'bifrost.example.com': 'edit',
          'secondary.example.net': 'read',
        },
        created_at: 1700000000000,
        updated_at: 1700100000000,
      });

      await setUserPermissions(mockKV, perms);
      const result = await getUserPermissions(mockKV, 'U_ROUNDTRIP');

      expect(result).toEqual(perms);
    });
  });
});

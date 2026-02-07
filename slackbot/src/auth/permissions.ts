/**
 * Permission checking middleware and utilities
 *
 * Manages user permissions stored in KV for Slack-based route management
 */

import type {
  SlackUserPermissions,
  PermissionLevel,
} from './types';
import { hasPermission, TOOL_PERMISSIONS } from './types';

/**
 * Key prefix for permission records in KV
 */
const KV_PREFIX = 'slack-permissions:';

/**
 * Get user permissions from KV
 *
 * @param kv - KV namespace binding
 * @param userId - Slack user ID
 * @returns User permissions or null if not found
 */
export async function getUserPermissions(
  kv: KVNamespace,
  userId: string
): Promise<SlackUserPermissions | null> {
  const key = `${KV_PREFIX}${userId}`;
  const data = await kv.get<SlackUserPermissions>(key, 'json');

  if (!data) {
    console.info(
      JSON.stringify({
        level: 'info',
        message: 'User permissions not found',
        userId,
      })
    );
    return null;
  }

  return data;
}

/**
 * Set user permissions in KV
 *
 * @param kv - KV namespace binding
 * @param permissions - User permissions to store
 */
export async function setUserPermissions(
  kv: KVNamespace,
  permissions: SlackUserPermissions
): Promise<void> {
  const key = `${KV_PREFIX}${permissions.user_id}`;
  await kv.put(key, JSON.stringify(permissions));

  console.info(
    JSON.stringify({
      level: 'info',
      message: 'User permissions updated',
      userId: permissions.user_id,
      userName: permissions.user_name,
    })
  );
}

/**
 * Delete user permissions from KV
 *
 * @param kv - KV namespace binding
 * @param userId - Slack user ID
 */
export async function deleteUserPermissions(
  kv: KVNamespace,
  userId: string
): Promise<void> {
  const key = `${KV_PREFIX}${userId}`;
  await kv.delete(key);

  console.info(
    JSON.stringify({
      level: 'info',
      message: 'User permissions deleted',
      userId,
    })
  );
}

/**
 * Check if a user has permission to execute a tool on a domain
 *
 * @param permissions - User's permissions
 * @param toolName - Name of the tool to execute
 * @param domain - Target domain
 * @returns Permission check result
 */
export interface PermissionCheckResult {
  allowed: boolean;
  userLevel: PermissionLevel;
  requiredLevel: PermissionLevel;
  domain: string;
  message?: string;
}

export function checkToolPermission(
  permissions: SlackUserPermissions | null,
  toolName: string,
  domain: string
): PermissionCheckResult {
  const requiredLevel = TOOL_PERMISSIONS[toolName] || 'admin';

  // No permissions record = no access
  if (!permissions) {
    return {
      allowed: false,
      userLevel: 'none',
      requiredLevel,
      domain,
      message: `You don't have any permissions configured. Contact an administrator.`,
    };
  }

  // Get user's level for this domain
  const userLevel = permissions.permissions[domain] || 'none';

  // Check hierarchy
  if (!hasPermission(userLevel, requiredLevel)) {
    return {
      allowed: false,
      userLevel,
      requiredLevel,
      domain,
      message: `Permission denied: You have '${userLevel}' access to ${domain}, but '${requiredLevel}' is required for ${toolName}.`,
    };
  }

  return {
    allowed: true,
    userLevel,
    requiredLevel,
    domain,
  };
}

/**
 * Get all domains a user has access to
 *
 * @param permissions - User's permissions
 * @param minLevel - Minimum permission level (default: 'read')
 * @returns Array of domain names
 */
export function getAccessibleDomains(
  permissions: SlackUserPermissions | null,
  minLevel: PermissionLevel = 'read'
): string[] {
  if (!permissions) {
    return [];
  }

  return Object.entries(permissions.permissions)
    .filter(([, level]) => hasPermission(level, minLevel))
    .map(([domain]) => domain);
}

/**
 * Format permissions as a readable string for Slack messages
 *
 * @param permissions - User's permissions
 * @returns Formatted string
 */
export function formatPermissions(permissions: SlackUserPermissions): string {
  const lines = [`*Permissions for ${permissions.user_name}*`, ''];

  const entries = Object.entries(permissions.permissions);

  if (entries.length === 0) {
    lines.push('No domain permissions configured.');
  } else {
    for (const [domain, level] of entries) {
      const emoji =
        level === 'admin' ? ':star:' : level === 'edit' ? ':pencil2:' : ':eye:';
      lines.push(`${emoji} \`${domain}\` - ${level}`);
    }
  }

  return lines.join('\n');
}

/**
 * Permission types for Slack-based route management
 */

/**
 * Permission levels for domain access
 * Hierarchy: admin > edit > read > none
 */
export type PermissionLevel = 'none' | 'read' | 'edit' | 'admin';

/**
 * Slack user permissions stored in KV
 */
export interface SlackUserPermissions {
  /** Slack user ID (e.g., "U1234567890") */
  user_id: string;
  /** Display name for logging */
  user_name: string;
  /** Per-domain permission levels */
  permissions: Record<string, PermissionLevel>;
  /** Unix timestamp of creation */
  created_at: number;
  /** Unix timestamp of last update */
  updated_at: number;
}

/**
 * Tool permission requirements
 * Maps tool names to required permission level
 */
export const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  // Read operations
  list_routes: 'read',
  get_route: 'read',
  get_analytics_summary: 'read',
  get_clicks: 'read',
  get_views: 'read',
  get_slug_stats: 'read',

  // Edit operations
  create_route: 'edit',
  update_route: 'edit',
  toggle_route: 'edit',

  // Admin operations
  delete_route: 'admin',
};

/**
 * Permission level hierarchy value for comparison
 */
const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  edit: 2,
  admin: 3,
};

/**
 * Check if a user has sufficient permission level
 * @param userLevel - User's permission level for the domain
 * @param requiredLevel - Required permission level for the operation
 * @returns true if user has sufficient permissions
 */
export function hasPermission(
  userLevel: PermissionLevel,
  requiredLevel: PermissionLevel
): boolean {
  return PERMISSION_HIERARCHY[userLevel] >= PERMISSION_HIERARCHY[requiredLevel];
}

/**
 * Bindings for the Slackbot Worker
 */
export interface SlackbotBindings {
  SLACK_PERMISSIONS: KVNamespace;
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ADMIN_API_KEY: string;
  EDGE_ROUTER_URL: string;
  ENVIRONMENT: string;
}

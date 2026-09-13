/**
 * Route management tool handlers for MCP server
 */

import { SUPPORTED_DOMAINS_LIST } from '@bifrost/shared';
import type { EdgeRouterClient, Route } from '@bifrost/shared';

/**
 * v1.35.0 — there is no default domain. Every route, QR and slug-stats call
 * names its own domain and nothing fills a missing one in.
 *
 * The low-level stdio Server validates nothing, so these handler guards ARE the
 * enforcement on this transport: they refuse before any client call, and the
 * error lists the valid domains so an agent recovers in one retry.
 */
export const NO_DOMAIN_ERROR = `Error: No domain specified. Pass the domain parameter — one of: ${SUPPORTED_DOMAINS_LIST}.`;

/**
 * Returns the caller's domain, or `undefined` when they named none.
 *
 * Takes `unknown` on purpose: the stdio server hands raw JSON-RPC arguments
 * straight to the handlers, so a non-string is as reachable as a missing key.
 */
export function requireDomain(domain: unknown): string | undefined {
  return typeof domain === 'string' && domain.length > 0 ? domain : undefined;
}

const transferDomainsError = (missing: string[]): string =>
  `Error: transfer_route is missing ${missing.join(' and ')}. Pass both from_domain and to_domain explicitly — one of: ${SUPPORTED_DOMAINS_LIST}. A transfer deletes the route from the source, so the source is never guessed.`;

/**
 * Format a route for display
 */
function formatRoute(route: Route): string {
  const status = route.enabled !== false ? '✓' : '✗';
  const statusCode = route.statusCode ? ` (${route.statusCode})` : '';
  return `${status} ${route.path} → ${route.type}${statusCode} → ${route.target}`;
}

/**
 * Format a list of routes for display
 */
function formatRouteList(routes: Route[], domain: string): string {
  if (routes.length === 0) {
    return `No routes configured for ${domain}`;
  }

  const lines = [
    `Routes for ${domain} (${routes.length} total):`,
    '',
    ...routes.map((r, i) => `${i + 1}. ${formatRoute(r)}`),
  ];

  return lines.join('\n');
}

/** Route timestamps are epoch milliseconds — `src/kv/routes.ts` stamps them with `Date.now()`. */
function formatRouteTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Format route details for display
 */
function formatRouteDetails(route: Route, domain: string): string {
  const lines = [
    `Route: ${route.path}`,
    `Domain: ${domain}`,
    '',
    `Type: ${route.type}`,
    `Target: ${route.target}`,
    `Status: ${route.enabled !== false ? 'Enabled' : 'Disabled'}`,
  ];

  if (route.type === 'redirect') {
    lines.push(`Status Code: ${route.statusCode || 302}`);
    lines.push(`Preserve Query: ${route.preserveQuery !== false ? 'Yes' : 'No'}`);
    lines.push(`Preserve Path: ${route.preservePath === true ? 'Yes' : 'No'}`);
  }

  if (route.type === 'proxy' && route.hostHeader) {
    lines.push(`Host Header: ${route.hostHeader}`);
  }

  if (route.type === 'r2') {
    lines.push(`Bucket: ${route.bucket || 'files'}`);
    lines.push(`Force Download: ${route.forceDownload === true ? 'Yes' : 'No'}`);
  }

  if (route.cacheControl) {
    lines.push(`Cache-Control: ${route.cacheControl}`);
  }

  lines.push('');
  lines.push(`Created: ${formatRouteTimestamp(route.createdAt)}`);
  lines.push(`Updated: ${formatRouteTimestamp(route.updatedAt)}`);

  return lines.join('\n');
}

/**
 * List all routes for a domain
 */
export async function listRoutes(
  client: EdgeRouterClient,
  args: { domain?: string; search?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const routes = await client.listRoutes(domain, args.search);
    if (args.search) {
      return formatRouteList(routes, `${domain} (search: "${args.search}")`);
    }
    return formatRouteList(routes, domain);
  } catch (error) {
    return `Error listing routes: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get a single route by path
 */
export async function getRoute(
  client: EdgeRouterClient,
  args: { path: string; domain?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const route = await client.getRoute(args.path, domain);
    return formatRouteDetails(route, domain);
  } catch (error) {
    return `Error getting route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Create a new route
 */
export async function createRoute(
  client: EdgeRouterClient,
  args: {
    path: string;
    type: 'redirect' | 'proxy' | 'r2';
    target: string;
    statusCode?: number;
    preserveQuery?: boolean;
    preservePath?: boolean;
    cacheControl?: string;
    hostHeader?: string;
    forceDownload?: boolean;
    bucket?: string;
    domain?: string;
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const route = await client.createRoute(
      {
        path: args.path,
        type: args.type,
        target: args.target,
        statusCode: args.statusCode as 301 | 302 | 307 | 308 | undefined,
        preserveQuery: args.preserveQuery,
        preservePath: args.preservePath,
        cacheControl: args.cacheControl,
        hostHeader: args.hostHeader,
        forceDownload: args.forceDownload,
        bucket: args.bucket as
          | 'files'
          | 'assets'
          | 'files-user1'
          | 'files-user2'
          | 'files-user3'
          | 'files-user4'
          | 'files-user5'
          | 'files-user6'
          | undefined,
      },
      domain,
    );

    return `Route created successfully!\n\n${formatRouteDetails(route, domain)}`;
  } catch (error) {
    return `Error creating route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Update an existing route
 */
export async function updateRoute(
  client: EdgeRouterClient,
  args: {
    path: string;
    type?: 'redirect' | 'proxy' | 'r2';
    target?: string;
    statusCode?: number;
    preserveQuery?: boolean;
    preservePath?: boolean;
    cacheControl?: string;
    hostHeader?: string;
    forceDownload?: boolean;
    bucket?: string;
    domain?: string;
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const route = await client.updateRoute(
      args.path,
      {
        type: args.type,
        target: args.target,
        statusCode: args.statusCode as 301 | 302 | 307 | 308 | undefined,
        preserveQuery: args.preserveQuery,
        preservePath: args.preservePath,
        cacheControl: args.cacheControl,
        hostHeader: args.hostHeader,
        forceDownload: args.forceDownload,
        bucket: args.bucket as
          | 'files'
          | 'assets'
          | 'files-user1'
          | 'files-user2'
          | 'files-user3'
          | 'files-user4'
          | 'files-user5'
          | 'files-user6'
          | undefined,
      },
      domain,
    );

    return `Route updated successfully!\n\n${formatRouteDetails(route, domain)}`;
  } catch (error) {
    return `Error updating route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Delete a route
 */
export async function deleteRoute(
  client: EdgeRouterClient,
  args: { path: string; domain?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    await client.deleteRoute(args.path, domain);
    return `Route ${args.path} deleted successfully from ${domain}.`;
  } catch (error) {
    return `Error deleting route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Toggle a route's enabled status
 */
export async function toggleRoute(
  client: EdgeRouterClient,
  args: { path: string; enabled: boolean; domain?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const route = await client.toggleRoute(args.path, args.enabled, domain);
    const action = args.enabled ? 'enabled' : 'disabled';
    return `Route ${args.path} ${action} successfully!\n\n${formatRouteDetails(route, domain)}`;
  } catch (error) {
    return `Error toggling route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Migrate a route to a new path
 */
export async function migrateRoute(
  client: EdgeRouterClient,
  args: { oldPath: string; newPath: string; domain?: string },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  try {
    const route = await client.migrateRoute(args.oldPath, args.newPath, domain);
    return `Route migrated successfully!\n\nOld path: ${args.oldPath}\nNew path: ${args.newPath}\n\n${formatRouteDetails(route, domain)}`;
  } catch (error) {
    return `Error migrating route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Transfer a route to a different domain
 */
export async function handleTransferRoute(
  client: EdgeRouterClient,
  args: { path: string; from_domain?: string; to_domain?: string },
): Promise<string> {
  // Both domains are explicit, never defaulted: a transfer deletes the route
  // from the source, so guessing the source would delete from a domain the
  // caller never named. The API already refuses a missing one; this guard names
  // which is missing and lists the valid domains. Both go through
  // requireDomain, so a non-string (the stdio server hands over raw JSON-RPC
  // arguments) is refused exactly like a missing key and never reaches the
  // client.
  const fromDomain = requireDomain(args.from_domain);
  const toDomain = requireDomain(args.to_domain);
  const missing = [...(fromDomain ? [] : ['from_domain']), ...(toDomain ? [] : ['to_domain'])];
  if (!fromDomain || !toDomain) {
    return transferDomainsError(missing);
  }

  try {
    const route = await client.transferRoute(args.path, fromDomain, toDomain);
    return [
      'Route transferred successfully!',
      '',
      `Path: ${args.path}`,
      `From: ${fromDomain}`,
      `To: ${toDomain}`,
      '',
      formatRouteDetails(route, toDomain),
    ].join('\n');
  } catch (error) {
    return `Error transferring route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

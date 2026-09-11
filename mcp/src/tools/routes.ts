/**
 * Route management tool handlers for MCP server
 */

import { SUPPORTED_DOMAINS_LIST } from '@bifrost/shared';
import type { EdgeRouterClient, Route } from '@bifrost/shared';

/**
 * v1.34.1 — list the valid domains and say where the default comes from:
 * EDGE_ROUTER_DOMAIN is read by the MCP server PROCESS, not sent by the client.
 */
const NO_DOMAIN_ERROR = `Error: No domain specified. Pass the domain parameter — one of: ${SUPPORTED_DOMAINS_LIST} — or set EDGE_ROUTER_DOMAIN in the MCP server's environment to default it.`;
const transferDomainsError = (missing: string[]): string =>
  `Error: transfer_route is missing ${missing.join(' and ')}. Pass both from_domain and to_domain explicitly — one of: ${SUPPORTED_DOMAINS_LIST}. Neither defaults to EDGE_ROUTER_DOMAIN: a transfer deletes the route from the source, so the source is never guessed.`;

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
  lines.push(`Created: ${new Date(route.createdAt * 1000).toISOString()}`);
  lines.push(`Updated: ${new Date(route.updatedAt * 1000).toISOString()}`);

  return lines.join('\n');
}

/**
 * List all routes for a domain
 */
export async function listRoutes(
  client: EdgeRouterClient,
  args: { domain?: string; search?: string },
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
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
  // v1.34.1 — both domains are explicit, never defaulted: a transfer deletes the
  // route from the source, so guessing it from EDGE_ROUTER_DOMAIN would delete
  // from a domain the caller never named. The API already refuses a missing
  // one; this guard names which is missing and lists the valid domains.
  const missing = [
    ...(args.from_domain ? [] : ['from_domain']),
    ...(args.to_domain ? [] : ['to_domain']),
  ];
  if (!args.from_domain || !args.to_domain) {
    return transferDomainsError(missing);
  }
  const fromDomain = args.from_domain;
  const toDomain = args.to_domain;

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

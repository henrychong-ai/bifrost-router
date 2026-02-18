/**
 * Route management tool handlers for MCP server
 */

import type { EdgeRouterClient, Route } from '@bifrost/shared';

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
  args: { domain?: string },
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;
  if (!domain) {
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
  }

  try {
    const routes = await client.listRoutes(domain);
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
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
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
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
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
          | 'files-anjachong'
          | 'files-davidchong'
          | 'files-nadjachong'
          | 'files-sonjachong'
          | 'files-valeriehung'
          | 'files-vanessahung'
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
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
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
          | 'files-anjachong'
          | 'files-davidchong'
          | 'files-nadjachong'
          | 'files-sonjachong'
          | 'files-valeriehung'
          | 'files-vanessahung'
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
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
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
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
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
    return 'Error: No domain specified. Set EDGE_ROUTER_DOMAIN environment variable or provide domain parameter.';
  }

  try {
    const route = await client.migrateRoute(args.oldPath, args.newPath, domain);
    return `Route migrated successfully!\n\nOld path: ${args.oldPath}\nNew path: ${args.newPath}\n\n${formatRouteDetails(route, domain)}`;
  } catch (error) {
    return `Error migrating route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

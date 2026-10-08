/**
 * Route management tool handlers for MCP server
 */

import type { EdgeRouterClient, InvalidRouteRow, Route } from '@bifrost/shared';
import { isInvalidRouteRow, SUPPORTED_DOMAINS_LIST } from '@bifrost/shared';
import { NO_DOMAIN_ERROR, requireDomain } from './domain.js';

/** The refusal of a transfer without both domains, naming which is missing. */
export const transferDomainsError = (missing: string[]): string =>
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
/**
 * A listed record that cannot be read (v1.38.0): marked, with the one thing
 * that can be done with it.
 */
export const UNREADABLE_ROUTE_NOTE =
  'UNREADABLE RECORD: stored in a shape that cannot be read; never served. Delete it with delete_route (recover_invalid: true, this exact path) and create it again.';

function formatRouteList(routes: Array<Route | InvalidRouteRow>, domain: string): string {
  if (routes.length === 0) {
    return `No routes configured for ${domain}`;
  }

  const lines = [
    `Routes for ${domain} (${routes.length} total):`,
    '',
    ...routes.map(
      (r, i) =>
        `${i + 1}. ${isInvalidRouteRow(r) ? `${r.path} — ${UNREADABLE_ROUTE_NOTE}` : formatRoute(r)}`,
    ),
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
  args: { domain?: string | undefined; search?: string | undefined },
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
  args: { path: string; domain?: string | undefined },
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
    statusCode?: number | undefined;
    preserveQuery?: boolean | undefined;
    preservePath?: boolean | undefined;
    cacheControl?: string | undefined;
    hostHeader?: string | undefined;
    forceDownload?: boolean | undefined;
    bucket?: string | undefined;
    domain?: string | undefined;
    /** Request-only operator override; never stored. */
    acknowledgeCredentialTarget?: boolean | undefined;
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
      { acknowledgeCredentialTarget: args.acknowledgeCredentialTarget },
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
    type?: 'redirect' | 'proxy' | 'r2' | undefined;
    target?: string | undefined;
    statusCode?: number | undefined;
    preserveQuery?: boolean | undefined;
    preservePath?: boolean | undefined;
    cacheControl?: string | undefined;
    hostHeader?: string | undefined;
    forceDownload?: boolean | undefined;
    bucket?: string | undefined;
    domain?: string | undefined;
    /** Request-only operator override; never stored. */
    acknowledgeCredentialTarget?: boolean | undefined;
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
      { acknowledgeCredentialTarget: args.acknowledgeCredentialTarget },
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
  args: {
    path: string;
    domain?: string | undefined;
    /** The exact-key recovery of an unreadable record (v1.38.0). */
    recover_invalid?: boolean | undefined;
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }
  const recoverInvalid = args.recover_invalid === true;

  try {
    await client.deleteRoute(args.path, domain, recoverInvalid ? { recoverInvalid } : {});
    return recoverInvalid
      ? `Unreadable route record ${args.path} deleted from ${domain}.`
      : `Route ${args.path} deleted successfully from ${domain}.`;
  } catch (error) {
    return `Error deleting route: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Toggle a route's enabled status
 */
export async function toggleRoute(
  client: EdgeRouterClient,
  args: {
    path: string;
    enabled: boolean;
    domain?: string | undefined;
    /** Request-only operator override; never stored. */
    acknowledgeCredentialTarget?: boolean | undefined;
  },
): Promise<string> {
  const domain = requireDomain(args.domain);
  if (!domain) {
    return NO_DOMAIN_ERROR;
  }

  const { enabled } = args;
  try {
    const route = await client.toggleRoute(args.path, enabled, domain, {
      acknowledgeCredentialTarget: args.acknowledgeCredentialTarget,
    });
    const action = enabled ? 'enabled' : 'disabled';
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
  args: { oldPath: string; newPath: string; domain?: string | undefined },
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
  args: {
    path: string;
    from_domain?: string | undefined;
    to_domain?: string | undefined;
    /** Request-only operator override; never stored. */
    acknowledgeCredentialTarget?: boolean | undefined;
  },
): Promise<string> {
  // Both domains are explicit, never defaulted: a transfer deletes the route
  // from the source, so guessing the source would delete from a domain the
  // caller never named. The API already refuses a missing one; this guard names
  // which is missing and lists the valid domains (the dispatcher answers it
  // first, from the raw arguments; this guard keeps a direct call alike).
  const fromDomain = requireDomain(args.from_domain);
  const toDomain = requireDomain(args.to_domain);
  const missing = [...(fromDomain ? [] : ['from_domain']), ...(toDomain ? [] : ['to_domain'])];
  if (!fromDomain || !toDomain) {
    return transferDomainsError(missing);
  }

  try {
    const route = await client.transferRoute(args.path, fromDomain, toDomain, {
      acknowledgeCredentialTarget: args.acknowledgeCredentialTarget,
    });
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

/**
 * Request-context helpers shared by the admin sub-routers (extracted from
 * admin.ts in v1.30.0 when the QR routes joined — mirrors the upstream
 * `src/routes/request-context.ts` layout and avoids a circular import
 * between admin.ts and its mounted sub-route modules).
 */

import { isValidDomain } from '../types';

/**
 * Result of parsing an optional domain from a request
 */
export type DomainParseResult =
  | { valid: true; domain: string | undefined }
  | { valid: false; error: string; domain?: undefined };

/**
 * Result of parsing a required domain from a request
 */
export type RequiredDomainParseResult =
  | { valid: true; domain: string }
  | { valid: false; error: string; domain?: undefined };

/**
 * Get target domain from request (for listing routes)
 * Priority: X-Domain header > ?domain query param > undefined (all domains)
 * Returns validation result including whether an invalid domain was provided
 */
export function getDomainFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): DomainParseResult {
  // Check X-Domain header first
  const domainHeader = c.req.header('X-Domain');
  if (domainHeader) {
    if (isValidDomain(domainHeader)) {
      return { valid: true, domain: domainHeader };
    }
    return { valid: false, error: `Invalid domain: ${domainHeader}` };
  }

  // Check query parameter
  const domainQuery = c.req.query('domain');
  if (domainQuery) {
    if (isValidDomain(domainQuery)) {
      return { valid: true, domain: domainQuery };
    }
    return { valid: false, error: `Invalid domain: ${domainQuery}` };
  }

  // Return undefined for "all domains" mode
  return { valid: true, domain: undefined };
}

/**
 * Get target domain from request (required for mutations)
 * Priority: X-Domain header > ?domain query param > ADMIN_API_DOMAIN env var > example.com fallback
 * Returns validation result - if invalid domain provided, returns validation failure
 */
export function getRequiredDomainFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
  env: { ADMIN_API_DOMAIN?: string };
}): RequiredDomainParseResult {
  const result = getDomainFromRequest(c);
  if (!result.valid) {
    // Invalid domain provided - caller should return 400
    return result;
  }
  // Default to ADMIN_API_DOMAIN from env, or 'example.com' as fallback
  const defaultDomain = c.env.ADMIN_API_DOMAIN || 'example.com';
  return { valid: true, domain: result.domain ?? defaultDomain };
}

/**
 * Get actor info from Tailscale headers
 */
export function getActorInfo(c: { req: { header: (name: string) => string | undefined } }): {
  login: string;
  name: string | null;
} {
  const login = c.req.header('Tailscale-User-Login') || 'api-key';
  const name = c.req.header('Tailscale-User-Name') || null;
  return { login, name };
}

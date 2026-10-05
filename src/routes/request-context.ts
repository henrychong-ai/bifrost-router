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
 * Get target domain from request (for listing routes). The one place both
 * selectors are read, so the route and QR resolvers (list, single-domain read,
 * write) apply the same rules: the X-Domain header or the ?domain query param
 * names the domain, and neither means undefined (all domains). When both are
 * sent they must name the same domain: a disagreement is refused (400), never
 * settled by precedence. The conflict is checked before validation, so an
 * unsupported value in either slot still conflicts.
 * Returns validation result including whether an invalid domain was provided
 */
export function getDomainFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): DomainParseResult {
  const header = c.req.header('X-Domain') || undefined;
  const query = c.req.query('domain') || undefined;
  if (header !== undefined && query !== undefined && header !== query) {
    return {
      valid: false,
      error: `Conflicting domain parameters: X-Domain is ${header} but domain is ${query}`,
    };
  }

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

/** Error a mutation answers when the request names no domain at all. */
export const MISSING_DOMAIN_ERROR =
  'An explicit domain is required (X-Domain header or domain query parameter).';

/**
 * Get target domain from request (required for mutations).
 * Requires the X-Domain header or the ?domain query parameter and never
 * defaults. An omitted domain used to fall back to ADMIN_API_DOMAIN, but the
 * admin host is itself a supported domain (bifrost.example.com in the example
 * config), so a write that forgot its domain landed silently in the admin
 * host's namespace instead of failing. When both selectors are sent they must
 * name the same domain (checked in getDomainFromRequest, for reads too).
 */
export function getRequiredDomainFromRequest(c: {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  };
}): RequiredDomainParseResult {
  // getDomainFromRequest refuses conflicting selectors for reads and writes
  const result = getDomainFromRequest(c);
  if (!result.valid) {
    // Invalid domain provided - caller should return 400
    return result;
  }
  if (result.domain) return { valid: true, domain: result.domain };
  return { valid: false, error: MISSING_DOMAIN_ERROR };
}

/**
 * Get target domain from request for a single-domain READ (a route by path,
 * QR codes): the X-Domain header or the ?domain query param (both sent must
 * agree, or 400), else the ADMIN_API_DOMAIN env var, else example.com. Reads
 * keep this fallback; mutations use getRequiredDomainFromRequest, which has
 * none.
 */
export function getDomainOrDefaultFromRequest(c: {
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
  if (result.domain) return { valid: true, domain: result.domain };
  // Default only to a supported domain. An admin host outside
  // SUPPORTED_DOMAINS (a development admin host, for example) is a request
  // host, not a route-storage domain, and must never bypass the validation
  // applied to explicit input.
  const defaultDomain = c.env.ADMIN_API_DOMAIN || 'example.com';
  if (!isValidDomain(defaultDomain)) {
    return { valid: false, error: `Invalid default domain: ${defaultDomain}` };
  }
  return { valid: true, domain: defaultDomain };
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

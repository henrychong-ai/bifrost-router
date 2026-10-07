/**
 * URL validation utilities for proxy security
 *
 * Prevents SSRF attacks by validating proxy targets
 */

import { isBlockedHost } from './host-policy';

/**
 * Allowed protocols for proxy targets
 */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Check if a hostname may not be proxied to: the shared outbound host policy
 * (src/utils/host-policy.ts, v1.37.2), the same one the link-preview fetcher
 * uses. Covers internal names (`localhost`, `*.localhost`, `*.internal`,
 * `*.local`, metadata names, one trailing dot ignored), every non-public IPv4
 * range, and any IPv6 address outside global unicast (bracketed or not).
 * Hostnames are not resolved.
 */
export function isPrivateIP(hostname: string): boolean {
  return isBlockedHost(hostname);
}

/**
 * The refusal messages (v1.38.0): fixed text that never quotes the target, its
 * scheme or its host. A stored target can carry a credential, and the proxy
 * logs the refusal on every visitor request to the route.
 */
export const PROXY_TARGET_ERRORS = {
  format: 'Invalid URL format',
  protocol: 'Invalid protocol. Only http: and https: are allowed.',
  address: 'Cannot proxy to a private or internal address',
  hostname: 'Invalid hostname. Only letters, digits, hyphens and dots are allowed.',
} as const;

/**
 * A hostname of letters, digits and hyphens in dot-separated labels, with one
 * trailing dot allowed (v1.38.0), as the URL parser leaves it: lower-cased,
 * an international name in its `xn--` form. A name such as `*.example.com`
 * or `under_score.example.com` parses but can never be fetched, and the
 * runtime's error for it names the whole URL. IP literals keep their own
 * rules: an IPv4 address is digits and dots, an IPv6 one is bracketed.
 */
const LDH_HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?$/;

/**
 * Validation result for proxy targets
 */
export interface URLValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
}

/**
 * Validate a URL for use as a proxy target
 *
 * Security checks:
 * - Valid URL format
 * - Allowed protocol (http/https only)
 * - A hostname of letters, digits, hyphens and dots (or an IP literal)
 * - Not a private/internal IP
 * - Not a cloud metadata endpoint
 *
 * @param target - The target URL string to validate
 * @returns Validation result with parsed URL if valid
 */
export function validateProxyTarget(target: string): URLValidationResult {
  // Parse URL
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { valid: false, error: PROXY_TARGET_ERRORS.format };
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return { valid: false, error: PROXY_TARGET_ERRORS.protocol };
  }

  // Letters, digits, hyphens and dots only; a bracketed IPv6 literal is
  // checked by the address rules alone
  if (!url.hostname.startsWith('[') && !LDH_HOSTNAME.test(url.hostname)) {
    return { valid: false, error: PROXY_TARGET_ERRORS.hostname };
  }

  // Check for private/internal IPs
  if (isPrivateIP(url.hostname)) {
    return { valid: false, error: PROXY_TARGET_ERRORS.address };
  }

  return {
    valid: true,
    url,
  };
}

/**
 * Check if a proxy target is valid (simple boolean version)
 *
 * @param target - The target URL string to validate
 * @returns true if target is a valid proxy destination
 */
export function isValidProxyTarget(target: string): boolean {
  return validateProxyTarget(target).valid;
}

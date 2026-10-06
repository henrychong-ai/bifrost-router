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
    return {
      valid: false,
      error: `Invalid URL format: ${target}`,
    };
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      valid: false,
      error: `Invalid protocol: ${url.protocol}. Only http: and https: are allowed.`,
    };
  }

  // Check for private/internal IPs
  if (isPrivateIP(url.hostname)) {
    return {
      valid: false,
      error: `Cannot proxy to private/internal address: ${url.hostname}`,
    };
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

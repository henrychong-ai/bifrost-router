/**
 * URL validation utilities for proxy security
 *
 * Prevents SSRF attacks by validating proxy targets
 */

/**
 * Private IP address ranges (RFC 1918 + loopback + link-local)
 */
const PRIVATE_IP_RANGES = [
  // IPv4 private ranges
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^127\./, // 127.0.0.0/8 (loopback)
  /^169\.254\./, // 169.254.0.0/16 (link-local)
  /^0\./, // 0.0.0.0/8
  // IPv6 private ranges (simplified patterns)
  /^::1$/, // Loopback
  /^fe80:/i, // Link-local
  /^fc00:/i, // Unique local
  /^fd[0-9a-f]{2}:/i, // Unique local
];

/**
 * Known internal hostnames that should be blocked
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  '0.0.0.0',
  '[::]',
  '[::1]',
  // Cloud metadata endpoints (common SSRF targets)
  '169.254.169.254', // AWS, GCP, Azure metadata
  'metadata.google.internal', // GCP metadata
  'metadata.google', // GCP metadata alternative
];

/**
 * Allowed protocols for proxy targets
 */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Check if a hostname represents a private/internal IP address
 */
export function isPrivateIP(hostname: string): boolean {
  // Check against blocked hostnames
  const lowerHost = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(lowerHost)) {
    return true;
  }

  // Check against private IP patterns
  return PRIVATE_IP_RANGES.some(pattern => pattern.test(hostname));
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

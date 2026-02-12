/**
 * Path validation utilities for R2 security
 *
 * Prevents path traversal attacks by sanitizing R2 object keys
 */

/**
 * Dangerous patterns that should be blocked in R2 keys
 * Note: Control characters are intentionally matched for security scanning
 */
/* eslint-disable no-control-regex */
const DANGEROUS_PATTERNS = [
  /\.\./, // Parent directory traversal
  /\x00/, // Null bytes
  /^\/+/, // Leading slashes (normalize to relative)
  /\/\.[^/]+\//, // Hidden directory components (/.something/)
  /[<>:"|?*]/, // Windows illegal characters
  /[\x00-\x1f]/, // Control characters
];
/* eslint-enable no-control-regex */

/**
 * Check if an R2 key contains dangerous path components
 *
 * @param key - The R2 object key to validate
 * @returns true if the key contains dangerous patterns
 */
export function hasDangerousPath(key: string): boolean {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(key));
}

/**
 * Sanitize an R2 object key to prevent path traversal
 *
 * @param key - The raw R2 object key
 * @returns The sanitized key
 */
export function sanitizeR2Key(key: string): string {
  let sanitized = key;

  /* eslint-disable no-control-regex */
  // Remove null bytes
  sanitized = sanitized.replace(/\x00/g, '');

  // Remove control characters
  sanitized = sanitized.replace(/[\x00-\x1f]/g, '');
  /* eslint-enable no-control-regex */

  // Normalize path separators
  sanitized = sanitized.replace(/\\/g, '/');

  // Remove any parent directory traversal attempts
  // Keep replacing until no more .. patterns exist
  while (sanitized.includes('..')) {
    sanitized = sanitized.replace(/\.\./g, '');
  }

  // Remove leading slashes (R2 keys should be relative)
  sanitized = sanitized.replace(/^\/+/, '');

  // Remove multiple consecutive slashes
  sanitized = sanitized.replace(/\/+/g, '/');

  // Remove trailing slashes
  sanitized = sanitized.replace(/\/+$/, '');

  // Remove hidden directory components (/.something/)
  sanitized = sanitized.replace(/\/\.+\//g, '/');

  return sanitized;
}

/**
 * Validation result for R2 keys
 */
export interface R2KeyValidationResult {
  valid: boolean;
  sanitizedKey: string;
  error?: string;
}

/**
 * Validate and sanitize an R2 object key
 *
 * @param key - The R2 object key to validate
 * @returns Validation result with sanitized key
 */
export function validateR2Key(key: string): R2KeyValidationResult {
  // Check for empty key
  if (!key || key.trim() === '') {
    return {
      valid: false,
      sanitizedKey: '',
      error: 'R2 key cannot be empty',
    };
  }

  // Sanitize the key
  const sanitizedKey = sanitizeR2Key(key);

  // Check if sanitization resulted in empty key
  if (!sanitizedKey) {
    return {
      valid: false,
      sanitizedKey: '',
      error: 'R2 key contains only invalid characters',
    };
  }

  // Check if key was modified (indicates potential attack)
  const wasModified = sanitizedKey !== key;
  if (wasModified) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'R2 key was sanitized',
        original: key,
        sanitized: sanitizedKey,
      }),
    );
  }

  return {
    valid: true,
    sanitizedKey,
  };
}

/**
 * Check if an R2 key is valid (simple boolean version)
 *
 * @param key - The R2 object key to validate
 * @returns true if key is safe to use
 */
export function isValidR2Key(key: string): boolean {
  return validateR2Key(key).valid;
}

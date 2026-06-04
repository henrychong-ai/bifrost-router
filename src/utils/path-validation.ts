/**
 * Path validation utilities for R2 security
 *
 * Prevents path traversal attacks by rejecting R2 object keys with dangerous patterns
 */

import { normalizeR2Key } from '@bifrost/shared';

/* eslint-disable no-control-regex */
const DANGEROUS_PATTERNS = [
  /\.\./, // Parent directory traversal
  /\x00/, // Null bytes
  /^\/+/, // Leading slashes (normalize to relative)
  /(?:^|\/)\.(?!\.)[^/]*/, // Hidden components (dot-prefixed segments, excluding ..)
  /[<>:"|?*]/, // Windows illegal characters
  /[\x00-\x1f]/, // Control characters
];
/* eslint-enable no-control-regex */

export function hasDangerousPath(key: string): boolean {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(key));
}

export function sanitizeR2Key(key: string): string {
  let sanitized = key;
  /* eslint-disable no-control-regex */
  sanitized = sanitized.replace(/\x00/g, '');
  sanitized = sanitized.replace(/[\x00-\x1f]/g, '');
  /* eslint-enable no-control-regex */
  sanitized = sanitized.replace(/[<>:"|?*]/g, '');
  sanitized = sanitized.replace(/\\/g, '/');
  while (sanitized.includes('..')) {
    sanitized = sanitized.replace(/\.\./g, '');
  }
  sanitized = sanitized.replace(/^\/+/, '');
  sanitized = sanitized.replace(/\/+/g, '/');
  sanitized = sanitized.replace(/\/+$/, '');
  sanitized = sanitized.replace(/(?:^|\/)\.(?!\.)[^/]*/g, '');
  sanitized = sanitized.replace(/^\/+/, '');
  sanitized = sanitized.replace(/\/+/g, '/');
  sanitized = sanitized.replace(/\/+$/, '');
  return sanitized;
}

export interface R2KeyValidationResult {
  valid: boolean;
  sanitizedKey: string;
  error?: string;
}

export function validateR2Key(key: string, opts?: { normalize?: boolean }): R2KeyValidationResult {
  if (!key || key.trim() === '') {
    return { valid: false, sanitizedKey: '', error: 'R2 key cannot be empty' };
  }
  const sanitizedKey = sanitizeR2Key(key);
  if (!sanitizedKey) {
    return { valid: false, sanitizedKey: '', error: 'R2 key contains only invalid characters' };
  }
  if (sanitizedKey !== key) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'R2 key rejected — contains invalid characters or path components',
        original: key,
        sanitized: sanitizedKey,
      }),
    );
    return {
      valid: false,
      sanitizedKey: '',
      error: 'R2 key contains invalid characters or path components',
    };
  }

  // Optional key normalization (v1.27.0) — lowercase + kebab-case. Applied only
  // when the caller opts in (write-time NEW-key sites under R2_KEY_NORMALIZE),
  // NEVER for references to existing objects. This is an ACCEPTED transform (the
  // dangerous-pattern REJECT above is the security gate; case/space are not
  // confused-deputy vectors). The returned sanitizedKey is the canonical key.
  if (opts?.normalize) {
    const normalized = normalizeR2Key(sanitizedKey);
    if (!normalized) {
      return {
        valid: false,
        sanitizedKey: '',
        error: 'R2 key is empty after normalization',
      };
    }
    return { valid: true, sanitizedKey: normalized };
  }

  return { valid: true, sanitizedKey };
}

export function isValidR2Key(key: string): boolean {
  return validateR2Key(key).valid;
}

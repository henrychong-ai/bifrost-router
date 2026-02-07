/**
 * Timing-safe string comparison utility
 *
 * Prevents timing attacks by ensuring constant-time comparison
 * regardless of where strings differ.
 */

/**
 * Compare two strings in constant time to prevent timing attacks.
 *
 * This function compares all characters even after finding a mismatch,
 * preventing attackers from inferring the correct value by measuring
 * response times.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // Convert to Uint8Array for byte-level comparison
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Length comparison must be constant-time too
  // XOR lengths to avoid early return on length mismatch timing leak
  let result = aBytes.length ^ bBytes.length;

  // Compare all bytes, using the shorter length
  // to avoid out-of-bounds, but always iterate the max length
  const maxLen = Math.max(aBytes.length, bBytes.length);

  for (let i = 0; i < maxLen; i++) {
    // If index is out of bounds, use 0 (will contribute to result)
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    result |= aByte ^ bByte;
  }

  return result === 0;
}

/**
 * Validate an API key using timing-safe comparison
 *
 * @param providedKey - The key provided by the client
 * @param expectedKey - The expected API key
 * @returns true if keys match, false otherwise
 */
export function validateApiKey(
  providedKey: string | undefined | null,
  expectedKey: string | undefined | null
): boolean {
  // Both must be non-empty strings
  if (!providedKey || !expectedKey) {
    return false;
  }

  return timingSafeEqual(providedKey, expectedKey);
}

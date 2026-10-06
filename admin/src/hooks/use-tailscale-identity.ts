import { useQuery } from '@tanstack/react-query';
import {
  parseTailscaleIdentity,
  SIGNED_OUT_IDENTITY,
  type TailscaleIdentity,
} from '@/lib/stored-json';

// =============================================================================
// Types
// =============================================================================

export type { TailscaleIdentity } from '@/lib/stored-json';

// =============================================================================
// Query Keys
// =============================================================================

export const tailscaleKeys = {
  identity: ['tailscale', 'identity'] as const,
};

// =============================================================================
// API
// =============================================================================

async function fetchTailscaleIdentity(): Promise<TailscaleIdentity> {
  const response = await fetch('/api/tailscale/identity');
  // Return unauthenticated state on error, or on an answer that is not an
  // identity (read as unknown and validated, v1.38.0)
  if (!response.ok) return SIGNED_OUT_IDENTITY;
  const body: unknown = await response.json().catch(() => null);
  return parseTailscaleIdentity(body);
}

/**
 * Decode RFC2047 "Q" encoded strings that Tailscale may use for non-ASCII names.
 * Example: =?utf-8?q?Ferris_B=C3=BCller?= → Ferris Büller
 */
function decodeRFC2047(value: string | null): string | null {
  if (!value) return null;

  // Check if it's RFC2047 encoded
  const match = value.match(/^=\?([^?]+)\?([QBqb])\?([^?]+)\?=$/);
  if (!match) return value;

  // All three groups are mandatory in the pattern above, so a match carries them.
  const [charset, encoding, encoded] = [match[1]!, match[2]!, match[3]!];

  if (encoding.toUpperCase() === 'Q') {
    // Q-encoding: underscores are spaces, =XX is hex
    const decoded = encoded
      .replace(/_/g, ' ')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

    // If charset is utf-8, decode as UTF-8
    if (charset.toLowerCase() === 'utf-8') {
      try {
        return decodeURIComponent(escape(decoded));
      } catch {
        return decoded;
      }
    }
    return decoded;
  }

  // B-encoding (Base64) - less common
  if (encoding.toUpperCase() === 'B') {
    try {
      return atob(encoded);
    } catch {
      return value;
    }
  }

  return value;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Fetch Tailscale identity from the server.
 * When served via Tailscale Serve, the proxy injects identity headers
 * which are exposed via /api/tailscale/identity endpoint.
 *
 * @returns TailscaleIdentity with decoded name (handles RFC2047 encoding)
 */
export function useTailscaleIdentity() {
  const query = useQuery({
    queryKey: tailscaleKeys.identity,
    queryFn: fetchTailscaleIdentity,
    // Cache for 5 minutes - identity doesn't change often
    staleTime: 5 * 60 * 1000,
    // Retry once on failure
    retry: 1,
    // Don't refetch on window focus
    refetchOnWindowFocus: false,
  });

  // Decode the name if present (handles RFC2047 encoding)
  const decodedData: TailscaleIdentity | undefined = query.data
    ? {
        ...query.data,
        name: decodeRFC2047(query.data.name),
      }
    : undefined;

  return {
    ...query,
    data: decodedData,
  };
}

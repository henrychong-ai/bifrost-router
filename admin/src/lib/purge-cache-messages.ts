import type { PurgeCacheResult } from './api-client';

/** One toast the storage page shows for a manual cache purge. */
export interface PurgeCacheMessage {
  kind: 'success' | 'info' | 'warning';
  text: string;
}

/** What a failed route discovery leaves behind (v1.38.0). */
export const ROUTE_DISCOVERY_INCOMPLETE_MESSAGE =
  'Route lookup failed: links serving this file may still show the old version until their cache expires. Retry the purge.';

/**
 * The toasts for a manual cache purge's answer: the purge counts, and, when
 * the Worker could not list the routes serving the object (v1.38.0), a
 * warning that the purge was incomplete, so a partial purge never reads as a
 * full one.
 */
const entries = (count: number) => `${count} cache ${count === 1 ? 'entry' : 'entries'}`;

export function purgeCacheMessages(result: PurgeCacheResult): PurgeCacheMessage[] {
  const messages: PurgeCacheMessage[] = [];
  if (result.purged === 0 && result.failed === 0) {
    messages.push(
      result.urls.length > 0
        ? {
            kind: 'warning',
            text: `Found ${result.urls.length} cache ${result.urls.length === 1 ? 'URL' : 'URLs'} but purge not configured — set CLOUDFLARE_API_TOKEN Worker secret`,
          }
        : { kind: 'info', text: 'No cache entries to purge' },
    );
  } else if (result.failed > 0) {
    messages.push({
      kind: 'warning',
      text: `Purged ${result.purged}, failed ${entries(result.failed)}`,
    });
  } else {
    messages.push({ kind: 'success', text: `Purged ${entries(result.purged)}` });
  }
  if (!result.routeDiscoveryComplete) {
    messages.push({ kind: 'warning', text: ROUTE_DISCOVERY_INCOMPLETE_MESSAGE });
  }
  return messages;
}

import { getZoneIdForDomain, getR2CustomDomainUrls } from '../types';
import { findRoutesByR2Target } from '../kv/routes';

/**
 * Result of a cache purge operation.
 */
export interface PurgeCacheResult {
  /** Number of cache entries successfully purged */
  purged: number;
  /** Number of cache entries that failed to purge */
  failed: number;
  /** URLs that were targeted for purging */
  urls: string[];
}

/**
 * Purge Cloudflare CDN cache globally for all URLs serving a specific R2 object.
 *
 * Uses the Zone Cache Purge API (POST /zones/{zone_id}/purge_cache) which purges
 * all edge PoPs worldwide — unlike Workers Cache API cache.delete() which only
 * purges the single PoP where the Worker runs.
 *
 * Collects URLs from two sources:
 * 1. Bifrost KV routes pointing to this R2 object (e.g., https://example.com/report)
 * 2. R2 custom domain URLs for the bucket (e.g., https://files.example.com/report.pdf)
 *
 * Groups URLs by zone ID and batches in groups of 30 (CF API limit).
 * Gracefully degrades: returns URLs but purged=0 if no API token.
 */
export async function purgeR2CacheForObject(
  kv: KVNamespace,
  bucket: string,
  key: string,
  cfApiToken?: string,
): Promise<PurgeCacheResult> {
  // Step 1: Collect all URLs that need purging
  const urlsWithZones: { url: string; zoneId: string }[] = [];
  const skippedUrls: string[] = [];

  // 1a. Bifrost KV route URLs (route paths are already URL-safe slugs)
  const routes = await findRoutesByR2Target(kv, bucket, key);
  for (const route of routes) {
    const url = `https://${route.domain}${route.path}`;
    const zoneId = getZoneIdForDomain(route.domain);
    if (zoneId) {
      urlsWithZones.push({ url, zoneId });
    } else {
      skippedUrls.push(url);
    }
  }

  // 1b. R2 custom domain URLs (key is encoded as URL path)
  const customDomainUrls = getR2CustomDomainUrls(bucket, key);
  urlsWithZones.push(...customDomainUrls);

  if (skippedUrls.length > 0) {
    console.log(
      JSON.stringify({
        level: 'warn',
        message: 'Skipped cache purge for domains without zone ID',
        urls: skippedUrls,
      }),
    );
  }

  const allUrls = [...urlsWithZones.map(u => u.url), ...skippedUrls];

  // Step 2: Purge via Zone Cache Purge API
  if (!cfApiToken || urlsWithZones.length === 0) {
    return { purged: 0, failed: 0, urls: allUrls };
  }

  const { purged, failed } = await purgeZoneCache(cfApiToken, urlsWithZones);
  return { purged, failed, urls: allUrls };
}

/**
 * Call Cloudflare Zone Cache Purge API for a batch of URLs.
 * Groups by zone ID and batches in groups of 30 (CF API limit per call).
 * Zones are purged in parallel; batches within a zone are sequential.
 * Returns counts of successfully purged and failed URLs.
 */
async function purgeZoneCache(
  cfApiToken: string,
  urlsWithZones: { url: string; zoneId: string }[],
): Promise<{ purged: number; failed: number }> {
  const byZone = new Map<string, string[]>();
  for (const { url, zoneId } of urlsWithZones) {
    const existing = byZone.get(zoneId) ?? [];
    existing.push(url);
    byZone.set(zoneId, existing);
  }

  const results = await Promise.all(
    [...byZone.entries()].map(([zoneId, urls]) => purgeZone(cfApiToken, zoneId, urls)),
  );

  return results.reduce(
    (acc, r) => ({ purged: acc.purged + r.purged, failed: acc.failed + r.failed }),
    { purged: 0, failed: 0 },
  );
}

/** Purge all URLs for a single zone, batched in groups of 30. */
async function purgeZone(
  cfApiToken: string,
  zoneId: string,
  urls: string[],
): Promise<{ purged: number; failed: number }> {
  let purged = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i += 30) {
    const batch = urls.slice(i, i + 30);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: batch }),
      },
    );

    if (response.ok) {
      // CF API can return 200 with success: false in the body
      try {
        const body = (await response.json()) as { success?: boolean };
        if (body.success === true) {
          purged += batch.length;
        } else {
          failed += batch.length;
          console.error(
            JSON.stringify({
              level: 'error',
              message: 'Zone cache purge returned success: false',
              zoneId,
              urls: batch,
            }),
          );
        }
      } catch {
        // Failed to parse response body — treat as failure
        failed += batch.length;
        console.error(
          JSON.stringify({
            level: 'error',
            message: 'Zone cache purge returned unparseable response',
            zoneId,
            urls: batch,
          }),
        );
      }
    } else {
      failed += batch.length;
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'Zone cache purge failed',
          zoneId,
          status: response.status,
          urls: batch,
        }),
      );
    }
  }
  return { purged, failed };
}

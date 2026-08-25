import { CLOUDFLARE_ZONE_IDS, getZoneIdForDomain, getR2CustomDomainUrls } from '../types';
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
 * 1. Bifrost KV routes pointing to this R2 object (e.g., https://links.example.com/report)
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

  // 1a. Bifrost KV route URLs.
  //
  // Two paths are unusable and must never enter the batch. A WILDCARD path
  // purges nothing — Cloudflare's purge-by-URL does not expand `*`, and
  // purge-by-prefix is an Enterprise feature. A path with a raw space (or any
  // character the request URL percent-encodes) is rejected by the API, and the
  // rejection fails the WHOLE 30-URL batch — taking the correctly-encoded
  // custom-domain URLs down with it. So: encode every segment, and drop
  // wildcard routes with a warning rather than poisoning the batch.
  const routes = await findRoutesByR2Target(kv, bucket, key);
  for (const route of routes) {
    if (route.path.includes('*')) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          message: 'purge not possible for wildcard route — cached sub-paths expire via TTL',
          domain: route.domain,
          path: route.path,
        }),
      );
      continue;
    }
    const url = `https://${route.domain}${encodePathSegments(route.path)}`;
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
    console.warn(
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
 * Purge the edge cache for one route's own URL (r2 routes only).
 *
 * `purgeR2CacheForObject` purges by OBJECT — it finds every route pointing at a
 * key. This is the complement: the object is unchanged but the route→object
 * mapping is, so the route's own URL is the thing holding a stale body.
 *
 * ZONE purge only, deliberately: `caches.default.delete()` evicts a single colo
 * and would read as a global purge while leaving every other PoP stale. The
 * Workers cache entry is keyed on the URL, so a zone purge of that URL evicts
 * it too. Gracefully degrades to purged=0 with no token or no zone mapping,
 * mirroring `purgeR2CacheForObject`.
 */
export async function purgeRouteUrl(
  domain: string,
  path: string,
  cfApiToken?: string,
): Promise<PurgeCacheResult> {
  // Percent-encode each segment, the same way `getR2CustomDomainUrls` encodes
  // object keys. `normalizePath()` DECODES the path, but the cache entry lives
  // under the request URL, which is encoded — purging `/my report` would miss
  // `/my%20report` — and Cloudflare rejects a purge list containing a URL with
  // raw spaces or control characters, failing the whole batch.
  const url = `https://${domain}${encodePathSegments(path)}`;
  const zoneId = getZoneIdForDomain(domain);

  // Only worth warning about when SOME zones are configured and this one is
  // missing — that is a genuine gap. With the shipped empty configuration every
  // purge would otherwise warn on every mutation forever, which trains an
  // operator to ignore the line that matters.
  if (!zoneId && Object.keys(CLOUDFLARE_ZONE_IDS).length > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'Skipped route cache purge for domain without zone ID',
        url,
      }),
    );
  }

  if (!cfApiToken || !zoneId) {
    return { purged: 0, failed: 0, urls: [url] };
  }

  const { purged, failed } = await purgeZoneCache(cfApiToken, [{ url, zoneId }]);
  return { purged, failed, urls: [url] };
}

/**
 * Encode a route path for use in a purge URL: each `/`-separated segment is
 * percent-encoded, the separators are preserved. Mirrors `encodeR2KeyAsPath`
 * in src/types.ts, which does the same job for R2 object keys.
 */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
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

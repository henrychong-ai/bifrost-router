import { afterAll, beforeAll } from 'vitest';
import { CLOUDFLARE_ZONE_IDS, R2_BUCKET_CUSTOM_DOMAINS } from '../src/types';

/**
 * The operator configuration the link-preview tests (v1.48.0) run under. The
 * template ships `R2_BUCKET_CUSTOM_DOMAINS` and `CLOUDFLARE_ZONE_IDS` empty,
 * so no bucket may hold a preview image; a test file that needs one calls
 * {@link usePreviewBuckets}, which sets both maps for the file (the Worker
 * reads the same objects, re-exported from `@bifrost/shared`) and restores
 * them afterwards. `files` and `assets` are the two buckets the test pool
 * binds; `files-user1` has no binding and no custom domain.
 */
export const PREVIEW_CUSTOM_DOMAINS: Readonly<Record<string, string[]>> = {
  files: ['files.example.com'],
  assets: ['assets.example.com', 'assets.example.net'],
};

/** Placeholder zone ids (not Cloudflare ids): one per test zone. */
export const PREVIEW_ZONE_IDS: Readonly<Record<string, string>> = {
  'example.com': 'zone-one',
  'example.net': 'zone-two',
};

/** Set the two maps for one test file, and restore them after it. */
export function usePreviewBuckets(): void {
  let domains: Record<string, string[]> = {};
  let zones: Record<string, string> = {};
  beforeAll(() => {
    domains = { ...R2_BUCKET_CUSTOM_DOMAINS };
    zones = { ...CLOUDFLARE_ZONE_IDS };
    Object.assign(R2_BUCKET_CUSTOM_DOMAINS, structuredClone(PREVIEW_CUSTOM_DOMAINS));
    Object.assign(CLOUDFLARE_ZONE_IDS, PREVIEW_ZONE_IDS);
  });
  afterAll(() => {
    for (const key of Object.keys(R2_BUCKET_CUSTOM_DOMAINS)) delete R2_BUCKET_CUSTOM_DOMAINS[key];
    for (const key of Object.keys(CLOUDFLARE_ZONE_IDS)) delete CLOUDFLARE_ZONE_IDS[key];
    Object.assign(R2_BUCKET_CUSTOM_DOMAINS, domains);
    Object.assign(CLOUDFLARE_ZONE_IDS, zones);
  });
}

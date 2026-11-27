import { R2_BUCKET_CUSTOM_DOMAINS } from '@bifrost/shared';
import { afterAll, beforeAll } from 'vitest';

/**
 * The operator configuration the dashboard's link-preview tests (v1.48.0)
 * run under. The template ships `R2_BUCKET_CUSTOM_DOMAINS` empty, so no
 * bucket may hold a preview image; a test file that needs one calls
 * {@link usePreviewBuckets}, which sets the map for the file (the shared
 * functions read the same object) and restores it afterwards.
 */
export const PREVIEW_CUSTOM_DOMAINS: Readonly<Record<string, string[]>> = {
  assets: ['assets.example.com'],
  files: ['files.example.com'],
};

/** Set the custom-domain map for one test file, and restore it after it. */
export function usePreviewBuckets(): void {
  let saved: Record<string, string[]> = {};
  beforeAll(() => {
    saved = structuredClone(R2_BUCKET_CUSTOM_DOMAINS);
    Object.assign(R2_BUCKET_CUSTOM_DOMAINS, structuredClone(PREVIEW_CUSTOM_DOMAINS));
  });
  afterAll(() => {
    for (const key of Object.keys(R2_BUCKET_CUSTOM_DOMAINS)) delete R2_BUCKET_CUSTOM_DOMAINS[key];
    Object.assign(R2_BUCKET_CUSTOM_DOMAINS, saved);
  });
}

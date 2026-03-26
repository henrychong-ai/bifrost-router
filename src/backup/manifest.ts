import type { BackupManifest, KVBackupResult } from './types';

/**
 * Manifest schema version
 * 2.0.0 — Removed D1 backup (covered by Cloudflare D1 Time Travel)
 */
const MANIFEST_VERSION = '2.0.0';

/**
 * Write backup manifest to R2
 *
 * Creates a JSON manifest file describing the backup contents,
 * enabling easy discovery and restoration.
 *
 * @param bucket - R2 bucket for backup storage
 * @param date - Backup date in YYYYMMDD format
 * @param kvResult - Result from KV backup operation
 * @returns The written manifest
 */
export async function writeManifest(
  bucket: R2Bucket,
  date: string,
  kvResult: KVBackupResult,
): Promise<BackupManifest> {
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    timestamp: Date.now(),
    date,
    kv: kvResult,
  };

  const filename = `daily/${date}/manifest.json`;
  await bucket.put(filename, JSON.stringify(manifest, null, 2), {
    customMetadata: {
      date,
      type: 'manifest',
    },
  });

  return manifest;
}

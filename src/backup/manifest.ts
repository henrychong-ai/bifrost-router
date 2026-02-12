import type { BackupManifest, KVBackupResult, D1BackupResult } from './types';

/**
 * Manifest schema version
 * Increment when manifest structure changes
 */
const MANIFEST_VERSION = '1.0.0';

/**
 * Default retention policy
 */
const DEFAULT_RETENTION = {
  daily: 30, // Keep daily backups for 30 days
  weekly: 90, // Keep Sunday backups for 90 days
};

/**
 * Write backup manifest to R2
 *
 * Creates a JSON manifest file describing the backup contents,
 * enabling easy discovery and restoration.
 *
 * @param bucket - R2 bucket for backup storage
 * @param date - Backup date in YYYYMMDD format
 * @param kvResult - Result from KV backup operation
 * @param d1Result - Result from D1 backup operation
 * @returns The written manifest
 */
export async function writeManifest(
  bucket: R2Bucket,
  date: string,
  kvResult: KVBackupResult,
  d1Result: D1BackupResult,
): Promise<BackupManifest> {
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    timestamp: Date.now(),
    date,
    kv: kvResult,
    d1: d1Result,
    retention: DEFAULT_RETENTION,
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

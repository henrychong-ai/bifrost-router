import { BACKUP_MANIFEST_VERSION, backupManifestKey } from './constants';
import type { BackupManifest, KVBackupResult } from './types';

/** The manifest certifying a verified KV archive for `date`. */
function buildManifest(date: string, kvResult: KVBackupResult): BackupManifest {
  return {
    version: BACKUP_MANIFEST_VERSION,
    timestamp: Date.now(),
    date,
    kv: kvResult,
  };
}

/**
 * Write backup manifest to R2
 *
 * Creates a JSON manifest file describing the backup contents,
 * enabling easy discovery and restoration. Written only after the archive it
 * names has been verified and stored (see backupKV).
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
  const manifest = buildManifest(date, kvResult);

  await bucket.put(backupManifestKey(date), JSON.stringify(manifest, null, 2), {
    customMetadata: {
      date,
      type: 'manifest',
    },
  });

  return manifest;
}

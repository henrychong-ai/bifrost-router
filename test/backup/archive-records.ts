/**
 * Test helper: read a manifest's archive back as records (a restore). It runs
 * the production verification first, so a restore here only ever reads an
 * archive the health check would accept; values are returned as stored.
 */

import { verifyBackupArchive } from '../../src/backup/integrity';
import type { BackupManifest } from '../../src/backup/types';

export interface BackupRecord {
  key: string;
  value: unknown;
}

export async function readBackupRecords(
  bucket: R2Bucket,
  manifest: BackupManifest,
  maxBytes?: number,
): Promise<BackupRecord[]> {
  await verifyBackupArchive(bucket, manifest.kv.file, manifest.kv.totalRoutes, maxBytes);
  const object = await bucket.get(manifest.kv.file);
  if (!object) throw new Error('Backup archive missing');
  const text = await new Response(
    (object.body as ReadableStream<Uint8Array>).pipeThrough(new DecompressionStream('gzip')),
  ).text();
  return text
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as BackupRecord);
}

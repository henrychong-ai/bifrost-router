// R2Bucket is an ambient global from the generated runtime types
// (worker-configuration.d.ts, produced by `wrangler types` against
// compatibility_date) — no import needed since the migration off
// @cloudflare/workers-types.

import {
  BACKUP_DAILY_PREFIX,
  BACKUP_LISTING_CURSOR_INVALID,
  backupArchiveKey,
  backupManifestKey,
} from './constants';
import type {
  ArchiveInfo,
  BackupAgeStatus,
  BackupFileStatus,
  BackupHealthResponse,
  HealthCheckConfig,
  HealthIssue,
  HealthStatus,
  ManifestSummary,
} from './health-schemas';
import { DEFAULT_HEALTH_CONFIG } from './health-schemas';
import {
  BACKUP_ERRORS,
  BackupIntegrityError,
  MAX_BACKUP_BYTES,
  parseBackupManifest,
  verifyBackupArchive,
} from './integrity';
import type { BackupManifest } from './types';

/** The objects a complete backup for `date` consists of. */
const expectedFiles = (date: string): string[] => [backupManifestKey(date), backupArchiveKey(date)];

/** Bytes as MiB with one decimal, for health messages. */
const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** Error findLatestBackup throws on a broken listing; reported, never thrown. */
const LISTING_CURSOR_INVALID = BACKUP_LISTING_CURSOR_INVALID;

/**
 * Find the most recent backup in the R2 bucket
 */
async function findLatestBackup(
  bucket: R2Bucket,
): Promise<{ date: string; timestamp: string } | null> {
  // List every page of daily-backup directories: backups are kept
  // indefinitely, so the archive outgrows one R2 list page and the newest date
  // can sit on a later one. A repeated or missing cursor on a truncated page
  // is an error, never a silent stop on a partial listing.
  const prefixes: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: BACKUP_DAILY_PREFIX,
      delimiter: '/',
      ...(cursor !== undefined && { cursor }),
    });
    // A page without delimited prefixes (no directories on it) adds none
    prefixes.push(...(page.delimitedPrefixes ?? []));
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && (!cursor || seenCursors.has(cursor))) {
      throw new Error(LISTING_CURSOR_INVALID);
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  // Extract dates and sort descending to get most recent
  const dates = prefixes
    .map(p => p.replace(BACKUP_DAILY_PREFIX, '').replace('/', ''))
    .filter(d => /^\d{8}$/.test(d))
    .toSorted((a, b) => b.localeCompare(a));

  if (dates.length === 0) return null;

  const latestDate = dates[0];

  // Reconstruct timestamp from date (backup runs at 20:00 UTC)
  const year = latestDate.slice(0, 4);
  const month = latestDate.slice(4, 6);
  const day = latestDate.slice(6, 8);
  const timestamp = `${year}-${month}-${day}T20:00:00Z`;

  return { date: latestDate, timestamp };
}

/**
 * Fetch and parse the backup manifest
 */
async function fetchManifest(bucket: R2Bucket, date: string): Promise<BackupManifest | null> {
  try {
    const obj = await bucket.get(backupManifestKey(date));
    if (!obj) return null;
    return parseBackupManifest(await obj.json(), date);
  } catch {
    return null;
  }
}

/**
 * Convert BackupManifest to ManifestSummary for API response
 */
function manifestToSummary(manifest: BackupManifest): ManifestSummary {
  return {
    version: manifest.version,
    kv: {
      totalRoutes: manifest.kv.totalRoutes,
      domains: manifest.kv.domains,
    },
  };
}

/**
 * Check existence and size of all expected backup files
 */
async function checkBackupFiles(bucket: R2Bucket, date: string): Promise<BackupFileStatus[]> {
  const results = await Promise.all(
    expectedFiles(date).map(async key => {
      const obj = await bucket.head(key);
      return {
        key,
        size: obj?.size ?? 0,
        exists: obj !== null,
      };
    }),
  );

  return results;
}

/**
 * Check backup health status
 *
 * Examines the most recent backup in R2 and returns a comprehensive
 * health report including age, file completeness, and manifest validity.
 *
 * @param bucket - R2 bucket containing backups
 * @param config - Optional configuration overrides
 * @returns Health status response
 */
export async function checkBackupHealth(
  bucket: R2Bucket,
  config: Partial<HealthCheckConfig> = {},
): Promise<BackupHealthResponse> {
  const cfg = { ...DEFAULT_HEALTH_CONFIG, ...config };
  const now = new Date();
  const issues: HealthIssue[] = [];

  // Find latest backup. A broken listing is reported as critical, never
  // thrown, so the endpoint keeps answering 200 with a body that says why.
  let latestBackup: Awaited<ReturnType<typeof findLatestBackup>>;
  try {
    latestBackup = await findLatestBackup(bucket);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== LISTING_CURSOR_INVALID) throw error;
    return {
      status: 'critical',
      timestamp: now.toISOString(),
      lastBackup: null,
      issues: [{ severity: 'critical', message: LISTING_CURSOR_INVALID }],
      checks: {
        backupExists: false,
        backupAge: 'critical',
        manifestValid: false,
        filesComplete: false,
        routeCountOk: false,
      },
    };
  }

  // No backup found - critical
  if (!latestBackup) {
    return {
      status: 'critical',
      timestamp: now.toISOString(),
      lastBackup: null,
      issues: [{ severity: 'critical', message: 'No backup found in R2 bucket' }],
      checks: {
        backupExists: false,
        backupAge: 'critical',
        manifestValid: false,
        filesComplete: false,
        routeCountOk: false,
      },
    };
  }

  // Fetch and validate manifest
  const manifest = await fetchManifest(bucket, latestBackup.date);
  const manifestValid = manifest !== null;

  if (!manifestValid) {
    issues.push({
      severity: 'critical',
      message: 'Backup manifest is missing or invalid',
    });
  }

  // Check backup age
  const backupTime = new Date(latestBackup.timestamp);
  const ageHours = (now.getTime() - backupTime.getTime()) / (1000 * 60 * 60);

  let backupAgeStatus: BackupAgeStatus = 'ok';
  if (ageHours > cfg.criticalAgeHours) {
    backupAgeStatus = 'critical';
    issues.push({
      severity: 'critical',
      message: `Backup is ${ageHours.toFixed(1)} hours old (threshold: ${cfg.criticalAgeHours}h)`,
    });
  } else if (ageHours > cfg.warningAgeHours) {
    backupAgeStatus = 'warning';
    issues.push({
      severity: 'warning',
      message: `Backup is ${ageHours.toFixed(1)} hours old (threshold: ${cfg.warningAgeHours}h)`,
    });
  }

  // Check file completeness
  const files = await checkBackupFiles(bucket, latestBackup.date);
  // An empty object is as unusable as a missing one.
  const filesComplete = files.every(f => f.exists && f.size > 0);

  if (!filesComplete) {
    const missing = files.filter(f => !f.exists || f.size === 0).map(f => f.key);
    issues.push({
      severity: 'critical',
      message: `Missing backup files: ${missing.join(', ')}`,
    });
  }

  // Read the archive back, counting only (no record array): every object can
  // exist and still be unrestorable (truncated, corrupt, or holding a different
  // record count). It is checked against its own routeCount metadata (the
  // manifest's count only for a legacy archive without it).
  let archive: ArchiveInfo | null = null;
  if (manifest && filesComplete) {
    try {
      const scan = await verifyBackupArchive(bucket, manifest.kv.file, manifest.kv.totalRoutes);
      archive = { records: scan.records, inflatedBytes: scan.inflatedBytes };
      // A manifest write that failed after the archive was replaced, or two
      // overlapping runs: the archive is sound, its manifest is stale.
      if (scan.countSource === 'archive' && scan.records !== manifest.kv.totalRoutes) {
        issues.push({
          severity: 'warning',
          message: 'Backup manifest is out of date with its archive',
        });
      }
    } catch (error) {
      // Every failure is critical. A fixed integrity message (size limit,
      // count, duplicate key, missing archive) is reported as is; anything
      // else, an R2 read error included, as the generic content failure.
      issues.push({
        severity: 'critical',
        message: error instanceof BackupIntegrityError ? error.message : BACKUP_ERRORS.content,
      });
    }
  }
  if (archive && archive.inflatedBytes > MAX_BACKUP_BYTES / 2) {
    issues.push({
      severity: 'warning',
      message: `Backup archive is ${mib(archive.inflatedBytes)} MiB inflated, over half the ${mib(MAX_BACKUP_BYTES)} MiB verification cap`,
    });
  }

  // Check route count: the archive's verified count, else the manifest's
  let routeCountOk = true;
  const routeCount = archive?.records ?? manifest?.kv.totalRoutes;
  if (routeCount !== undefined && routeCount < cfg.minExpectedRoutes) {
    routeCountOk = false;
    issues.push({
      severity: 'warning',
      message: `Route count (${routeCount}) below minimum expected (${cfg.minExpectedRoutes})`,
    });
  }

  // Determine overall status
  const hasCritical = issues.some(i => i.severity === 'critical');
  const hasWarning = issues.some(i => i.severity === 'warning');
  const status: HealthStatus = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

  return {
    status,
    timestamp: now.toISOString(),
    lastBackup: {
      date: latestBackup.date,
      timestamp: backupTime.toISOString(),
      ageHours,
      manifest: manifest ? manifestToSummary(manifest) : null,
      files,
      archive,
    },
    issues,
    checks: {
      backupExists: true,
      backupAge: backupAgeStatus,
      manifestValid,
      filesComplete,
      routeCountOk,
    },
  };
}

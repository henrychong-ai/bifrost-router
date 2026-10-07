// R2Bucket is an ambient global from the generated runtime types
// (worker-configuration.d.ts, produced by `wrangler types` against
// compatibility_date) — no import needed since the migration off
// @cloudflare/workers-types.

import { errorName } from '../utils/error-name';
import { BACKUP_DAILY_PREFIX, backupArchiveKey, backupManifestKey } from './constants';
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
  BackupIntegrityError,
  BackupListingError,
  BackupReadError,
  MAX_BACKUP_BYTES,
  parseBackupManifest,
  verifyBackupArchive,
} from './integrity';
import type { BackupManifest } from './types';

/** The objects a complete backup for `date` consists of. */
const expectedFiles = (date: string): string[] => [backupManifestKey(date), backupArchiveKey(date)];

/** Bytes as MiB with one decimal, for health messages. */
const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Fixed messages for the R2 failures health reports instead of throwing
 * (v1.37.1), so `GET /api/backups/health` answers 200 whatever R2 does. The
 * R2 error itself is logged, never put in the response.
 */
export const HEALTH_R2_ERRORS = {
  /** Listing the daily backups failed (other than a broken cursor). */
  listing: 'Backup listing failed',
  /** Checking the expected backup objects (R2 head) failed. */
  files: 'Backup files could not be checked',
  /** Fetching or reading the manifest failed (not: missing or invalid). */
  manifest: 'Backup manifest could not be read',
} as const;

/**
 * An R2 call health made failed. It carries the fixed message to report and
 * the R2 error as its cause, for the log only. Only R2 calls are wrapped, so
 * a programming error is never reported as an R2 outage: it still throws.
 */
class HealthR2Error extends Error {
  constructor(message: (typeof HEALTH_R2_ERRORS)[keyof typeof HEALTH_R2_ERRORS], cause: unknown) {
    super(message, { cause });
    this.name = 'HealthR2Error';
  }
}

/** Run one R2 call, turning its failure into a {@link HealthR2Error}. */
async function r2Call<T>(
  message: (typeof HEALTH_R2_ERRORS)[keyof typeof HEALTH_R2_ERRORS],
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw new HealthR2Error(message, error);
  }
}

/**
 * Log an R2 failure's cause by its class only (v1.39.0; never its message,
 * which can quote a key or a stored value) and return its fixed message.
 */
function reportR2Failure(error: HealthR2Error | BackupReadError, what: string): string {
  console.error(`[Backup] Health ${what} failed: ${errorName(error.cause)}`);
  return error.message;
}

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
    const page = await r2Call(HEALTH_R2_ERRORS.listing, () =>
      bucket.list({
        prefix: BACKUP_DAILY_PREFIX,
        delimiter: '/',
        ...(cursor !== undefined && { cursor }),
      }),
    );
    // A page without delimited prefixes (no directories on it) adds none
    prefixes.push(...(page.delimitedPrefixes ?? []));
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && (!cursor || seenCursors.has(cursor))) {
      throw new BackupListingError();
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
 * Fetch and parse the backup manifest: null when it is missing, not JSON or
 * not a valid manifest for `date`. An R2 failure fetching or reading it is a
 * different fault and throws a {@link HealthR2Error} (v1.37.1).
 */
async function fetchManifest(bucket: R2Bucket, date: string): Promise<BackupManifest | null> {
  const obj = await r2Call(HEALTH_R2_ERRORS.manifest, () => bucket.get(backupManifestKey(date)));
  if (!obj) return null;
  let value: unknown;
  try {
    value = await obj.json();
  } catch (error) {
    // Not JSON: an invalid manifest. Any other failure is R2 failing to read
    // the body.
    if (error instanceof SyntaxError) return null;
    throw new HealthR2Error(HEALTH_R2_ERRORS.manifest, error);
  }
  try {
    return parseBackupManifest(value, date);
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
      const obj = await r2Call(HEALTH_R2_ERRORS.files, () => bucket.head(key));
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

  // Find latest backup. A broken listing (a bad cursor, or an R2 failure of
  // the list call) is reported as critical, never thrown, so the endpoint
  // keeps answering 200 with a body that says why. Anything else still throws.
  let latestBackup: Awaited<ReturnType<typeof findLatestBackup>>;
  try {
    latestBackup = await findLatestBackup(bucket);
  } catch (error) {
    let message: string;
    if (error instanceof BackupListingError) {
      message = error.message;
    } else if (error instanceof HealthR2Error) {
      message = reportR2Failure(error, 'listing');
    } else {
      throw error;
    }
    return {
      status: 'critical',
      timestamp: now.toISOString(),
      lastBackup: null,
      issues: [{ severity: 'critical', message }],
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

  // Fetch and validate manifest. An R2 failure is reported as such, not as a
  // missing or invalid manifest.
  let manifest: BackupManifest | null = null;
  try {
    manifest = await fetchManifest(bucket, latestBackup.date);
    if (!manifest) {
      issues.push({ severity: 'critical', message: 'Backup manifest is missing or invalid' });
    }
  } catch (error) {
    if (!(error instanceof HealthR2Error)) throw error;
    issues.push({ severity: 'critical', message: reportR2Failure(error, 'manifest read') });
  }
  const manifestValid = manifest !== null;

  // Records the backup run skipped (v1.39.0): a stored value that is not
  // JSON cannot be archived (backupKV), so the archive lacks it. A warning,
  // not critical: every other record is backed up, and such a record is
  // unreadable to every reader already. The count only, never a key (the
  // run's own log names them). A key that vanished between the listing and
  // the read, or holds a JSON null, is not counted: that is the normal race
  // of a record deleted mid-run, not a record the archive lacks.
  const skippedNotJson = manifest?.kv.skippedNotJson ?? 0;
  if (skippedNotJson > 0) {
    issues.push({
      severity: 'warning',
      message:
        skippedNotJson === 1
          ? '1 stored record is not JSON and was not backed up'
          : `${skippedNotJson} stored records are not JSON and were not backed up`,
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

  // Check file completeness. An R2 failure is a critical issue, not a 500.
  let files: BackupFileStatus[] = [];
  let filesComplete = false;
  try {
    files = await checkBackupFiles(bucket, latestBackup.date);
  } catch (error) {
    if (!(error instanceof HealthR2Error)) throw error;
    issues.push({ severity: 'critical', message: reportR2Failure(error, 'file check') });
  }
  if (files.length > 0) {
    // An empty object is as unusable as a missing one.
    filesComplete = files.every(f => f.exists && f.size > 0);
    if (!filesComplete) {
      const missing = files.filter(f => !f.exists || f.size === 0).map(f => f.key);
      issues.push({
        severity: 'critical',
        message: `Missing backup files: ${missing.join(', ')}`,
      });
    }
  }

  // Read the archive back, counting only (no record array): every object can
  // exist and still be unrestorable (truncated, corrupt, or holding a different
  // record count). It is checked against its own routeCount metadata (the
  // manifest's count only for an archive without it).
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
      // count, duplicate key, content, missing archive) is reported as is. R2
      // failing to fetch or stream the archive (BackupReadError, v1.37.1) is a
      // storage fault: logged, and reported with its own fixed message, never
      // as a content failure. Anything else still throws.
      if (error instanceof BackupIntegrityError) {
        issues.push({ severity: 'critical', message: error.message });
      } else if (error instanceof BackupReadError) {
        issues.push({ severity: 'critical', message: reportR2Failure(error, 'archive read') });
      } else {
        throw error;
      }
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

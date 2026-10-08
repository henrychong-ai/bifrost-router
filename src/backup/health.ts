// R2Bucket is an ambient global from the generated runtime types
// (worker-configuration.d.ts, produced by `wrangler types` against
// compatibility_date) — no import needed since the migration off
// @cloudflare/workers-types.

import { errorName } from '../utils/error-name';
import { nextCursor } from '../utils/list-cursor';
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
  SkippedRecords,
} from './health-schemas';
import { DEFAULT_HEALTH_CONFIG } from './health-schemas';
import {
  type ArchiveRun,
  archiveRouteCount,
  archiveRun,
  BackupIntegrityError,
  BackupListingError,
  BackupReadError,
  MAX_BACKUP_BYTES,
  parseBackupManifest,
  type StoredArchiveScan,
  verifyArchiveObject,
} from './integrity';
import type { BackupManifest } from './types';

/** Bytes as MiB with one decimal, for health messages. */
const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Fixed messages for the R2 failures health reports instead of throwing
 * (v1.37.1), so `GET /api/backups/health` answers 200 whatever R2 does. The
 * R2 error itself is logged, never put in the response. A failed list call is
 * critical (nothing is known); a failed read of the manifest or the archive
 * (GET or HEAD) is a WARNING (v1.40.0): a storage fault is not evidence of a
 * bad backup, and the file it concerns is listed with `state: 'unknown'`.
 */
export const HEALTH_R2_ERRORS = {
  /** Listing the daily backups failed (other than a broken cursor). */
  listing: 'Backup listing failed',
  /**
   * Checking the archive object (R2 head, used when the manifest cannot name
   * it for verification) failed.
   */
  files: 'Backup files could not be checked',
  /** Fetching or reading the manifest failed (not: missing or invalid). */
  manifest: 'Backup manifest could not be read',
} as const;

/**
 * Health's message when the backup cannot be verified at all (v1.40.0): the
 * manifest could not be read, so the archive was at most HEADed (or could
 * not be read either). An unreadable archive alone is a warning.
 */
export const HEALTH_UNVERIFIABLE =
  'Backup cannot be verified: the manifest could not be read and the archive was not verified';

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
    cursor = nextCursor(page, seenCursors, () => new BackupListingError());
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

/** File rows of the health answer (v1.40.0: with their state). */
const presentFile = (key: string, size: number): BackupFileStatus => ({
  key,
  size,
  exists: true,
  state: 'present',
});
const missingFile = (key: string): BackupFileStatus => ({
  key,
  size: 0,
  exists: false,
  state: 'missing',
});
/** A file R2 failed to answer for: neither present nor missing. */
const unknownFile = (key: string): BackupFileStatus => ({
  key,
  size: 0,
  exists: false,
  state: 'unknown',
});

/** The manifest as read: its file status, and the manifest when valid. */
interface ManifestRead {
  file: BackupFileStatus;
  /** Null when it is missing, empty, not JSON or not a valid manifest for the date. */
  manifest: BackupManifest | null;
}

/**
 * Fetch and parse the backup manifest, taking its size from the same GET
 * (v1.40.0; there is no separate HEAD). An R2 failure fetching or reading it
 * is a different fault from a missing or invalid manifest and throws a
 * {@link HealthR2Error} (v1.37.1).
 */
async function readManifest(bucket: R2Bucket, date: string): Promise<ManifestRead> {
  const key = backupManifestKey(date);
  const obj = await r2Call(HEALTH_R2_ERRORS.manifest, () => bucket.get(key));
  if (!obj) return { file: missingFile(key), manifest: null };
  const file = presentFile(key, obj.size);
  let value: unknown;
  try {
    value = await obj.json();
  } catch (error) {
    // Not JSON: an invalid manifest. Any other failure is R2 failing to read
    // the body.
    if (error instanceof SyntaxError) return { file, manifest: null };
    throw new HealthR2Error(HEALTH_R2_ERRORS.manifest, error);
  }
  try {
    return { file, manifest: parseBackupManifest(value, date) };
  } catch {
    return { file, manifest: null };
  }
}

/**
 * The last archive this isolate verified (v1.40.0), by its R2 ETag. While the
 * stored object still has that ETag (and the same expected count), health
 * asks R2 for it with `onlyIf: { etagDoesNotMatch }`, gets the object's
 * metadata without its body, and reuses the result instead of streaming and
 * inflating the whole archive again. Only a successful verification is kept;
 * a cold isolate verifies again.
 */
interface VerifiedArchive {
  key: string;
  etag: string;
  expectedCount: number;
  scan: StoredArchiveScan;
}

let lastVerifiedArchive: VerifiedArchive | undefined;

/** Forget the verified archive (tests). */
export function forgetVerifiedArchive(): void {
  lastVerifiedArchive = undefined;
}

/** What health learned of the archive. */
interface ArchiveCheck {
  file: BackupFileStatus;
  /** The verification result; null when not verified. */
  scan: StoredArchiveScan | null;
  /** What the run recorded in the archive's metadata; null before v1.40.0. */
  run: ArchiveRun | null;
  /** The content failure verification found, if any (critical). */
  failure?: BackupIntegrityError;
  /** R2 failed mid-stream after answering the GET (a warning). */
  readError?: BackupReadError;
}

/**
 * Check the archive object. Without a manifest to verify against, a HEAD
 * reports its file status only. With one, ONE GET gives both its size and the
 * body verified (v1.40.0; it used to be a HEAD, then a GET), and a GET
 * conditional on the ETag of the archive this isolate last verified returns
 * no body while that archive is unchanged. Integrity failures throw
 * {@link BackupIntegrityError}, R2 failing to deliver the archive
 * {@link BackupReadError}, and a failed HEAD {@link HealthR2Error}.
 */
async function checkArchive(
  bucket: R2Bucket,
  key: string,
  manifest: BackupManifest | null,
): Promise<ArchiveCheck> {
  if (!manifest) {
    const head = await r2Call(HEALTH_R2_ERRORS.files, () => bucket.head(key));
    return head
      ? { file: presentFile(key, head.size), scan: null, run: archiveRun(head) }
      : { file: missingFile(key), scan: null, run: null };
  }
  const cached = lastVerifiedArchive?.key === key ? lastVerifiedArchive : undefined;
  const get = async (conditional: boolean): Promise<R2Object | R2ObjectBody | null> => {
    try {
      return await bucket.get(
        key,
        conditional && cached ? { onlyIf: { etagDoesNotMatch: cached.etag } } : undefined,
      );
    } catch (error) {
      throw new BackupReadError(error);
    }
  };
  let object = await get(true);
  if (!object) return { file: missingFile(key), scan: null, run: null };
  let file = presentFile(key, object.size);
  const expectedCount = archiveRouteCount(object) ?? manifest.kv.totalRoutes;
  if (!('body' in object)) {
    // Unchanged since it was verified: reuse that result, unless the count it
    // was checked against has changed (a legacy archive's manifest)
    if (cached && cached.expectedCount === expectedCount) {
      return { file, scan: cached.scan, run: archiveRun(object) };
    }
    object = await get(false);
    // Deleted between the two reads
    if (!object || !('body' in object)) return { file: missingFile(key), scan: null, run: null };
    file = presentFile(key, object.size);
  }
  if (object.size === 0) {
    // An empty object is as unusable as a missing one; reported as missing
    await object.body.cancel().catch(() => undefined);
    return { file, scan: null, run: archiveRun(object) };
  }
  const run = archiveRun(object);
  let scan: StoredArchiveScan;
  try {
    scan = await verifyArchiveObject(object, manifest.kv.totalRoutes);
  } catch (error) {
    if (error instanceof BackupIntegrityError) return { file, scan: null, run, failure: error };
    // The GET answered, so the file is known to exist with its size; only its
    // content is unknown (v1.40.0)
    if (error instanceof BackupReadError) {
      return { file: { ...file, state: 'unknown' }, scan: null, run, readError: error };
    }
    throw error;
  }
  if (typeof object.etag === 'string' && object.etag !== '') {
    lastVerifiedArchive = { key, etag: object.etag, expectedCount, scan };
  }
  return { file, scan, run };
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
 * What the latest run skipped (v1.40.0), from the archive's own metadata,
 * written in the same put as the archive, so a failed manifest write or a
 * same-day re-run can never make it disagree with the archive. The manifest
 * adds the key names only when it belongs to the same run (`runId`). When the
 * archive's metadata is not available (an archive written before v1.40.0, or
 * one R2 failed to deliver) the manifest's counts and key names are used,
 * `source: 'manifest'`. Null when neither says anything.
 */
function skippedRecords(
  run: ArchiveRun | null,
  manifest: BackupManifest | null,
): SkippedRecords | null {
  if (run) {
    const sameRun = manifest?.kv.runId === run.runId;
    return {
      source: 'archive',
      notJson: run.skippedNotJson,
      overLineLimit: run.skippedOverLineLimit,
      ...(sameRun &&
        manifest?.kv.skippedOverLineLimitKeys && {
          overLineLimitKeys: manifest.kv.skippedOverLineLimitKeys,
        }),
    };
  }
  if (!manifest) return null;
  return {
    source: 'manifest',
    notJson: manifest.kv.skippedNotJson ?? 0,
    overLineLimit: manifest.kv.skippedOverLineLimit ?? 0,
    ...(manifest.kv.skippedOverLineLimitKeys && {
      overLineLimitKeys: manifest.kv.skippedOverLineLimitKeys,
    }),
  };
}

const records = (count: number) => (count === 1 ? '1 stored record' : `${count} stored records`);

/**
 * The issues for what a run skipped. Not JSON (v1.39.0): a WARNING, the count
 * only; such a record is unreadable to every reader already. Over the line
 * limit (v1.40.0): CRITICAL, valid records the archive lacks; the keys are in
 * `lastBackup.skipped`. (The whole store passing MAX_BACKUP_BYTES fails the
 * run instead, so no archive of it exists.)
 */
function skippedIssues(skipped: SkippedRecords | null): HealthIssue[] {
  if (!skipped) return [];
  const issues: HealthIssue[] = [];
  if (skipped.notJson > 0) {
    issues.push({
      severity: 'warning',
      message:
        skipped.notJson === 1
          ? '1 stored record is not JSON and was not backed up'
          : `${skipped.notJson} stored records are not JSON and were not backed up`,
    });
  }
  if (skipped.overLineLimit > 0) {
    issues.push({
      severity: 'critical',
      message: `${records(skipped.overLineLimit)} over the record line limit (MAX_RECORD_LINE_BYTES) not backed up`,
    });
  }
  return issues;
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
        contentVerified: false,
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
        contentVerified: false,
      },
    };
  }

  // Fetch and validate manifest. An R2 failure is reported as such, not as a
  // missing or invalid manifest.
  let manifest: BackupManifest | null = null;
  let manifestFile: BackupFileStatus | null = null;
  try {
    const read = await readManifest(bucket, latestBackup.date);
    manifestFile = read.file;
    // An empty manifest is not JSON, so readManifest gives null for it too
    manifest = read.manifest;
    if (!manifest) {
      issues.push({ severity: 'critical', message: 'Backup manifest is missing or invalid' });
    }
  } catch (error) {
    if (!(error instanceof HealthR2Error)) throw error;
    manifestFile = unknownFile(backupManifestKey(latestBackup.date));
    issues.push({ severity: 'warning', message: reportR2Failure(error, 'manifest read') });
  }
  const manifestValid = manifest !== null;

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

  // Check the archive: its file status, and its content read back, counting
  // only (no record array). Every object can exist and still be unrestorable
  // (truncated, corrupt, or holding a different record count). It is checked
  // against its own routeCount metadata (the manifest's count only for an
  // archive without it). A failed HEAD is a critical issue, not a 500.
  const archiveKey = backupArchiveKey(latestBackup.date);
  let archiveFile: BackupFileStatus;
  let archive: ArchiveInfo | null = null;
  let run: ArchiveRun | null = null;
  try {
    const checked = await checkArchive(bucket, archiveKey, manifest);
    archiveFile = checked.file;
    run = checked.run;
    if (checked.failure) issues.push({ severity: 'critical', message: checked.failure.message });
    if (checked.readError) {
      issues.push({
        severity: 'warning',
        message: reportR2Failure(checked.readError, 'archive read'),
      });
    }
    if (checked.scan) {
      const { scan } = checked;
      archive = { records: scan.records, inflatedBytes: scan.inflatedBytes };
      // A manifest write that failed after the archive was replaced, or two
      // overlapping runs: the archive is sound, its manifest is stale.
      if (manifest && scan.countSource === 'archive' && scan.records !== manifest.kv.totalRoutes) {
        issues.push({
          severity: 'warning',
          message: 'Backup manifest is out of date with its archive',
        });
      }
    }
  } catch (error) {
    // A fixed integrity message (size limit, count, duplicate key, content)
    // is a content failure: critical, reported as is (checkArchive returns
    // it with the file's row). R2
    // failing to fetch or stream the archive (BackupReadError, v1.37.1) is a
    // storage fault, not evidence of a bad backup: logged, and reported with
    // its own fixed message as a WARNING (v1.40.0; it was critical), with
    // `contentVerified` false and the archive's row `unknown`; so is a failed
    // HEAD. Anything else still throws.
    archiveFile = unknownFile(archiveKey);
    if (error instanceof BackupReadError) {
      issues.push({ severity: 'warning', message: reportR2Failure(error, 'archive read') });
    } else if (error instanceof HealthR2Error) {
      issues.push({ severity: 'warning', message: reportR2Failure(error, 'file check') });
    } else {
      throw error;
    }
  }

  // One unreadable object is a warning; an unreadable manifest leaves the
  // archive unverified (it is only HEADed, or unreadable too), so nothing
  // can be verified at all, which is critical (v1.40.0)
  if (manifestFile?.state === 'unknown' && archive === null) {
    issues.push({ severity: 'critical', message: HEALTH_UNVERIFIABLE });
  }

  const skipped = skippedRecords(run, manifest);
  issues.push(...skippedIssues(skipped));

  // File completeness, from the two GETs (or the HEAD): an empty object is as
  // unusable as a missing one. A file R2 failed to answer for keeps its row
  // as `unknown` (v1.40.0), so `filesComplete: false` is explained; it is
  // not reported missing.
  const files = [manifestFile ?? unknownFile(backupManifestKey(latestBackup.date)), archiveFile];
  const missing = files
    .filter(f => f.state !== 'unknown' && (!f.exists || f.size === 0))
    .map(f => f.key);
  const filesComplete = files.every(f => f.state !== 'unknown') && missing.length === 0;
  if (missing.length > 0) {
    issues.push({
      severity: 'critical',
      message: `Missing backup files: ${missing.join(', ')}`,
    });
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
      skipped,
    },
    issues,
    checks: {
      backupExists: true,
      backupAge: backupAgeStatus,
      manifestValid,
      filesComplete,
      routeCountOk,
      contentVerified: archive !== null,
    },
  };
}

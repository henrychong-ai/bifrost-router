import type { R2Bucket } from '@cloudflare/workers-types';
import type { BackupManifest } from './types';
import type {
  BackupHealthResponse,
  BackupFileStatus,
  HealthStatus,
  BackupAgeStatus,
  HealthIssue,
  ManifestSummary,
  HealthCheckConfig,
} from './health-schemas';
import { DEFAULT_HEALTH_CONFIG } from './health-schemas';

/**
 * Expected backup files for a given date
 */
const EXPECTED_FILES = [
  'manifest.json',
  'kv-routes.ndjson.gz',
  'd1-link_clicks.ndjson.gz',
  'd1-page_views.ndjson.gz',
  'd1-file_downloads.ndjson.gz',
  'd1-proxy_requests.ndjson.gz',
  'd1-audit_logs.ndjson.gz',
] as const;

/**
 * Find the most recent backup in the R2 bucket
 */
async function findLatestBackup(
  bucket: R2Bucket,
): Promise<{ date: string; timestamp: string } | null> {
  // List objects with prefix 'daily/' to find backup directories
  const list = await bucket.list({ prefix: 'daily/', delimiter: '/' });

  if (!list.delimitedPrefixes || list.delimitedPrefixes.length === 0) {
    return null;
  }

  // Extract dates and sort descending to get most recent
  const dates = list.delimitedPrefixes
    .map(p => p.replace('daily/', '').replace('/', ''))
    .filter(d => /^\d{8}$/.test(d))
    .sort((a, b) => b.localeCompare(a));

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
async function fetchManifest(
  bucket: R2Bucket,
  date: string,
): Promise<BackupManifest | null> {
  try {
    const obj = await bucket.get(`daily/${date}/manifest.json`);
    if (!obj) return null;
    return (await obj.json()) as BackupManifest;
  } catch {
    return null;
  }
}

/**
 * Convert BackupManifest to ManifestSummary for API response
 */
function manifestToSummary(manifest: BackupManifest): ManifestSummary {
  // Convert the tables from string[] to D1TableInfo[]
  // We don't have per-table row counts in the current manifest, so estimate
  const tables = manifest.d1.tables.map(name => ({
    name,
    // Estimate: distribute total rows evenly across tables
    rows: Math.floor(manifest.d1.totalRows / manifest.d1.tables.length),
  }));

  return {
    version: manifest.version,
    kv: {
      totalRoutes: manifest.kv.totalRoutes,
      domains: manifest.kv.domains,
    },
    d1: {
      totalRows: manifest.d1.totalRows,
      tables,
    },
  };
}

/**
 * Check existence and size of all expected backup files
 */
async function checkBackupFiles(
  bucket: R2Bucket,
  date: string,
): Promise<BackupFileStatus[]> {
  const results = await Promise.all(
    EXPECTED_FILES.map(async filename => {
      const key = `daily/${date}/${filename}`;
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

  // Find latest backup
  const latestBackup = await findLatestBackup(bucket);

  // No backup found - critical
  if (!latestBackup) {
    return {
      status: 'critical',
      timestamp: now.toISOString(),
      lastBackup: null,
      issues: [
        { severity: 'critical', message: 'No backup found in R2 bucket' },
      ],
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
  const filesComplete = files.every(f => f.exists);

  if (!filesComplete) {
    const missing = files.filter(f => !f.exists).map(f => f.key);
    issues.push({
      severity: 'critical',
      message: `Missing backup files: ${missing.join(', ')}`,
    });
  }

  // Check route count
  let routeCountOk = true;
  if (manifest && manifest.kv.totalRoutes < cfg.minExpectedRoutes) {
    routeCountOk = false;
    issues.push({
      severity: 'warning',
      message: `Route count (${manifest.kv.totalRoutes}) below minimum expected (${cfg.minExpectedRoutes})`,
    });
  }

  // Determine overall status
  const hasCritical = issues.some(i => i.severity === 'critical');
  const hasWarning = issues.some(i => i.severity === 'warning');
  const status: HealthStatus = hasCritical
    ? 'critical'
    : hasWarning
      ? 'warning'
      : 'healthy';

  return {
    status,
    timestamp: now.toISOString(),
    lastBackup: {
      date: latestBackup.date,
      timestamp: backupTime.toISOString(),
      ageHours,
      manifest: manifest ? manifestToSummary(manifest) : null,
      files,
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

/**
 * Backup manifest stored with each backup
 */
export interface BackupManifest {
  /** Manifest schema version */
  version: string;

  /** Backup timestamp (milliseconds since epoch) */
  timestamp: number;

  /** Backup date in YYYYMMDD format */
  date: string;

  /** KV routes backup information */
  kv: {
    /** Domains included in backup */
    domains: string[];
    /** Total number of routes backed up */
    totalRoutes: number;
    /** R2 object key for the backup file */
    file: string;
    /**
     * KV values that were not JSON, skipped and not in the archive (v1.38.0;
     * absent from an older manifest). Each was logged by its key.
     */
    skippedNotJson?: number | undefined;
    /**
     * Records over MAX_RECORD_LINE_BYTES, skipped (v1.40.0; absent from an
     * older manifest), and up to MAX_REPORTED_SKIPPED_KEYS of their keys.
     */
    skippedOverLineLimit?: number | undefined;
    skippedOverLineLimitKeys?: string[] | undefined;
    /** The run that wrote this manifest and its archive (v1.40.0). */
    runId?: string | undefined;
  };
}

/**
 * Result of a backup operation
 */
export interface BackupResult {
  /** Whether the backup succeeded */
  success: boolean;

  /** Backup manifest (if successful) */
  manifest?: BackupManifest;

  /** Error message (if failed) */
  error?: string;

  /** Duration of backup operation in milliseconds */
  duration: number;
}

/**
 * Result of KV backup operation
 */
export interface KVBackupResult {
  /** Domains backed up */
  domains: string[];
  /** Total routes backed up */
  totalRoutes: number;
  /** R2 object key */
  file: string;
  /** KV values that were not JSON, skipped (v1.38.0) */
  skippedNotJson: number;
  /** Records over MAX_RECORD_LINE_BYTES, skipped (v1.40.0), and their first keys */
  skippedOverLineLimit: number;
  skippedOverLineLimitKeys: string[];
  /** The run id, also in the archive's metadata (v1.40.0) */
  runId: string;
}

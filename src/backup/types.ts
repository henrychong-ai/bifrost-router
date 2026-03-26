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
}

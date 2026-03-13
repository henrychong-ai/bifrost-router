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

  /** D1 database backup information */
  d1: {
    /** Tables successfully backed up */
    tables: string[];
    /** Total number of rows backed up */
    totalRows: number;
    /** R2 object keys for each table backup */
    files: Record<string, string>;
    /** Tables that failed to backup (undefined if all succeeded) */
    failedTables?: string[];
  };

  /** Retention policy applied */
  retention: {
    /** Days to keep daily backups */
    daily: number;
    /** Days to keep weekly (Sunday) backups */
    weekly: number;
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

/**
 * Result of D1 backup operation
 */
export interface D1BackupResult {
  /** Tables successfully backed up */
  tables: string[];
  /** Total rows backed up */
  totalRows: number;
  /** R2 object keys per table */
  files: Record<string, string>;
  /** Tables that failed to backup (undefined if all succeeded) */
  failedTables?: string[];
}

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
  /** Keys of deleted objects */
  deleted: string[];
}

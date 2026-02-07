import { useQuery } from '@tanstack/react-query';
import { api, type BackupHealthResponse } from '@/lib/api-client';

// =============================================================================
// Query Keys
// =============================================================================

export const backupKeys = {
  all: ['backup'] as const,
  health: () => ['backup', 'health'] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch backup health status
 *
 * Automatically refreshes every 5 minutes and considers data stale after 1 minute.
 */
export function useBackupHealth() {
  return useQuery({
    queryKey: backupKeys.health(),
    queryFn: () => api.backup.health(),
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
    staleTime: 60 * 1000, // Consider stale after 1 minute
    retry: 1, // Only retry once on failure
  });
}

// Re-export types for convenience
export type { BackupHealthResponse };
export type {
  BackupFileStatus,
  D1TableInfo,
  ManifestSummary,
  LastBackupInfo,
  HealthIssue,
  HealthChecks,
} from '@/lib/api-client';

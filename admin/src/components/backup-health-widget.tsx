import { useBackupHealth } from '../hooks/use-backup-health';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Skeleton } from './ui/skeleton';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  Clock,
  Database,
  HardDrive,
  RefreshCw,
} from 'lucide-react';

/**
 * Loading skeleton for the backup health widget
 */
function BackupHealthSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-20" />
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-36" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Error state for the backup health widget
 */
function BackupHealthError({ onRetry, isRetrying }: { onRetry?: () => void; isRetrying?: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Backup Status</CardTitle>
        <div className="flex items-center gap-2">
          {onRetry && (
            <button
              onClick={onRetry}
              disabled={isRetrying}
              className="p-1 hover:bg-muted rounded transition-colors disabled:opacity-50"
              title="Retry loading backup status"
            >
              <RefreshCw className={`h-3 w-3 text-muted-foreground ${isRetrying ? 'animate-spin' : ''}`} />
            </button>
          )}
          <Badge variant="destructive">
            <XCircle className="h-4 w-4 mr-1" />
            Error
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Failed to load backup health status</p>
      </CardContent>
    </Card>
  );
}

/**
 * Backup health widget component
 *
 * Displays the current backup system health status including:
 * - Overall status (healthy/warning/critical)
 * - Last backup age
 * - Route count
 * - D1 row count
 * - Any issues detected
 */
export function BackupHealthWidget() {
  const { data: health, isLoading, error, refetch, isFetching } = useBackupHealth();

  if (isLoading) return <BackupHealthSkeleton />;
  if (error || !health) return <BackupHealthError onRetry={() => refetch()} isRetrying={isFetching} />;

  const statusIcon = {
    healthy: <CheckCircle className="h-4 w-4" />,
    warning: <AlertTriangle className="h-4 w-4" />,
    critical: <XCircle className="h-4 w-4" />,
  }[health.status];

  const statusVariant = {
    healthy: 'default' as const,
    warning: 'secondary' as const,
    critical: 'destructive' as const,
  }[health.status];

  const statusColor = {
    healthy: 'text-green-600',
    warning: 'text-yellow-600',
    critical: 'text-red-600',
  }[health.status];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium">Backup Status</CardTitle>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1 hover:bg-muted rounded transition-colors disabled:opacity-50"
            title="Refresh backup status"
          >
            <RefreshCw className={`h-3 w-3 text-muted-foreground ${isFetching ? 'animate-spin' : ''}`} />
          </button>
          <Badge
            variant={statusVariant}
            className={health.status === 'critical' ? 'bg-red-600 text-white border-red-600' : statusColor}
          >
            {statusIcon}
            <span className="ml-1 capitalize">{health.status}</span>
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {health.lastBackup ? (
            <>
              <div className="flex items-center text-sm">
                <Clock className="h-4 w-4 mr-2 text-muted-foreground" />
                <span>
                  Last backup:{' '}
                  <span className="font-medium">{health.lastBackup.ageHours.toFixed(1)}h ago</span>
                </span>
              </div>
              <div className="flex items-center text-sm">
                <HardDrive className="h-4 w-4 mr-2 text-muted-foreground" />
                <span>
                  <span className="font-medium">
                    {health.lastBackup.manifest?.kv.totalRoutes ?? 0}
                  </span>{' '}
                  routes
                </span>
              </div>
              <div className="flex items-center text-sm">
                <Database className="h-4 w-4 mr-2 text-muted-foreground" />
                <span>
                  <span className="font-medium">
                    {health.lastBackup.manifest?.d1.totalRows?.toLocaleString() ?? 0}
                  </span>{' '}
                  analytics rows
                </span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No backup found</p>
          )}

          {health.issues.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <p className="text-xs font-medium text-muted-foreground mb-1">Issues:</p>
              {health.issues.map((issue, i) => (
                <p
                  key={i}
                  className={`text-xs ${
                    issue.severity === 'critical' ? 'text-red-600' : 'text-yellow-600'
                  }`}
                >
                  • {issue.message}
                </p>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

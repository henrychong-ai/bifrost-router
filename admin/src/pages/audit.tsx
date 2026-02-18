import { useState, useMemo } from 'react';
import { useAuditLogs, useDebounce } from '@/hooks';
import { useAuditFilters } from '@/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  ToggleLeft,
  Layers,
  ArrowRightLeft,
} from 'lucide-react';
import { FilterToolbar, type FilterState } from '@/components/filters';
import type { AuditFilterState } from '@/context';
import type { AuditAction, AuditLog } from '@/lib/schemas';

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(timestamp);
}

const ACTION_COLORS: Record<AuditAction, string> = {
  create: 'bg-green-100 text-green-800 border-green-200',
  update: 'bg-blue-100 text-blue-800 border-blue-200',
  delete: 'bg-red-100 text-red-800 border-red-200',
  toggle: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  seed: 'bg-purple-100 text-purple-800 border-purple-200',
  migrate: 'bg-cyan-100 text-cyan-800 border-cyan-200',
};

const ACTION_ICONS: Record<AuditAction, React.ReactNode> = {
  create: <Plus className="h-3 w-3" />,
  update: <Pencil className="h-3 w-3" />,
  delete: <Trash2 className="h-3 w-3" />,
  toggle: <ToggleLeft className="h-3 w-3" />,
  seed: <Layers className="h-3 w-3" />,
  migrate: <ArrowRightLeft className="h-3 w-3" />,
};

function parseDetails(details: string | null): string {
  if (!details) return '-';
  try {
    const parsed = JSON.parse(details);
    // For toggle actions, show enabled status
    if ('enabled' in parsed) {
      return parsed.enabled ? 'Enabled' : 'Disabled';
    }
    // For seed actions, show count
    if ('count' in parsed) {
      return `${parsed.count} routes`;
    }
    // For other actions, show a summary
    if ('route' in parsed) {
      return parsed.route?.target ? `Target: ${parsed.route.target}` : 'Route data';
    }
    if ('before' in parsed && 'after' in parsed) {
      return 'Modified route';
    }
    return JSON.stringify(parsed).slice(0, 50);
  } catch {
    return details.slice(0, 50);
  }
}

export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const limit = 50;

  // Filter state from context (persists during navigation)
  const { filters, setFilters } = useAuditFilters();

  // Debounce search input
  const debouncedSearch = useDebounce(filters.search || '', 300);

  // Build query params for API
  const queryParams = useMemo(
    () => ({
      limit,
      offset,
      domain: filters.domain || undefined,
      days: filters.days || 30,
      action: filters.action || undefined,
      actor: filters.actor || undefined,
      path: debouncedSearch || undefined,
    }),
    [limit, offset, filters.domain, filters.days, filters.action, filters.actor, debouncedSearch],
  );

  const { data, isLoading, error } = useAuditLogs(queryParams);

  // Handle filter changes - reset pagination when filters change
  const handleFilterChange = (newFilters: FilterState) => {
    setOffset(0);
    setFilters({ ...filters, ...newFilters } as AuditFilterState);
  };

  // Handle action filter change
  const handleActionChange = (value: string) => {
    setOffset(0);
    if (value === 'all') {
      const { action: _, ...rest } = filters;
      setFilters(rest);
    } else {
      setFilters({ ...filters, action: value as AuditAction });
    }
  };

  // Handle reset - reset pagination (FilterToolbar handles filter reset via onFiltersChange)
  const handleResetPagination = () => {
    setOffset(0);
    setFilters({ days: 30 });
  };

  // Check if any filters are active
  const hasActiveFilters = !!(
    filters.search ||
    filters.domain ||
    filters.action ||
    filters.actor ||
    (filters.days && filters.days !== 30)
  );

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">Audit Log</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive font-gilroy">
              Failed to load audit logs: {error.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasPrev = offset > 0;
  const hasNext = data?.meta.hasMore ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">Audit Log</h1>
        <div className="h-1 flex-1 rounded-full gradient-accent-bar opacity-30" />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FilterToolbar
          filters={filters}
          onFiltersChange={handleFilterChange}
          onReset={handleResetPagination}
          showReset={hasActiveFilters}
          searchPlaceholder="Search by path..."
        />

        {/* Action filter */}
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">Action</label>
          <Select value={filters.action || 'all'} onValueChange={handleActionChange}>
            <SelectTrigger className="w-[140px] font-gilroy">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-gilroy">
                All Actions
              </SelectItem>
              <SelectItem value="create" className="font-gilroy">
                Create
              </SelectItem>
              <SelectItem value="update" className="font-gilroy">
                Update
              </SelectItem>
              <SelectItem value="delete" className="font-gilroy">
                Delete
              </SelectItem>
              <SelectItem value="toggle" className="font-gilroy">
                Toggle
              </SelectItem>
              <SelectItem value="seed" className="font-gilroy">
                Seed
              </SelectItem>
              <SelectItem value="migrate" className="font-gilroy">
                Migrate
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="font-gilroy font-semibold text-blue-950">
            Activity History
          </CardTitle>
          <CardDescription className="font-gilroy">
            {isLoading
              ? 'Loading...'
              : `Showing ${data?.items.length || 0} of ${data?.meta.total || 0} audit entries`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-charcoal-100 bg-muted/30">
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Time
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Action
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Domain
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Path
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Actor
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Details
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        IP Address
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.items.map((log: AuditLog) => (
                      <TableRow key={log.id} className="hover:bg-gold-50/50 transition-colors">
                        <TableCell
                          className="text-small font-gilroy whitespace-nowrap"
                          title={formatDate(log.createdAt)}
                        >
                          {formatRelativeTime(log.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={`${ACTION_COLORS[log.action]} flex items-center gap-1 w-fit font-gilroy font-medium`}
                          >
                            {ACTION_ICONS[log.action]}
                            {log.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-600">
                          {log.domain}
                        </TableCell>
                        <TableCell className="font-mono text-small max-w-[200px] truncate font-medium text-blue-600">
                          {log.path || '-'}
                        </TableCell>
                        <TableCell className="text-small font-gilroy whitespace-nowrap">
                          <div className="flex flex-col">
                            <span className="font-medium">
                              {log.actorName || log.actorLogin || 'Unknown'}
                            </span>
                            {log.actorName &&
                              log.actorLogin &&
                              log.actorLogin !== log.actorName && (
                                <span className="text-charcoal-400 text-xs">{log.actorLogin}</span>
                              )}
                          </div>
                        </TableCell>
                        <TableCell
                          className="text-small font-gilroy text-charcoal-600 max-w-[200px] truncate"
                          title={log.details || ''}
                        >
                          {parseDetails(log.details)}
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-400">
                          {log.ipAddress || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!data?.items || data.items.length === 0) && (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="text-center text-muted-foreground font-gilroy"
                        >
                          No audit logs recorded
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {data && data.meta.total > limit && (
                <div className="flex items-center justify-between pt-4 border-t border-border/30 mt-4">
                  <div className="text-small text-muted-foreground font-gilroy">
                    Showing {offset + 1} - {Math.min(offset + limit, data.meta.total)} of{' '}
                    {data.meta.total}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset(Math.max(0, offset - limit))}
                      disabled={!hasPrev}
                      className="font-gilroy hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset(offset + limit)}
                      disabled={!hasNext}
                      className="font-gilroy hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

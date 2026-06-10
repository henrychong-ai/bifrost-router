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
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { FilterToolbar, type FilterState } from '@/components/filters';
import {
  ACTION_COLORS,
  SOURCE_COLORS,
  SOURCE_LABELS,
  parseDetails,
  formatDate,
  formatRelativeTime,
} from '@/lib/audit-format';
import { AuditActionIcon } from '@/components/audit-action-icon';
import { AuditDetailDialog } from '@/components/audit-detail-dialog';
import type { AuditFilterState } from '@/context';
import { AuditSourceSchema } from '@/lib/schemas';
import type { AuditAction, AuditLog, AuditSource } from '@/lib/schemas';

export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

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
      source: filters.source || undefined,
    }),
    [
      limit,
      offset,
      filters.domain,
      filters.days,
      filters.action,
      filters.actor,
      filters.source,
      debouncedSearch,
    ],
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

  // Handle source filter change — which pipeline recorded the entry
  const handleSourceChange = (value: string) => {
    setOffset(0);
    if (value === 'all') {
      const { source: _, ...rest } = filters;
      setFilters(rest);
    } else {
      setFilters({ ...filters, source: value as AuditSource });
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
    filters.source ||
    (filters.days && filters.days !== 30)
  );

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-inter font-bold text-blue-950">Audit Log</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive font-inter">
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
        <h1 className="text-huge font-inter font-bold text-blue-950">Audit Log</h1>
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
          <label className="text-small font-inter text-charcoal-600">Action</label>
          <Select value={filters.action || 'all'} onValueChange={handleActionChange}>
            <SelectTrigger className="w-[140px] font-inter">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-inter">
                All Actions
              </SelectItem>
              <SelectItem value="create" className="font-inter">
                Create
              </SelectItem>
              <SelectItem value="update" className="font-inter">
                Update
              </SelectItem>
              <SelectItem value="delete" className="font-inter">
                Delete
              </SelectItem>
              <SelectItem value="toggle" className="font-inter">
                Toggle
              </SelectItem>
              <SelectItem value="seed" className="font-inter">
                Seed
              </SelectItem>
              <SelectItem value="migrate" className="font-inter">
                Migrate
              </SelectItem>
              <SelectItem value="transfer" className="font-inter">
                Transfer
              </SelectItem>
              <SelectItem value="r2_upload" className="font-inter">
                R2 Upload
              </SelectItem>
              <SelectItem value="r2_delete" className="font-inter">
                R2 Delete
              </SelectItem>
              <SelectItem value="r2_rename" className="font-inter">
                R2 Rename
              </SelectItem>
              <SelectItem value="r2_move" className="font-inter">
                R2 Move
              </SelectItem>
              <SelectItem value="r2_replace" className="font-inter">
                R2 Replace
              </SelectItem>
              <SelectItem value="r2_metadata_update" className="font-inter">
                R2 Metadata
              </SelectItem>
              <SelectItem value="r2_cache_purge" className="font-inter">
                R2 Cache Purge
              </SelectItem>
              <SelectItem value="r2_comment_update" className="font-inter">
                R2 Comment
              </SelectItem>
              <SelectItem value="feedback_create" className="font-inter">
                Feedback Create
              </SelectItem>
              <SelectItem value="feedback_triage" className="font-inter">
                Feedback Triage
              </SelectItem>
              <SelectItem value="feedback_delete" className="font-inter">
                Feedback Delete
              </SelectItem>
              <SelectItem value="r2_object_create" className="font-inter">
                R2 Object Create (ext)
              </SelectItem>
              <SelectItem value="r2_object_delete" className="font-inter">
                R2 Object Delete (ext)
              </SelectItem>
              <SelectItem value="cf_config_change" className="font-inter">
                CF Config Change
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Source filter (v1.28.0) — which pipeline recorded the entry */}
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-inter text-charcoal-600">Source</label>
          <Select value={filters.source || 'all'} onValueChange={handleSourceChange}>
            <SelectTrigger className="w-[140px] font-inter">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-inter">
                All Sources
              </SelectItem>
              {/* Derived from the shared enum — a new source value appears here
                  automatically with its badge label (no hand-kept list). */}
              {AuditSourceSchema.options.map(s => (
                <SelectItem key={s} value={s} className="font-inter">
                  {SOURCE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="font-inter font-semibold text-blue-950">Activity History</CardTitle>
          <CardDescription className="font-inter">
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
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        Time
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        Action
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        Domain
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        Path
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        Actor
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        Details
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-inter font-semibold text-charcoal-700">
                        IP Address
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.items.map((log: AuditLog) => (
                      <TableRow
                        key={log.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`View audit record ${log.id}`}
                        onClick={() => setSelectedLog(log)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedLog(log);
                          }
                        }}
                        className="
                          cursor-pointer transition-colors
                          hover:bg-gold-50/50
                          focus-visible:ring-2 focus-visible:ring-gold-300
                          focus-visible:outline-none
                        "
                      >
                        <TableCell
                          className="text-small font-inter whitespace-nowrap"
                          title={formatDate(log.createdAt)}
                        >
                          {formatRelativeTime(log.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge
                              variant="outline"
                              className={`${ACTION_COLORS[log.action]} flex items-center gap-1 w-fit font-inter font-medium`}
                            >
                              <AuditActionIcon action={log.action} />
                              {log.action}
                            </Badge>
                            {log.source !== 'bifrost' && (
                              <Badge
                                variant="outline"
                                className={`${SOURCE_COLORS[log.source]} w-fit font-inter font-medium`}
                              >
                                {SOURCE_LABELS[log.source]}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-600">
                          {log.domain}
                        </TableCell>
                        <TableCell className="font-mono text-small max-w-[200px] truncate font-medium text-blue-600">
                          {log.path || '-'}
                        </TableCell>
                        <TableCell className="text-small font-inter whitespace-nowrap">
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
                          className="text-small font-inter text-charcoal-600 max-w-[200px] truncate"
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
                          className="text-center text-muted-foreground font-inter"
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
                  <div className="text-small text-muted-foreground font-inter">
                    Showing {offset + 1} - {Math.min(offset + limit, data.meta.total)} of{' '}
                    {data.meta.total}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset(Math.max(0, offset - limit))}
                      disabled={!hasPrev}
                      className="font-inter hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setOffset(offset + limit)}
                      disabled={!hasNext}
                      className="font-inter hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
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

      <AuditDetailDialog log={selectedLog} onClose={() => setSelectedLog(null)} />
    </div>
  );
}

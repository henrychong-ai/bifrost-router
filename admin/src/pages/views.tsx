import { useState, useMemo } from 'react';
import { useViews, useDebounce } from '@/hooks';
import { useViewsFilters } from '@/context';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { FilterToolbar, type FilterState } from '@/components/filters';

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function ViewsPage() {
  const [offset, setOffset] = useState(0);
  const limit = 50;

  // Filter state from context (persists during navigation)
  const { filters, setFilters } = useViewsFilters();

  // Debounce search input
  const debouncedSearch = useDebounce(filters.search || '', 300);

  // Build query params for API
  const queryParams = useMemo(
    () => ({
      limit,
      offset,
      domain: filters.domain || undefined,
      days: filters.days || 1,
      country: filters.country || undefined,
      path: debouncedSearch || undefined,
    }),
    [limit, offset, filters.domain, filters.days, filters.country, debouncedSearch],
  );

  const { data, isLoading, error } = useViews(queryParams);

  // Handle filter changes - reset pagination when filters change
  const handleFilterChange = (newFilters: FilterState) => {
    setOffset(0);
    setFilters(newFilters);
  };

  // Handle reset - reset pagination (FilterToolbar handles filter reset via onFiltersChange)
  const handleResetPagination = () => {
    setOffset(0);
  };

  // Check if any filters are active
  const hasActiveFilters = !!(
    filters.search ||
    filters.domain ||
    filters.country ||
    (filters.days && filters.days !== 1)
  );

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">Page Views</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive font-gilroy">Failed to load views: {error.message}</p>
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
        <h1 className="text-huge font-gilroy font-bold text-blue-950">Page Views</h1>
        <div className="h-1 flex-1 rounded-full gradient-accent-bar opacity-30" />
      </div>

      <FilterToolbar
        filters={filters}
        onFiltersChange={handleFilterChange}
        onReset={handleResetPagination}
        showReset={hasActiveFilters}
        searchPlaceholder="Search by path..."
      />

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="font-gilroy font-semibold text-blue-950">View Log</CardTitle>
          <CardDescription className="font-gilroy">
            {isLoading
              ? 'Loading...'
              : `Showing ${data?.items.length || 0} of ${data?.meta.total || 0} views`}
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
                        Domain
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Path
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Query
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Referrer
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        City
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Country
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Continent
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Colo
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Timezone
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        Protocol
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        User Agent
                      </TableHead>
                      <TableHead className="whitespace-nowrap font-gilroy font-semibold text-charcoal-700">
                        IP Address
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.items.map(view => (
                      <TableRow key={view.id} className="hover:bg-gold-50/50 transition-colors">
                        <TableCell className="text-small font-gilroy whitespace-nowrap">
                          {formatDate(view.createdAt)}
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-600">
                          {view.domain}
                        </TableCell>
                        <TableCell className="font-mono text-small max-w-[200px] truncate font-medium text-blue-600">
                          {view.path}
                        </TableCell>
                        <TableCell
                          className="font-mono text-small max-w-[150px] truncate text-charcoal-500"
                          title={view.queryString || ''}
                        >
                          {view.queryString || '-'}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate text-small font-gilroy text-charcoal-600">
                          {view.referrer || '-'}
                        </TableCell>
                        <TableCell className="text-small font-gilroy whitespace-nowrap">
                          {view.city || '-'}
                        </TableCell>
                        <TableCell className="text-small font-gilroy whitespace-nowrap font-medium">
                          {view.country || '-'}
                        </TableCell>
                        <TableCell className="text-small font-gilroy whitespace-nowrap text-charcoal-500">
                          {view.continent || '-'}
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-500">
                          {view.colo || '-'}
                        </TableCell>
                        <TableCell className="text-small font-gilroy whitespace-nowrap text-charcoal-500">
                          {view.timezone || '-'}
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-500">
                          {view.httpProtocol || '-'}
                        </TableCell>
                        <TableCell
                          className="max-w-[300px] truncate text-small font-gilroy text-charcoal-400"
                          title={view.userAgent || ''}
                        >
                          {view.userAgent || '-'}
                        </TableCell>
                        <TableCell className="font-mono text-small whitespace-nowrap text-charcoal-400">
                          {view.ipAddress || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!data?.items || data.items.length === 0) && (
                      <TableRow>
                        <TableCell
                          colSpan={13}
                          className="text-center text-muted-foreground font-gilroy"
                        >
                          No views recorded
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

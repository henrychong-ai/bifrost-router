import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Copy,
  Download,
  FileDown,
  Globe,
  Link2,
  MousePointerClick,
  RefreshCw,
  Route,
  Search,
  ServerCog,
  ShieldCheck,
} from 'lucide-react';
import { useAnalyticsSummary } from '@/hooks';
import { SUPPORTED_DOMAINS } from '@/context';
import { BackupHealthWidget } from '@/components/backup-health-widget';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  analyticsSummaryToCsv,
  dashboardFiltersToSearchParams,
  parseDashboardFilters,
  type DashboardFilters,
} from '@/lib/dashboard-analytics';
import type { AnalyticsSummary, TopClick, TopPage, TopProxy } from '@/lib/schemas';
import { copyToClipboard } from '@/lib/utils';

const PERIOD_OPTIONS = [
  { value: '1', label: '24 hours' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatShare(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-tiny text-muted-foreground">No baseline</span>;
  const positive = value >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={
        positive
          ? 'inline-flex items-center text-tiny text-emerald-700'
          : 'inline-flex items-center text-tiny text-amber-700'
      }
    >
      <Icon className="size-3" aria-hidden="true" />
      {Math.abs(value).toFixed(1)}% vs prior
    </span>
  );
}

function KpiCard({
  title,
  value,
  detail,
  delta,
  badge,
  icon: Icon,
  href,
  isLoading,
}: {
  title: string;
  value: string;
  detail: string;
  delta?: number | null;
  badge?: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  href?: string;
  isLoading: boolean;
}) {
  const card = (
    <Card className="h-full border-border/60 transition-shadow hover:shadow-md">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="font-inter text-small font-semibold text-charcoal-700">
            {title}
          </CardTitle>
          {badge && (
            <Badge variant="outline" className="mt-1 border-amber-300 text-amber-800">
              {badge}
            </Badge>
          )}
        </div>
        <span className="flex size-8 items-center justify-center rounded-lg bg-blue-100">
          <Icon className="size-4 text-blue-700" aria-hidden />
        </span>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <p className="font-inter text-xlarge font-bold text-blue-950 tabular-nums">{value}</p>
        )}
        <p className="mt-1 text-tiny text-muted-foreground">{detail}</p>
        {delta !== undefined && !isLoading && <Delta value={delta} />}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link to={href} className="rounded-xl focus-visible:ring-2 focus-visible:outline-none">
      {card}
    </Link>
  ) : (
    card
  );
}

function SourceUrl({ url }: { url: string }) {
  return (
    <div className="flex min-w-0 items-start gap-1">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 font-mono text-small break-all text-blue-700 hover:underline"
      >
        {url}
      </a>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => void copyToClipboard(url, 'Source URL')}
        aria-label={`Copy ${url}`}
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  );
}

function RouteTable({
  title,
  description,
  label,
  items,
}: {
  title: string;
  description: string;
  label: string;
  items: Array<TopClick | TopProxy>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-inter font-semibold text-blue-950">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Destination</TableHead>
              <TableHead className="text-right">{label}</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map(item => (
              <TableRow key={`${item.domain}\u001f${item.path}\u001f${item.targetUrl}`}>
                <TableCell className="min-w-64 whitespace-normal">
                  <SourceUrl url={item.sourceUrl} />
                  <span className="text-tiny text-muted-foreground">{item.domain}</span>
                </TableCell>
                <TableCell className="max-w-80 whitespace-normal">
                  <a
                    href={item.targetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-small break-all hover:underline"
                  >
                    {item.targetUrl}
                  </a>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.count.toLocaleString()}
                  <div>
                    <Delta value={item.deltaPercent} />
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatShare(item.share)}</TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No recorded routes.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function WebsitePages({ items }: { items: TopPage[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-inter font-semibold text-blue-950">Top Website Pages</CardTitle>
        <CardDescription>HTML pages served through configured service bindings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((item, index) => (
          <div
            key={`${item.domain}\u001f${item.path}`}
            className="flex items-start gap-3 border-b py-2 last:border-0"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gold-100 text-tiny font-semibold text-gold-800">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <SourceUrl url={item.sourceUrl} />
              <span className="text-tiny text-muted-foreground">
                {item.count.toLocaleString()} views · {formatShare(item.share)}
              </span>
            </div>
            <Delta value={item.deltaPercent} />
          </div>
        ))}
        {items.length === 0 && (
          <p className="py-8 text-center text-small text-muted-foreground">
            No service-backed page views.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function RankedOverview({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: Array<{ label: string; count: number; share?: number }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-inter font-semibold text-blue-950">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.slice(0, 8).map((item, index) => (
          <div key={`${item.label}\u001f${index}`} className="flex items-center gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-tiny font-semibold text-blue-800">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-small" title={item.label}>
              {item.label}
            </span>
            <span className="text-small tabular-nums">
              {item.count.toLocaleString()}
              {item.share !== undefined && (
                <span className="ml-1 text-tiny text-muted-foreground">
                  ({formatShare(item.share)})
                </span>
              )}
            </span>
          </div>
        ))}
        {items.length === 0 && (
          <p className="py-8 text-center text-small text-muted-foreground">No matching data.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Insights({ summary }: { summary: AnalyticsSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-inter font-semibold text-blue-950">
          Actionable insights
        </CardTitle>
        <CardDescription>Signals derived from the current filtered view</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {summary.insights.map(item => {
          const content = (
            <>
              <p className="font-semibold">{item.title}</p>
              <p className="mt-1 text-small text-muted-foreground">{item.description}</p>
            </>
          );
          return item.href ? (
            <Link key={item.id} to={item.href} className="rounded-lg border p-4 hover:bg-muted">
              {content}
            </Link>
          ) : (
            <div key={item.id} className="rounded-lg border p-4">
              {content}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function downloadCsv(summary: AnalyticsSummary) {
  const blob = new Blob([analyticsSummaryToCsv(summary)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bifrost-analytics-${summary.period}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const allowedDomains = useMemo(() => [...SUPPORTED_DOMAINS], []);
  const filters = useMemo(
    () => parseDashboardFilters(searchParams, allowedDomains),
    [searchParams, allowedDomains],
  );
  const [searchInput, setSearchInput] = useState(filters.search);
  const [countryInput, setCountryInput] = useState(filters.country);

  useEffect(() => setSearchInput(filters.search), [filters.search]);
  useEffect(() => setCountryInput(filters.country), [filters.country]);

  const updateFilters = useCallback(
    (patch: Partial<DashboardFilters>) => {
      setSearchParams(dashboardFiltersToSearchParams({ ...filters, ...patch }), { replace: true });
    },
    [filters, setSearchParams],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchInput !== filters.search) updateFilters({ search: searchInput.trim() });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filters.search, searchInput, updateFilters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (countryInput !== filters.country && (countryInput === '' || countryInput.length === 2))
        updateFilters({ country: countryInput });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [countryInput, filters.country, updateFilters]);

  const {
    data: summary,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useAnalyticsSummary({
    days: filters.days,
    domain: filters.domain || undefined,
    country: filters.country || undefined,
    search: filters.search || undefined,
    includeMonitoring: filters.includeMonitoring,
  });
  const periodValue = PERIOD_OPTIONS.some(option => Number(option.value) === filters.days)
    ? String(filters.days)
    : 'custom';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-inter text-huge font-bold text-blue-950">Dashboard</h1>
            {isFetching && !isLoading && (
              <RefreshCw className="size-4 animate-spin text-blue-600" />
            )}
          </div>
          <p className="mt-1 max-w-3xl text-small text-muted-foreground">
            Domain-aware traffic overview with Cloudflare Health Checks excluded by default and
            explicit coverage boundaries.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyToClipboard(window.location.href, 'Dashboard view')}
          >
            <Link2 /> Share view
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!summary}
            onClick={() => summary && downloadCsv(summary)}
          >
            <Download /> Export CSV
          </Button>
        </div>
      </div>

      <Card className="border-blue-200 bg-blue-50/30">
        <CardContent className="pt-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-1 xl:col-span-2">
              <Label htmlFor="dashboard-search">Search URLs, targets, and referrers</Label>
              <div className="relative">
                <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
                <Input
                  id="dashboard-search"
                  value={searchInput}
                  onChange={event => setSearchInput(event.target.value.slice(0, 500))}
                  placeholder="Search analytics…"
                  className="pl-9"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Domain</Label>
              <Select
                value={filters.domain || 'all'}
                onValueChange={value => updateFilters({ domain: value === 'all' ? '' : value })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All domains</SelectItem>
                  {allowedDomains.map(domain => (
                    <SelectItem key={domain} value={domain}>
                      {domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Period</Label>
              <Select
                value={periodValue}
                onValueChange={value =>
                  value !== 'custom' && updateFilters({ days: Number(value) })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dashboard-country">Country</Label>
              <Input
                id="dashboard-country"
                value={countryInput}
                onChange={event =>
                  setCountryInput(
                    event.target.value
                      .toUpperCase()
                      .replaceAll(/[^A-Z]/g, '')
                      .slice(0, 2),
                  )
                }
                placeholder="All / SG"
                maxLength={2}
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex items-center gap-2">
              <Switch
                id="include-monitoring"
                checked={filters.includeMonitoring}
                onCheckedChange={checked => updateFilters({ includeMonitoring: checked })}
              />
              <Label htmlFor="include-monitoring">Include Cloudflare Health Checks</Label>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => void refetch()}>
                <RefreshCw /> Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchInput('');
                  setCountryInput('');
                  setSearchParams(new URLSearchParams(), { replace: true });
                }}
              >
                Reset
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive">Failed to load analytics: {error.message}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Recorded events"
          value={(summary?.overview.recordedEvents ?? 0).toLocaleString()}
          detail={`Legacy rows in ${filters.days} days`}
          delta={summary?.overview.deltaPercent}
          badge="Partial coverage"
          icon={Activity}
          isLoading={isLoading}
        />
        <KpiCard
          title="Redirect clicks"
          value={(summary?.clicks.total ?? 0).toLocaleString()}
          detail={`${(summary?.clicks.uniqueUrls ?? 0).toLocaleString()} unique full URLs`}
          delta={summary?.clicks.deltaPercent}
          icon={MousePointerClick}
          href="/analytics/redirects"
          isLoading={isLoading}
        />
        <KpiCard
          title="Downloads"
          value={(summary?.downloads.total ?? 0).toLocaleString()}
          detail={`${formatBytes(summary?.downloads.totalBytes ?? 0)} served`}
          delta={summary?.downloads.deltaPercent}
          icon={FileDown}
          href="/analytics/downloads"
          isLoading={isLoading}
        />
        <KpiCard
          title="Proxy requests"
          value={(summary?.proxy.total ?? 0).toLocaleString()}
          detail={`${(summary?.proxy.errorCount ?? 0).toLocaleString()} 5xx responses`}
          delta={summary?.proxy.deltaPercent}
          icon={ServerCog}
          href="/analytics/proxy"
          isLoading={isLoading}
        />
        <KpiCard
          title="Website pages"
          value={(summary?.views.total ?? 0).toLocaleString()}
          detail="Service-binding HTML responses"
          delta={summary?.views.deltaPercent}
          icon={Globe}
          href="/analytics/views"
          isLoading={isLoading}
        />
        <KpiCard
          title="Unique full URLs"
          value={(summary?.overview.uniqueUrls ?? 0).toLocaleString()}
          detail="Domain and path counted together"
          icon={Route}
          isLoading={isLoading}
        />
        <KpiCard
          title="Unified requests"
          value={(summary?.coverage.unifiedTraffic.recordedRequests ?? 0).toLocaleString()}
          detail={
            summary?.coverage.unifiedTraffic.enabled
              ? 'Shadow capture active; excluded from headline'
              : 'Dormant until explicitly activated'
          }
          badge="Not in headline"
          icon={ShieldCheck}
          isLoading={isLoading}
        />
      </div>

      {summary && (
        <>
          <Card className="border-amber-300 bg-amber-50/50">
            <CardContent className="pt-6">
              <p className="font-semibold text-amber-950">Historical coverage is partial</p>
              <p className="mt-1 text-small text-amber-900">{summary.coverage.note}</p>
              <p className="mt-1 text-tiny text-amber-800">
                {summary.monitoring.rows.total.toLocaleString()} matching health-check rows are{' '}
                {summary.monitoring.included ? 'included' : 'excluded'}.
              </p>
            </CardContent>
          </Card>
          <Insights summary={summary} />
          <div className="grid gap-4 lg:grid-cols-3">
            <RankedOverview
              title="Top Domains"
              description="Recorded events grouped by source domain"
              items={summary.topDomains.map(item => ({
                label: item.domain,
                count: item.count,
                share: item.share,
              }))}
            />
            <RankedOverview
              title="Top Countries"
              description="Cloudflare country codes across recorded traffic"
              items={summary.topCountries.map(item => ({
                label: item.name || 'Unknown',
                count: item.count,
              }))}
            />
            <RankedOverview
              title="Top Referrers"
              description="Most common recorded traffic sources"
              items={summary.topReferrers.map(item => ({
                label: item.name || 'Direct / unknown',
                count: item.count,
              }))}
            />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <RouteTable
              title="Top Routes - Redirect"
              description="Most-used redirect routes and configured destinations"
              label="Redirects"
              items={summary.topClicks}
            />
            <RouteTable
              title="Top Routes - Proxy"
              description="Most-used reverse-proxy routes and upstream targets"
              label="Requests"
              items={summary.topProxies}
            />
          </div>
          <WebsitePages items={summary.topPages} />
          <Card>
            <CardHeader>
              <CardTitle className="font-inter font-semibold text-blue-950">
                Recent activity
              </CardTitle>
              <CardDescription>Newest events across all four legacy streams</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Full URL</TableHead>
                    <TableHead>Country</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.recentActivity.map(item => (
                    <TableRow key={item.eventId}>
                      <TableCell className="capitalize">{item.type}</TableCell>
                      <TableCell className="min-w-64 whitespace-normal">
                        <SourceUrl url={item.sourceUrl} />
                      </TableCell>
                      <TableCell>{item.country ?? 'Unknown'}</TableCell>
                      <TableCell className="text-right text-small">
                        {new Date(item.createdAt * 1000).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <BackupHealthWidget />
      </div>
    </div>
  );
}

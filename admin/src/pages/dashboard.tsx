import { useAnalyticsSummary } from '@/hooks';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { MousePointerClick, Eye, Route, Globe } from 'lucide-react';
import { BackupHealthWidget } from '@/components/backup-health-widget';

export function DashboardPage() {
  const { data: summary, isLoading, error } = useAnalyticsSummary({ days: 30 });

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">
          Dashboard
        </h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive font-gilroy">
              Failed to load analytics: {error.message}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">
          Dashboard
        </h1>
        <div className="h-1 flex-1 rounded-full gradient-accent-bar opacity-30" />
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-small font-gilroy font-semibold text-charcoal-700">
              Total Clicks
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100">
              <MousePointerClick className="h-4 w-4 text-blue-600" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-xlarge font-gilroy font-bold text-blue-950">
                {summary?.clicks.total.toLocaleString()}
              </div>
            )}
            <p className="text-tiny text-muted-foreground font-gilroy mt-1">
              Last 30 days
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-small font-gilroy font-semibold text-charcoal-700">
              Unique Slugs
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold-100">
              <Route className="h-4 w-4 text-gold-600" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-xlarge font-gilroy font-bold text-blue-950">
                {summary?.clicks.uniqueSlugs.toLocaleString()}
              </div>
            )}
            <p className="text-tiny text-muted-foreground font-gilroy mt-1">
              Active links
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-small font-gilroy font-semibold text-charcoal-700">
              Page Views
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100">
              <Eye className="h-4 w-4 text-blue-600" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-xlarge font-gilroy font-bold text-blue-950">
                {summary?.views.total.toLocaleString()}
              </div>
            )}
            <p className="text-tiny text-muted-foreground font-gilroy mt-1">
              Last 30 days
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-small font-gilroy font-semibold text-charcoal-700">
              Unique Pages
            </CardTitle>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold-100">
              <Globe className="h-4 w-4 text-gold-600" />
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : (
              <div className="text-xlarge font-gilroy font-bold text-blue-950">
                {summary?.views.uniquePaths.toLocaleString()}
              </div>
            )}
            <p className="text-tiny text-muted-foreground font-gilroy mt-1">
              Distinct paths
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top Lists */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader>
            <CardTitle className="font-gilroy font-semibold text-blue-950">
              Top Clicks
            </CardTitle>
            <CardDescription className="font-gilroy">
              Most clicked links
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {summary?.topClicks.slice(0, 5).map((item, index) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between py-1 border-b border-border/30 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-tiny font-gilroy font-medium text-blue-700">
                        {index + 1}
                      </span>
                      <span className="font-mono text-small truncate max-w-[180px]">
                        {item.name}
                      </span>
                    </div>
                    <span className="text-small font-gilroy font-medium text-gold-600">
                      {item.count}
                    </span>
                  </div>
                ))}
                {(!summary?.topClicks || summary.topClicks.length === 0) && (
                  <p className="text-small text-muted-foreground font-gilroy">
                    No clicks yet
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader>
            <CardTitle className="font-gilroy font-semibold text-blue-950">
              Top Pages
            </CardTitle>
            <CardDescription className="font-gilroy">
              Most viewed pages
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {summary?.topPages.slice(0, 5).map((item, index) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between py-1 border-b border-border/30 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gold-100 text-tiny font-gilroy font-medium text-gold-700">
                        {index + 1}
                      </span>
                      <span className="font-mono text-small truncate max-w-[180px]">
                        {item.name}
                      </span>
                    </div>
                    <span className="text-small font-gilroy font-medium text-blue-600">
                      {item.count}
                    </span>
                  </div>
                ))}
                {(!summary?.topPages || summary.topPages.length === 0) && (
                  <p className="text-small text-muted-foreground font-gilroy">
                    No views yet
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader>
            <CardTitle className="font-gilroy font-semibold text-blue-950">
              Top Countries
            </CardTitle>
            <CardDescription className="font-gilroy">
              Visitors by country
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {summary?.topCountries.slice(0, 5).map((item, index) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between py-1 border-b border-border/30 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-charcoal-100 text-tiny font-gilroy font-medium text-charcoal-700">
                        {index + 1}
                      </span>
                      <span className="text-small font-gilroy">
                        {item.name || 'Unknown'}
                      </span>
                    </div>
                    <span className="text-small font-gilroy font-medium text-gold-600">
                      {item.count}
                    </span>
                  </div>
                ))}
                {(!summary?.topCountries ||
                  summary.topCountries.length === 0) && (
                  <p className="text-small text-muted-foreground font-gilroy">
                    No data yet
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg transition-all duration-300 border-border/50">
          <CardHeader>
            <CardTitle className="font-gilroy font-semibold text-blue-950">
              Top Referrers
            </CardTitle>
            <CardDescription className="font-gilroy">
              Traffic sources
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {summary?.topReferrers.slice(0, 5).map((item, index) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between py-1 border-b border-border/30 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-charcoal-100 text-tiny font-gilroy font-medium text-charcoal-700">
                        {index + 1}
                      </span>
                      <span className="text-small font-gilroy truncate max-w-[180px]">
                        {item.name || 'Direct'}
                      </span>
                    </div>
                    <span className="text-small font-gilroy font-medium text-blue-600">
                      {item.count}
                    </span>
                  </div>
                ))}
                {(!summary?.topReferrers ||
                  summary.topReferrers.length === 0) && (
                  <p className="text-small text-muted-foreground font-gilroy">
                    No data yet
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Backup Health */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <BackupHealthWidget />
      </div>
    </div>
  );
}

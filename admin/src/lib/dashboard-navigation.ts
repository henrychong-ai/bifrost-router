import { dashboardFiltersToSearchParams } from './dashboard-analytics';
import type { AnalyticsSummary } from './schemas';

type RecentActivityItem = AnalyticsSummary['recentActivity'][number];

const RECENT_ACTIVITY_ROUTES = {
  click: '/analytics/redirects',
  view: '/analytics/views',
  download: '/analytics/downloads',
  proxy: '/analytics/proxy',
} as const satisfies Record<RecentActivityItem['type'], string>;

export function buildRecentActivityHref(
  item: Pick<RecentActivityItem, 'type' | 'domain' | 'path' | 'country'>,
  days: number,
  includeMonitoring: boolean,
): string {
  // This dashboard's DashboardFilters uses '' (not undefined) for "no filter",
  // and dashboardFiltersToSearchParams omits empty values, so an event with no
  // recorded country produces no country parameter.
  const params = dashboardFiltersToSearchParams({
    domain: item.domain,
    days,
    country: item.country ?? '',
    search: item.path,
    includeMonitoring,
  });
  return `${RECENT_ACTIVITY_ROUTES[item.type]}?${params.toString()}`;
}

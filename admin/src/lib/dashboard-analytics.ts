import type { AnalyticsSummary } from './schemas';

export const DEFAULT_DASHBOARD_DAYS = 30;

export interface DashboardFilters {
  days: number;
  domain: string;
  country: string;
  search: string;
  includeMonitoring: boolean;
}

function boundedDays(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : DEFAULT_DASHBOARD_DAYS;
}

export function parseDashboardFilters(
  params: URLSearchParams,
  allowedDomains: readonly string[],
): DashboardFilters {
  const requestedDomain = params.get('domain') ?? '';
  return {
    days: boundedDays(params.get('days')),
    domain: allowedDomains.includes(requestedDomain) ? requestedDomain : '',
    country: (params.get('country') ?? '').trim().toUpperCase().slice(0, 2),
    search: (params.get('search') ?? '').trim().slice(0, 500),
    includeMonitoring: params.get('includeMonitoring') === 'true',
  };
}

export function dashboardFiltersToSearchParams(filters: DashboardFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.days !== DEFAULT_DASHBOARD_DAYS) params.set('days', String(filters.days));
  if (filters.domain) params.set('domain', filters.domain);
  if (filters.country) params.set('country', filters.country);
  if (filters.search) params.set('search', filters.search);
  if (filters.includeMonitoring) params.set('includeMonitoring', 'true');
  return params;
}

function csvCell(value: string | number | null): string {
  const raw = value === null ? '' : String(value);
  const text =
    typeof value === 'string' && (/^[\t\r]/.test(raw) || /^\s*[=+\-@]/.test(raw)) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Export exactly the filtered, authorised summary currently rendered. */
export function analyticsSummaryToCsv(summary: AnalyticsSummary): string {
  const rows: Array<Array<string | number | null>> = [
    ['section', 'rank', 'domain', 'source_url', 'target_url', 'count', 'share', 'delta_percent'],
  ];
  summary.topDomains.forEach((item, index) => {
    rows.push(['top_domains', index + 1, item.domain, '', '', item.count, item.share, null]);
  });
  summary.topClicks.forEach((item, index) => {
    rows.push([
      'top_redirect_routes',
      index + 1,
      item.domain,
      item.sourceUrl,
      item.targetUrl,
      item.count,
      item.share,
      item.deltaPercent,
    ]);
  });
  summary.topProxies.forEach((item, index) => {
    rows.push([
      'top_proxy_routes',
      index + 1,
      item.domain,
      item.sourceUrl,
      item.targetUrl,
      item.count,
      item.share,
      item.deltaPercent,
    ]);
  });
  summary.topPages.forEach((item, index) => {
    rows.push([
      'top_website_pages',
      index + 1,
      item.domain,
      item.sourceUrl,
      '',
      item.count,
      item.share,
      item.deltaPercent,
    ]);
  });
  summary.recentActivity.forEach((item, index) => {
    rows.push([
      `recent_${item.type}`,
      index + 1,
      item.domain,
      item.sourceUrl,
      item.targetUrl,
      1,
      '',
      '',
    ]);
  });
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

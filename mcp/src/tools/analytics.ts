/**
 * Analytics tool handlers for MCP server
 */

import type {
  EdgeRouterClient,
  AnalyticsSummary,
  SlugStats,
  LinkClick,
  PageView,
  PaginatedResponse,
} from '@bifrost/shared';

/**
 * Format a number with thousands separators
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Format a timestamp as a relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Format analytics summary for display
 */
function formatAnalyticsSummary(summary: AnalyticsSummary): string {
  const lines = [
    `Analytics Summary (${summary.period})`,
    `Domain: ${summary.domain}`,
    '',
    '📊 Overview',
    `• Total Clicks: ${formatNumber(summary.clicks.total)}`,
    `• Unique Links: ${formatNumber(summary.clicks.uniqueSlugs)}`,
    `• Total Page Views: ${formatNumber(summary.views.total)}`,
    `• Unique Pages: ${formatNumber(summary.views.uniquePaths)}`,
  ];

  if (summary.topClicks.length > 0) {
    lines.push('', '🔗 Top Links');
    summary.topClicks.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} - ${formatNumber(item.count)} clicks`);
    });
  }

  if (summary.topPages.length > 0) {
    lines.push('', '📄 Top Pages');
    summary.topPages.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} - ${formatNumber(item.count)} views`);
    });
  }

  if (summary.topCountries.length > 0) {
    lines.push('', '🌍 Top Countries');
    summary.topCountries.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} - ${formatNumber(item.count)}`);
    });
  }

  if (summary.topReferrers.length > 0) {
    lines.push('', '🔀 Top Referrers');
    summary.topReferrers.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} - ${formatNumber(item.count)}`);
    });
  }

  if (summary.recentClicks.length > 0) {
    lines.push('', '⏱️ Recent Clicks');
    summary.recentClicks.forEach(click => {
      const country = click.country ? ` (${click.country})` : '';
      lines.push(`• ${click.slug}${country} - ${formatRelativeTime(click.createdAt)}`);
    });
  }

  return lines.join('\n');
}

/**
 * Format click list for display
 */
function formatClickList(
  response: PaginatedResponse<LinkClick>,
  domain: string | undefined,
): string {
  const { items, meta } = response;

  if (items.length === 0) {
    return `No clicks found${domain ? ` for ${domain}` : ''} in the specified time range.`;
  }

  const lines = [
    `Clicks${domain ? ` for ${domain}` : ''} (${meta.offset + 1}-${meta.offset + items.length} of ${formatNumber(meta.total)})`,
    '',
  ];

  items.forEach(click => {
    const country = click.country ? ` (${click.country})` : '';
    const time = formatRelativeTime(click.createdAt);
    lines.push(`• ${click.slug}${country} → ${click.targetUrl} - ${time}`);
  });

  if (meta.hasMore) {
    lines.push('', `... ${formatNumber(meta.total - meta.offset - items.length)} more clicks`);
  }

  return lines.join('\n');
}

/**
 * Format view list for display
 */
function formatViewList(response: PaginatedResponse<PageView>, domain: string | undefined): string {
  const { items, meta } = response;

  if (items.length === 0) {
    return `No page views found${domain ? ` for ${domain}` : ''} in the specified time range.`;
  }

  const lines = [
    `Page Views${domain ? ` for ${domain}` : ''} (${meta.offset + 1}-${meta.offset + items.length} of ${formatNumber(meta.total)})`,
    '',
  ];

  items.forEach(view => {
    const country = view.country ? ` (${view.country})` : '';
    const time = formatRelativeTime(view.createdAt);
    lines.push(`• ${view.path}${country} - ${time}`);
  });

  if (meta.hasMore) {
    lines.push('', `... ${formatNumber(meta.total - meta.offset - items.length)} more views`);
  }

  return lines.join('\n');
}

/**
 * Format slug stats for display
 */
function formatSlugStats(stats: SlugStats): string {
  const lines = [
    `Statistics for ${stats.slug}`,
    '',
    `📊 Overview`,
    `• Total Clicks: ${formatNumber(stats.totalClicks)}`,
    `• Target URL: ${stats.target || 'Unknown'}`,
  ];

  if (stats.topCountries.length > 0) {
    lines.push('', '🌍 Top Countries');
    stats.topCountries.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} - ${formatNumber(item.count)} clicks`);
    });
  }

  if (stats.topReferrers.length > 0) {
    lines.push('', '🔀 Top Referrers');
    stats.topReferrers.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.name} - ${formatNumber(item.count)} clicks`);
    });
  }

  if (stats.clicksByDay.length > 0) {
    lines.push('', '📈 Recent Activity');
    // Show last 7 days
    stats.clicksByDay.slice(-7).forEach(day => {
      lines.push(`• ${day.date}: ${formatNumber(day.count)} clicks`);
    });
  }

  return lines.join('\n');
}

/**
 * Get analytics summary
 */
export async function getAnalyticsSummary(
  client: EdgeRouterClient,
  args: { domain?: string; days?: number },
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;

  try {
    const summary = await client.getAnalyticsSummary({
      domain,
      days: args.days,
    });
    return formatAnalyticsSummary(summary);
  } catch (error) {
    return `Error getting analytics summary: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get paginated clicks
 */
export async function getClicks(
  client: EdgeRouterClient,
  args: {
    domain?: string;
    days?: number;
    limit?: number;
    offset?: number;
    slug?: string;
    country?: string;
  },
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;

  try {
    const response = await client.getClicks({
      domain,
      days: args.days,
      limit: args.limit,
      offset: args.offset,
      slug: args.slug,
      country: args.country,
    });
    return formatClickList(response, domain);
  } catch (error) {
    return `Error getting clicks: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get paginated page views
 */
export async function getViews(
  client: EdgeRouterClient,
  args: {
    domain?: string;
    days?: number;
    limit?: number;
    offset?: number;
    path?: string;
    country?: string;
  },
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;

  try {
    const response = await client.getViews({
      domain,
      days: args.days,
      limit: args.limit,
      offset: args.offset,
      path: args.path,
      country: args.country,
    });
    return formatViewList(response, domain);
  } catch (error) {
    return `Error getting page views: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get slug-specific statistics
 */
export async function getSlugStats(
  client: EdgeRouterClient,
  args: { slug: string; domain?: string; days?: number },
  defaultDomain?: string,
): Promise<string> {
  const domain = args.domain || defaultDomain;

  try {
    const stats = await client.getSlugStats(args.slug, {
      domain,
      days: args.days,
    });
    return formatSlugStats(stats);
  } catch (error) {
    return `Error getting slug statistics: ${error instanceof Error ? error.message : String(error)}`;
  }
}

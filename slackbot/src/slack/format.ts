/**
 * Slack message formatting utilities
 *
 * Formats responses for Slack using mrkdwn syntax
 */

import type { Route, AnalyticsSummary } from '@bifrost/shared';

/**
 * Format a list of routes for Slack display
 *
 * @param routes - Array of routes from API
 * @param domain - Target domain
 * @returns Formatted Slack message
 */
export function formatRouteList(routes: Route[], domain: string): string {
  const lines = [`*Routes for ${domain}*`, ''];

  if (routes.length === 0) {
    lines.push('No routes configured.');
    return lines.join('\n');
  }

  // Group by type
  const redirects = routes.filter(r => r.type === 'redirect');
  const proxies = routes.filter(r => r.type === 'proxy');
  const r2Routes = routes.filter(r => r.type === 'r2');

  if (redirects.length > 0) {
    lines.push(`*Redirects (${redirects.length})*`);
    for (const route of redirects.slice(0, 10)) {
      const status = route.enabled === false ? ':no_entry_sign:' : '';
      lines.push(`${status} \`${route.path}\` → ${route.target}`);
    }
    if (redirects.length > 10) {
      lines.push(`_...and ${redirects.length - 10} more_`);
    }
    lines.push('');
  }

  if (proxies.length > 0) {
    lines.push(`*Proxies (${proxies.length})*`);
    for (const route of proxies.slice(0, 5)) {
      const status = route.enabled === false ? ':no_entry_sign:' : '';
      lines.push(`${status} \`${route.path}\` → ${route.target}`);
    }
    if (proxies.length > 5) {
      lines.push(`_...and ${proxies.length - 5} more_`);
    }
    lines.push('');
  }

  if (r2Routes.length > 0) {
    lines.push(`*R2 Files (${r2Routes.length})*`);
    for (const route of r2Routes.slice(0, 5)) {
      const status = route.enabled === false ? ':no_entry_sign:' : '';
      lines.push(`${status} \`${route.path}\` → ${route.target}`);
    }
    if (r2Routes.length > 5) {
      lines.push(`_...and ${r2Routes.length - 5} more_`);
    }
  }

  lines.push('');
  lines.push(`_Total: ${routes.length} routes_`);

  return lines.join('\n');
}

/**
 * Format analytics summary for Slack display
 *
 * @param summary - Analytics summary from API
 * @returns Formatted Slack message
 */
export function formatAnalyticsSummary(summary: AnalyticsSummary): string {
  const lines = [
    `*Analytics Summary (${summary.period})*`,
    summary.domain !== 'all' ? `Domain: \`${summary.domain}\`` : '',
    '',
    ':chart_with_upwards_trend: *Totals*',
    `• Total Clicks: ${summary.clicks.total.toLocaleString()}`,
    `• Unique Links: ${summary.clicks.uniqueSlugs}`,
    `• Total Page Views: ${summary.views.total.toLocaleString()}`,
    `• Unique Pages: ${summary.views.uniquePaths}`,
  ];

  // Top clicks
  if (summary.topClicks.length > 0) {
    lines.push('', ':link: *Top Links*');
    for (const item of summary.topClicks.slice(0, 5)) {
      lines.push(
        `${getPositionEmoji(summary.topClicks.indexOf(item) + 1)} \`${item.name}\` - ${item.count} clicks`,
      );
    }
  }

  // Top pages
  if (summary.topPages.length > 0) {
    lines.push('', ':page_facing_up: *Top Pages*');
    for (const item of summary.topPages.slice(0, 5)) {
      lines.push(
        `${getPositionEmoji(summary.topPages.indexOf(item) + 1)} \`${item.name}\` - ${item.count} views`,
      );
    }
  }

  // Top countries
  if (summary.topCountries.length > 0) {
    lines.push('', ':earth_americas: *Top Countries*');
    for (const item of summary.topCountries.slice(0, 5)) {
      const country = item.name || 'Unknown';
      lines.push(
        `${getPositionEmoji(summary.topCountries.indexOf(item) + 1)} ${country} - ${item.count}`,
      );
    }
  }

  return lines.filter(l => l !== '').join('\n');
}

/**
 * Get position emoji for rankings
 */
function getPositionEmoji(position: number): string {
  switch (position) {
    case 1:
      return ':first_place_medal:';
    case 2:
      return ':second_place_medal:';
    case 3:
      return ':third_place_medal:';
    default:
      return `${position}.`;
  }
}

/**
 * Format a route creation confirmation
 *
 * @param route - Created route details
 * @returns Formatted Slack message
 */
export function formatRouteCreated(route: {
  path: string;
  type: string;
  target: string;
  domain: string;
}): string {
  return [
    ':white_check_mark: *Route Created*',
    '',
    `• Path: \`${route.path}\``,
    `• Type: ${route.type}`,
    `• Target: ${route.target}`,
    `• Domain: ${route.domain}`,
  ].join('\n');
}

/**
 * Format a route update confirmation
 *
 * @param path - Route path
 * @param changes - What was changed
 * @returns Formatted Slack message
 */
export function formatRouteUpdated(path: string, changes: string[]): string {
  return [
    ':pencil: *Route Updated*',
    '',
    `Path: \`${path}\``,
    '',
    'Changes:',
    ...changes.map(c => `• ${c}`),
  ].join('\n');
}

/**
 * Format a route deletion confirmation
 *
 * @param path - Deleted route path
 * @returns Formatted Slack message
 */
export function formatRouteDeleted(path: string): string {
  return `:wastebasket: Route \`${path}\` has been deleted.`;
}

/**
 * Format an error message
 *
 * @param message - Error message
 * @returns Formatted Slack message
 */
export function formatError(message: string): string {
  return `:x: *Error*\n${message}`;
}

/**
 * Format a permission denied message
 *
 * @param message - Permission message
 * @returns Formatted Slack message
 */
export function formatPermissionDenied(message: string): string {
  return `:no_entry: *Permission Denied*\n${message}`;
}

/**
 * Format a help message showing available commands
 *
 * @param domains - Domains user has access to
 * @returns Formatted Slack message
 */
export function formatHelp(domains: string[]): string {
  const lines = [
    ':wave: *Bifrost Bot*',
    '',
    'I can help you manage routes and view analytics. Just mention me with your request!',
    '',
    '*Examples:*',
    '• "List all routes for link.henrychong.com"',
    '• "Create a redirect from /twitter to https://twitter.com/henrychong"',
    '• "Show me analytics for the last 7 days"',
    '• "How many clicks did /linkedin get?"',
    '• "Disable the /test route"',
    '• "Delete /old-page"',
    '',
  ];

  if (domains.length > 0) {
    lines.push('*Your accessible domains:*');
    for (const domain of domains) {
      lines.push(`• \`${domain}\``);
    }
  } else {
    lines.push(
      "_You don't have access to any domains yet. Contact an administrator._",
    );
  }

  return lines.join('\n');
}

/**
 * Slack event handlers
 *
 * Handles app_mention and message.im events for Phase II
 * Simple keyword-based command handling (Phase III adds Claude AI)
 */

import type { EdgeRouterClient } from '@bifrost/shared';
import type { SlackEvent } from './verify';
import type { SlackUserPermissions } from '../auth/types';
import { checkToolPermission, getAccessibleDomains } from '../auth/permissions';
import {
  formatRouteList,
  formatAnalyticsSummary,
  formatRouteCreated,
  formatRouteDeleted,
  formatError,
  formatPermissionDenied,
  formatHelp,
} from './format';

/**
 * Handle a Slack event
 *
 * @param event - Slack event payload
 * @param permissions - User's permissions
 * @param client - EdgeRouterClient instance
 * @param botToken - Slack bot token for responses
 * @returns Response message
 */
export async function handleEvent(
  event: SlackEvent,
  permissions: SlackUserPermissions | null,
  client: EdgeRouterClient,
  _botToken: string,
): Promise<string> {
  const text = event.text?.toLowerCase() || '';

  // Remove bot mention from text
  const cleanText = text.replace(/<@[A-Z0-9]+>/gi, '').trim();

  // Help command
  if (cleanText === 'help' || cleanText === '') {
    const domains = getAccessibleDomains(permissions);
    return formatHelp(domains);
  }

  // Parse the command
  const command = parseCommand(cleanText);

  if (!command) {
    return formatHelp(getAccessibleDomains(permissions));
  }

  // Execute the command
  return executeCommand(command, permissions, client);
}

/**
 * Parsed command structure
 */
interface ParsedCommand {
  action: 'list' | 'create' | 'delete' | 'toggle' | 'analytics' | 'stats';
  domain?: string;
  path?: string;
  target?: string;
  type?: 'redirect' | 'proxy' | 'r2';
  days?: number;
  enabled?: boolean;
}

/**
 * Parse user text into a command
 *
 * @param text - Clean user text (without bot mention)
 * @returns Parsed command or null
 */
function parseCommand(text: string): ParsedCommand | null {
  // List routes
  if (text.includes('list') && text.includes('route')) {
    const domain = extractDomain(text);
    return { action: 'list', domain };
  }

  // Analytics summary
  if (
    text.includes('analytics') ||
    text.includes('summary') ||
    text.includes('overview')
  ) {
    const domain = extractDomain(text);
    const days = extractDays(text);
    return { action: 'analytics', domain, days };
  }

  // Stats for specific link
  if (
    text.includes('stats') ||
    text.includes('clicks') ||
    text.includes('how many')
  ) {
    const path = extractPath(text);
    const domain = extractDomain(text);
    const days = extractDays(text);
    return { action: 'stats', domain, path, days };
  }

  // Create route
  if (text.includes('create') || text.includes('add')) {
    const match = text.match(
      /(?:create|add)\s+(?:a\s+)?(?:redirect|proxy)\s+(?:from\s+)?([/\w-]+)\s+(?:to|->|→)\s+(https?:\/\/[^\s]+)/i,
    );
    if (match) {
      const domain = extractDomain(text);
      const type = text.includes('proxy') ? 'proxy' : 'redirect';
      return {
        action: 'create',
        domain,
        path: match[1].startsWith('/') ? match[1] : `/${match[1]}`,
        target: match[2],
        type,
      };
    }
  }

  // Delete route
  if (text.includes('delete') || text.includes('remove')) {
    const path = extractPath(text);
    const domain = extractDomain(text);
    if (path) {
      return { action: 'delete', domain, path };
    }
  }

  // Toggle route
  if (text.includes('enable') || text.includes('disable')) {
    const path = extractPath(text);
    const domain = extractDomain(text);
    const enabled = text.includes('enable');
    if (path) {
      return { action: 'toggle', domain, path, enabled };
    }
  }

  return null;
}

/**
 * Extract domain from text
 */
function extractDomain(text: string): string | undefined {
  // Match common domain patterns
  const patterns = [
    /(?:for|on)\s+([a-z0-9][a-z0-9-]*\.(?:com|net|co|io))/i,
    /([a-z0-9][a-z0-9-]*\.(?:henrychong|vanessahung|davidchong|sonjachong|anjachong|kitkatcouple|valeriehung)\.(?:com|net|co))/i,
    /(link\.henrychong\.com)/i,
    /(henrychong\.com)/i,
    /(vanessahung\.net)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return undefined;
}

/**
 * Extract path from text
 */
function extractPath(text: string): string | undefined {
  // Match /path patterns
  const match = text.match(/(?:^|\s)(\/[a-z0-9-_/]+)/i);
  if (match) {
    return match[1];
  }

  // Match standalone path names after keywords
  const pathMatch = text.match(/(?:route|link|path)\s+([a-z0-9-_]+)/i);
  if (pathMatch) {
    return `/${pathMatch[1]}`;
  }

  return undefined;
}

/**
 * Extract days from text
 */
function extractDays(text: string): number | undefined {
  // "last 7 days", "past 30 days", "7 days"
  const match = text.match(/(?:last|past)?\s*(\d+)\s*days?/i);
  if (match) {
    const days = parseInt(match[1], 10);
    if (days >= 1 && days <= 365) {
      return days;
    }
  }

  // "this week" = 7 days
  if (text.includes('this week') || text.includes('week')) {
    return 7;
  }

  // "today" = 1 day
  if (text.includes('today')) {
    return 1;
  }

  return undefined;
}

/**
 * Execute a parsed command
 */
async function executeCommand(
  command: ParsedCommand,
  permissions: SlackUserPermissions | null,
  client: EdgeRouterClient,
): Promise<string> {
  // Determine default domain
  const accessibleDomains = getAccessibleDomains(permissions);
  const domain =
    command.domain || accessibleDomains[0] || 'link.henrychong.com';

  try {
    switch (command.action) {
      case 'list': {
        const check = checkToolPermission(permissions, 'list_routes', domain);
        if (!check.allowed) {
          return formatPermissionDenied(check.message || 'Permission denied');
        }

        const routes = await client.listRoutes(domain);
        return formatRouteList(routes, domain);
      }

      case 'analytics': {
        const check = checkToolPermission(
          permissions,
          'get_analytics_summary',
          domain,
        );
        if (!check.allowed) {
          return formatPermissionDenied(check.message || 'Permission denied');
        }

        const summary = await client.getAnalyticsSummary({
          domain,
          days: command.days || 30,
        });
        return formatAnalyticsSummary(summary);
      }

      case 'stats': {
        if (!command.path) {
          return formatError(
            'Please specify a path. Example: "stats for /linkedin"',
          );
        }

        const check = checkToolPermission(
          permissions,
          'get_slug_stats',
          domain,
        );
        if (!check.allowed) {
          return formatPermissionDenied(check.message || 'Permission denied');
        }

        const stats = await client.getSlugStats(command.path, {
          domain,
          days: command.days || 30,
        });

        return [
          `*Stats for \`${command.path}\`* (${command.days || 30} days)`,
          '',
          `• Total Clicks: ${stats.totalClicks}`,
          `• Domain: ${domain}`,
        ].join('\n');
      }

      case 'create': {
        if (!command.path || !command.target) {
          return formatError(
            'Please specify path and target. Example: "create redirect from /twitter to https://twitter.com/user"',
          );
        }

        const check = checkToolPermission(permissions, 'create_route', domain);
        if (!check.allowed) {
          return formatPermissionDenied(check.message || 'Permission denied');
        }

        await client.createRoute(
          {
            path: command.path,
            type: command.type || 'redirect',
            target: command.target,
          },
          domain,
        );

        return formatRouteCreated({
          path: command.path,
          type: command.type || 'redirect',
          target: command.target,
          domain,
        });
      }

      case 'delete': {
        if (!command.path) {
          return formatError(
            'Please specify a path to delete. Example: "delete /test"',
          );
        }

        const check = checkToolPermission(permissions, 'delete_route', domain);
        if (!check.allowed) {
          return formatPermissionDenied(check.message || 'Permission denied');
        }

        await client.deleteRoute(command.path, domain);
        return formatRouteDeleted(command.path);
      }

      case 'toggle': {
        if (!command.path) {
          return formatError('Please specify a path. Example: "disable /test"');
        }

        const check = checkToolPermission(permissions, 'toggle_route', domain);
        if (!check.allowed) {
          return formatPermissionDenied(check.message || 'Permission denied');
        }

        await client.toggleRoute(command.path, command.enabled ?? true, domain);
        const action = command.enabled ? 'enabled' : 'disabled';
        return `:white_check_mark: Route \`${command.path}\` has been ${action}.`;
      }

      default:
        return formatError(
          'Unknown command. Try "help" to see available commands.',
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Command execution failed',
        command,
        error: message,
      }),
    );
    return formatError(message);
  }
}

/**
 * Post a message to Slack
 *
 * @param botToken - Slack bot token
 * @param channel - Channel ID
 * @param text - Message text
 * @param threadTs - Thread timestamp (for replies)
 */
export async function postSlackMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  const body: Record<string, string> = {
    channel,
    text,
  };

  if (threadTs) {
    body.thread_ts = threadTs;
  }

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status}`);
  }

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }
}

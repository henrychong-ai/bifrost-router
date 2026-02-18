/**
 * Tool definitions for Bifrost
 *
 * These definitions are used by both the MCP server and Claude API.
 * They provide a unified interface for tool discovery and validation.
 */

import { SUPPORTED_DOMAINS, R2_BUCKETS } from './types.js';

/**
 * JSON Schema property definition
 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

/**
 * JSON Schema for tool input
 */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Base tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/**
 * Domain property schema (reused across tools)
 */
const domainProperty: JsonSchemaProperty = {
  type: 'string',
  description: `Target domain (e.g., 'link.henrychong.com'). Supported: ${SUPPORTED_DOMAINS.join(', ')}. Defaults to EDGE_ROUTER_DOMAIN env var if set.`,
  enum: [...SUPPORTED_DOMAINS],
};

/**
 * All tool definitions
 */
export const toolDefinitions: ToolDefinition[] = [
  // ===========================================================================
  // Route Management Tools
  // ===========================================================================
  {
    name: 'list_routes',
    description:
      'List all routes configured for a domain. Returns route paths, types, targets, and enabled status.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: domainProperty,
      },
    },
  },
  {
    name: 'get_route',
    description: 'Get detailed configuration for a specific route by its path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Route path starting with / (e.g., "/linkedin", "/blog/*")',
        },
        domain: domainProperty,
      },
      required: ['path'],
    },
  },
  {
    name: 'create_route',
    description:
      'Create a new route. Supports redirect (URL), proxy (fetch content), and r2 (serve from bucket) types.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Route path starting with / (e.g., "/github")',
        },
        type: {
          type: 'string',
          description:
            'Route type: redirect (URL change), proxy (fetch content), or r2 (serve from bucket)',
          enum: ['redirect', 'proxy', 'r2'],
        },
        target: {
          type: 'string',
          description: 'Target URL (for redirect/proxy) or R2 object key (for r2)',
        },
        statusCode: {
          type: 'number',
          description:
            'HTTP status code for redirects: 301 (permanent), 302 (temporary), 307/308 (preserve method)',
          enum: [301, 302, 307, 308],
        },
        preserveQuery: {
          type: 'boolean',
          description: 'Preserve query params on redirect (default: true)',
          default: true,
        },
        cacheControl: {
          type: 'string',
          description: 'Cache-Control header (e.g., "max-age=3600")',
        },
        hostHeader: {
          type: 'string',
          description:
            'Override Host header for proxy requests (e.g., "fusang.co" when proxying to cdn.webflow.com)',
        },
        bucket: {
          type: 'string',
          description: `R2 bucket for file serving (R2 only). Available: ${R2_BUCKETS.join(', ')}. Default: files`,
          enum: [...R2_BUCKETS],
        },
        domain: domainProperty,
      },
      required: ['path', 'type', 'target'],
    },
  },
  {
    name: 'update_route',
    description: 'Update an existing route. Only specified fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Route path to update (cannot be changed)',
        },
        type: {
          type: 'string',
          description: 'New route type',
          enum: ['redirect', 'proxy', 'r2'],
        },
        target: {
          type: 'string',
          description: 'New target URL or R2 key',
        },
        statusCode: {
          type: 'number',
          description: 'New HTTP status code for redirects',
          enum: [301, 302, 307, 308],
        },
        preserveQuery: {
          type: 'boolean',
          description: 'New preserve query setting',
        },
        cacheControl: {
          type: 'string',
          description: 'New Cache-Control header',
        },
        hostHeader: {
          type: 'string',
          description: 'New Host header override for proxy routes',
        },
        bucket: {
          type: 'string',
          description: `R2 bucket for file serving (R2 only). Available: ${R2_BUCKETS.join(', ')}`,
          enum: [...R2_BUCKETS],
        },
        domain: domainProperty,
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_route',
    description: 'Permanently delete a route. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Route path to delete',
        },
        domain: domainProperty,
      },
      required: ['path'],
    },
  },
  {
    name: 'toggle_route',
    description: 'Enable or disable a route without deleting it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Route path to toggle',
        },
        enabled: {
          type: 'boolean',
          description: 'Enable (true) or disable (false) the route',
        },
        domain: domainProperty,
      },
      required: ['path', 'enabled'],
    },
  },
  {
    name: 'migrate_route',
    description:
      'Migrate a route to a new path. Preserves configuration and original creation timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        oldPath: {
          type: 'string',
          description: 'Current route path to migrate from (e.g., "/old-link")',
        },
        newPath: {
          type: 'string',
          description: 'New route path to migrate to (e.g., "/new-link")',
        },
        domain: domainProperty,
      },
      required: ['oldPath', 'newPath'],
    },
  },

  // ===========================================================================
  // Analytics Tools
  // ===========================================================================
  {
    name: 'get_analytics_summary',
    description:
      'Get analytics overview including totals, top links, top pages, top countries, and time series data.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: domainProperty,
        days: {
          type: 'number',
          description: 'Time range in days (default: 30, max: 365)',
          minimum: 1,
          maximum: 365,
          default: 30,
        },
      },
    },
  },
  {
    name: 'get_clicks',
    description: 'Get paginated list of link clicks with filtering options.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: domainProperty,
        days: {
          type: 'number',
          description: 'Time range in days (default: 30)',
          minimum: 1,
          maximum: 365,
          default: 30,
        },
        limit: {
          type: 'number',
          description: 'Results per page (default: 50, max: 100)',
          minimum: 1,
          maximum: 100,
          default: 50,
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default: 0)',
          minimum: 0,
          default: 0,
        },
        slug: {
          type: 'string',
          description: 'Filter by specific slug (e.g., "/linkedin")',
        },
        country: {
          type: 'string',
          description: 'Filter by country code (2-letter ISO, e.g., "US", "SG")',
        },
      },
    },
  },
  {
    name: 'get_views',
    description: 'Get paginated list of page views with filtering options.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: domainProperty,
        days: {
          type: 'number',
          description: 'Time range in days (default: 30)',
          minimum: 1,
          maximum: 365,
          default: 30,
        },
        limit: {
          type: 'number',
          description: 'Results per page (default: 50, max: 100)',
          minimum: 1,
          maximum: 100,
          default: 50,
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default: 0)',
          minimum: 0,
          default: 0,
        },
        path: {
          type: 'string',
          description: 'Filter by specific path',
        },
        country: {
          type: 'string',
          description: 'Filter by country code (2-letter ISO)',
        },
      },
    },
  },
  {
    name: 'get_slug_stats',
    description:
      'Get detailed statistics for a specific link slug including clicks by day and top referrers.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Link slug (e.g., "/linkedin")',
        },
        domain: domainProperty,
        days: {
          type: 'number',
          description: 'Time range in days (default: 30)',
          minimum: 1,
          maximum: 365,
          default: 30,
        },
      },
      required: ['slug'],
    },
  },
];

/**
 * Get a tool definition by name
 */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find(t => t.name === name);
}

/**
 * Convert tool definitions to MCP SDK format
 * The MCP SDK expects `inputSchema` as JSON Schema
 */
export function toMCPTools(): ToolDefinition[] {
  // MCP SDK uses the same format as our base definition
  return toolDefinitions;
}

/**
 * Convert tool definitions to Claude API format
 * Claude API expects `input_schema` (snake_case) instead of `inputSchema`
 */
export function toClaudeTools(): Array<{
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}> {
  return toolDefinitions.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * Map of tool names to their categories
 */
export const toolCategories: Record<string, 'route' | 'analytics'> = {
  list_routes: 'route',
  get_route: 'route',
  create_route: 'route',
  update_route: 'route',
  delete_route: 'route',
  toggle_route: 'route',
  migrate_route: 'route',
  get_analytics_summary: 'analytics',
  get_clicks: 'analytics',
  get_views: 'analytics',
  get_slug_stats: 'analytics',
};

/**
 * Get tools by category
 */
export function getToolsByCategory(category: 'route' | 'analytics'): ToolDefinition[] {
  return toolDefinitions.filter(tool => toolCategories[tool.name] === category);
}

/**
 * Route management tools
 */
export const routeTools = getToolsByCategory('route');

/**
 * Analytics tools
 */
export const analyticsTools = getToolsByCategory('analytics');

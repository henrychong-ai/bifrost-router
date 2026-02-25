#!/usr/bin/env node
/**
 * MCP Server for Bifrost
 *
 * Provides AI-powered route management through the Model Context Protocol.
 * Supports Claude Code, Claude Desktop, and other MCP-compatible clients.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createClientFromEnv, toolDefinitions, type EdgeRouterClient } from '@bifrost/shared';

import {
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  toggleRoute,
  migrateRoute,
} from './tools/routes.js';

import { getAnalyticsSummary, getClicks, getViews, getSlugStats } from './tools/analytics.js';

import {
  listBuckets,
  listObjects,
  getObjectMeta,
  getObject,
  uploadObject,
  deleteObject,
  renameObject,
  moveObject,
  updateObjectMetadata,
} from './tools/storage.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Get default domain from environment
  const defaultDomain = process.env.EDGE_ROUTER_DOMAIN;

  // Create the Edge Router client
  let client: EdgeRouterClient;
  try {
    client = createClientFromEnv(process.env as Record<string, string | undefined>);
  } catch (error) {
    console.error(
      'Failed to initialize Edge Router client:',
      error instanceof Error ? error.message : String(error),
    );
    console.error('');
    console.error('Required environment variables:');
    console.error('  EDGE_ROUTER_API_KEY - Admin API key for authentication');
    console.error('');
    console.error('Optional environment variables:');
    console.error('  EDGE_ROUTER_URL     - Base URL (default: https://henrychong.com)');
    console.error('  EDGE_ROUTER_DOMAIN  - Default domain for operations');
    process.exit(1);
  }

  // Create the MCP server
  const server = new Server(
    {
      name: 'bifrost-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: toolDefinitions.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        // Route management tools
        case 'list_routes':
          result = await listRoutes(
            client,
            args as { domain?: string; search?: string; limit?: number; offset?: number },
            defaultDomain,
          );
          break;

        case 'get_route':
          result = await getRoute(client, args as { path: string; domain?: string }, defaultDomain);
          break;

        case 'create_route':
          result = await createRoute(
            client,
            args as {
              path: string;
              type: 'redirect' | 'proxy' | 'r2';
              target: string;
              statusCode?: number;
              preserveQuery?: boolean;
              preservePath?: boolean;
              cacheControl?: string;
              hostHeader?: string;
              forceDownload?: boolean;
              bucket?: string;
              domain?: string;
            },
            defaultDomain,
          );
          break;

        case 'update_route':
          result = await updateRoute(
            client,
            args as {
              path: string;
              type?: 'redirect' | 'proxy' | 'r2';
              target?: string;
              statusCode?: number;
              preserveQuery?: boolean;
              preservePath?: boolean;
              cacheControl?: string;
              hostHeader?: string;
              forceDownload?: boolean;
              bucket?: string;
              domain?: string;
            },
            defaultDomain,
          );
          break;

        case 'delete_route':
          result = await deleteRoute(
            client,
            args as { path: string; domain?: string },
            defaultDomain,
          );
          break;

        case 'toggle_route':
          result = await toggleRoute(
            client,
            args as { path: string; enabled: boolean; domain?: string },
            defaultDomain,
          );
          break;

        case 'migrate_route':
          result = await migrateRoute(
            client,
            args as { oldPath: string; newPath: string; domain?: string },
            defaultDomain,
          );
          break;

        // Analytics tools
        case 'get_analytics_summary':
          result = await getAnalyticsSummary(
            client,
            args as { domain?: string; days?: number },
            defaultDomain,
          );
          break;

        case 'get_clicks':
          result = await getClicks(
            client,
            args as {
              domain?: string;
              days?: number;
              limit?: number;
              offset?: number;
              slug?: string;
              country?: string;
            },
            defaultDomain,
          );
          break;

        case 'get_views':
          result = await getViews(
            client,
            args as {
              domain?: string;
              days?: number;
              limit?: number;
              offset?: number;
              path?: string;
              country?: string;
            },
            defaultDomain,
          );
          break;

        case 'get_slug_stats':
          result = await getSlugStats(
            client,
            args as { slug: string; domain?: string; days?: number },
            defaultDomain,
          );
          break;

        // Storage tools
        case 'list_buckets':
          result = await listBuckets(client);
          break;

        case 'list_objects':
          result = await listObjects(
            client,
            args as {
              bucket: string;
              prefix?: string;
              cursor?: string;
              limit?: number;
              delimiter?: string;
            },
          );
          break;

        case 'get_object_meta':
          result = await getObjectMeta(client, args as { bucket: string; key: string });
          break;

        case 'get_object':
          result = await getObject(
            client,
            args as { bucket: string; key: string; metadata_only?: boolean },
          );
          break;

        case 'upload_object':
          result = await uploadObject(
            client,
            args as {
              bucket: string;
              key: string;
              content_base64: string;
              content_type: string;
              overwrite?: boolean;
            },
          );
          break;

        case 'delete_object':
          result = await deleteObject(client, args as { bucket: string; key: string });
          break;

        case 'rename_object':
          result = await renameObject(
            client,
            args as { bucket: string; old_key: string; new_key: string },
          );
          break;

        case 'move_object':
          result = await moveObject(
            client,
            args as {
              bucket: string;
              key: string;
              destination_bucket: string;
              destination_key?: string;
            },
          );
          break;

        case 'update_object_metadata':
          result = await updateObjectMetadata(
            client,
            args as {
              bucket: string;
              key: string;
              content_type?: string;
              cache_control?: string;
              content_disposition?: string;
            },
          );
          break;

        default:
          return {
            content: [
              {
                type: 'text',
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }

      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error executing ${name}: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Set up stdio transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup (to stderr to avoid interfering with stdio protocol)
  console.error('Bifrost MCP server started');
  if (defaultDomain) {
    console.error(`Default domain: ${defaultDomain}`);
  }
}

// Run the server
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

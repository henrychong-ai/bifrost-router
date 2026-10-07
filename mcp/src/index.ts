#!/usr/bin/env node

/**
 * MCP Server for Bifrost
 *
 * Provides AI-powered route management through the Model Context Protocol.
 * Supports Claude Code, Claude Desktop, and other MCP-compatible clients.
 */

import { createClientFromEnv, type EdgeRouterClient, toolDefinitions } from '@bifrost/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { warnIgnoredEnv } from './boot-warnings.js';
import { callTool, isKnownTool } from './dispatch.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Create the Edge Router client
  let client: EdgeRouterClient;
  try {
    client = createClientFromEnv(process.env);
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
    console.error('  EDGE_ROUTER_URL     - Base URL (default: https://example.com)');
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

  // Register tool execution handler. The arguments are raw JSON-RPC: they
  // are read as unknown and validated with each tool's shared schema before a
  // handler sees them (dispatch.ts, v1.38.0), never cast.
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name } = request.params;
    if (!isKnownTool(name)) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await callTool(client, name, request.params.arguments);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Set up stdio transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log startup (to stderr to avoid interfering with stdio protocol)
  console.error('Bifrost MCP server started');
  // A removed variable left behind in an operator's config is never a startup
  // failure, but it must not be silent either. See mcp/src/boot-warnings.ts.
  warnIgnoredEnv(process.env, m => console.error(m));
}

// Run the server
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

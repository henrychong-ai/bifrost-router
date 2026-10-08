#!/usr/bin/env node

/**
 * MCP Server for Bifrost
 *
 * Provides AI-powered route management through the Model Context Protocol.
 * Supports Claude Code, Claude Desktop, and other MCP-compatible clients.
 */

import { createClientFromEnv, type EdgeRouterClient } from '@bifrost/shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { warnIgnoredEnv } from './boot-warnings.js';
import { createServer } from './server.js';

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

  const server = createServer(client);

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

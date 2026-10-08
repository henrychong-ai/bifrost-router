/**
 * The MCP server itself (v1.40.0: out of index.ts, so a test can connect a
 * client to it over an in-memory transport and check what goes on the wire).
 */
import { readFileSync } from 'node:fs';
import { type EdgeRouterClient, isRecord, toolDefinitions } from '@bifrost/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, isKnownTool } from './dispatch.js';

/** The version the server reports when its package.json cannot be read. */
export const UNKNOWN_SERVER_VERSION = '0.0.0';

/**
 * This package's own version, from its package.json (v1.40.0; the server used
 * to report a fixed `1.0.0`). The file sits one level above both `src/` and
 * `dist/`, and npm always ships it. Read as unknown and checked.
 */
export function serverVersion(
  read: () => string = () => readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
): string {
  try {
    const parsed: unknown = JSON.parse(read());
    if (isRecord(parsed) && typeof parsed['version'] === 'string' && parsed['version'] !== '') {
      return parsed['version'];
    }
  } catch {
    // Unreadable or not JSON: the fallback below
  }
  return UNKNOWN_SERVER_VERSION;
}

/**
 * Whether a tool's answer is a refusal (v1.40.0). Every refusal and failure a
 * handler or the dispatcher returns begins with `Error` and then `:` or a
 * space (`Error: No domain specified…`, `Error creating route: …`); no
 * successful answer does, since each starts with its own heading.
 */
export function isRefusal(text: string): boolean {
  return /^Error[: ]/.test(text);
}

/** The MCP result of one tool answer: a refusal is `isError: true`. */
export function toolResult(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
} {
  return {
    content: [{ type: 'text', text }],
    ...(isRefusal(text) && { isError: true as const }),
  };
}

/** The Bifrost MCP server for `client`, not yet connected to a transport. */
export function createServer(client: EdgeRouterClient): Server {
  const server = new Server(
    { name: 'bifrost-mcp', version: serverVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  // The arguments are raw JSON-RPC: they are read as unknown and validated
  // with each tool's shared schema before a handler sees them (dispatch.ts,
  // v1.38.0), never cast. A refusal (a missing domain, arguments that fail
  // the schema, an API error) goes back as `isError: true` (v1.40.0), so a
  // client sees it as a failed call, not as a result.
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name } = request.params;
    if (!isKnownTool(name)) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      return toolResult(await callTool(client, name, request.params.arguments));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return toolResult(`Error executing ${name}: ${errorMessage}`);
    }
  });

  return server;
}

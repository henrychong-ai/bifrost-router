/**
 * The MCP server on the wire (v1.40.0): a client connected over an in-memory
 * transport sees a refusal as a failed call (`isError: true`), a result as a
 * result, and the package's own version.
 */
import { readFileSync } from 'node:fs';
import type { EdgeRouterClient } from '@bifrost/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, isRefusal, serverVersion, UNKNOWN_SERVER_VERSION } from './server';
import { NO_DOMAIN_ERROR } from './tools/domain';

const DOMAIN = 'links.example.com';

/** A client whose listRoutes answers `routes`, or fails with `failure`. */
function apiClient(failure?: Error): EdgeRouterClient {
  return {
    listRoutes: async () => {
      if (failure) throw failure;
      return [];
    },
  } as unknown as EdgeRouterClient;
}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function connect(api: EdgeRouterClient): Promise<Client> {
  const server = createServer(api);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  close = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

describe('the MCP server on the wire', () => {
  it('reports the package version', async () => {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const client = await connect(apiClient());
    expect(client.getServerVersion()).toEqual({
      name: 'bifrost-mcp',
      version: (pkg as { version: string }).version,
    });
  });

  it('answers a refusal as a failed call', async () => {
    const client = await connect(apiClient());
    const answer = await client.callTool({ name: 'list_routes', arguments: {} });
    expect(answer).toEqual({
      content: [{ type: 'text', text: NO_DOMAIN_ERROR }],
      isError: true,
    });
  });

  it('answers invalid arguments and an API failure as failed calls', async () => {
    let client = await connect(apiClient());
    const invalid = await client.callTool({
      name: 'get_route',
      arguments: { domain: DOMAIN, path: 42 },
    });
    expect(invalid.isError).toBe(true);
    await close?.();

    client = await connect(apiClient(new Error('HTTP 500')));
    const failed = await client.callTool({ name: 'list_routes', arguments: { domain: DOMAIN } });
    expect(failed).toEqual({
      content: [{ type: 'text', text: 'Error listing routes: HTTP 500' }],
      isError: true,
    });
  });

  it('answers a result without isError', async () => {
    const client = await connect(apiClient());
    const answer = await client.callTool({ name: 'list_routes', arguments: { domain: DOMAIN } });
    expect(answer).toEqual({
      content: [{ type: 'text', text: `No routes configured for ${DOMAIN}` }],
    });
  });

  it('answers an unknown tool as a failed call', async () => {
    const client = await connect(apiClient());
    expect(await client.callTool({ name: 'no_such_tool', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'Unknown tool: no_such_tool' }],
      isError: true,
    });
  });
});

describe('isRefusal', () => {
  it('reads an Error prefix followed by a colon or a space only', () => {
    expect(isRefusal('Error: No domain specified.')).toBe(true);
    expect(isRefusal('Error creating route: HTTP 409')).toBe(true);
    expect(isRefusal('Errors for links.example.com')).toBe(false);
    expect(isRefusal('Routes for links.example.com (0 total):')).toBe(false);
  });
});

describe('serverVersion', () => {
  it('falls back when package.json is unreadable or has no version', () => {
    for (const read of [
      () => {
        throw new Error('ENOENT');
      },
      () => 'not json',
      () => '{"name":"x"}',
      () => '{"version":""}',
    ]) {
      expect(serverVersion(read)).toBe(UNKNOWN_SERVER_VERSION);
    }
    expect(serverVersion(() => '{"version":"9.9.9"}')).toBe('9.9.9');
  });
});

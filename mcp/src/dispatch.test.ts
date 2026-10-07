/**
 * The MCP dispatcher (v1.38.0): JSON-RPC arguments are read as unknown and
 * validated with each tool's shared schema before a handler runs; nothing is
 * cast and a refused call reaches no client method.
 */
import { DeleteRouteInputSchema, type EdgeRouterClient, toolDefinitions } from '@bifrost/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, isKnownTool } from './dispatch';
import { NO_DOMAIN_ERROR } from './tools/routes';

const DOMAIN = 'links.example.com';

let client: EdgeRouterClient;
let calls: Array<{ method: string; args: unknown[] }>;

beforeEach(() => {
  calls = [];
  // Any client method a handler reaches is recorded and resolves with nothing
  client = new Proxy(
    {},
    {
      get: (_target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return vi.fn<(...args: unknown[]) => Promise<unknown>>(async (...args) => {
          calls.push({ method, args });
          return method === 'listRoutes' ? [] : undefined;
        });
      },
    },
  ) as EdgeRouterClient;
});

describe('callTool validates the raw arguments with the shared schema', () => {
  it.each([
    ['get_route', { path: 42, domain: DOMAIN }],
    ['delete_route', { path: ['/x'], domain: DOMAIN }],
    ['toggle_route', { path: '/x', enabled: 'maybe', domain: DOMAIN }],
    ['create_route', { path: '/x', type: 'script', target: 'x', domain: DOMAIN }],
    ['migrate_route', { oldPath: '/a', newPath: 7, domain: DOMAIN }],
    ['get_qr', { id: 5, domain: DOMAIN }],
    ['list_objects', { bucket: 'not-a-bucket' }],
  ])('refuses %s with a non-conforming argument, sending nothing', async (name, args) => {
    const result = await callTool(client, name, args);
    expect(result).toMatch(new RegExp(`^Error: invalid arguments for ${name}: `));
    expect(calls).toEqual([]);
  });

  it('names the failing field', async () => {
    expect(await callTool(client, 'get_route', { path: 42, domain: DOMAIN })).toMatch(
      /^Error: invalid arguments for get_route: path: /,
    );
  });

  it('keeps the actionable no-domain error, before any other check', async () => {
    for (const args of [undefined, null, 'x', {}, { path: 42 }, { domain: '' }]) {
      expect(await callTool(client, 'list_routes', args)).toBe(NO_DOMAIN_ERROR);
    }
    expect(await callTool(client, 'transfer_route', { path: '/x', from_domain: DOMAIN })).toMatch(
      /transfer_route is missing to_domain/,
    );
    expect(calls).toEqual([]);
  });

  it('runs the handler with the parsed arguments', async () => {
    await callTool(client, 'delete_route', {
      path: '/p?x',
      domain: DOMAIN,
      recover_invalid: 'true',
    });
    expect(calls).toEqual([
      { method: 'deleteRoute', args: ['/p?x', DOMAIN, { recoverInvalid: true }] },
    ]);
    calls = [];
    await callTool(client, 'list_routes', { domain: DOMAIN, search: 'promo' });
    expect(calls).toEqual([{ method: 'listRoutes', args: [DOMAIN, 'promo'] }]);
  });

  it('an ordinary delete still takes the route-path rules', async () => {
    expect(await callTool(client, 'delete_route', { path: '/p?x', domain: DOMAIN })).toMatch(
      /^Error: invalid arguments for delete_route: path: /,
    );
    expect(calls).toEqual([]);
  });

  it('throws for an unknown tool', async () => {
    await expect(callTool(client, 'drop_tables', {})).rejects.toThrow('Unknown tool: drop_tables');
    expect(isKnownTool('drop_tables')).toBe(false);
    expect(isKnownTool('__proto__')).toBe(false);
  });

  it('every catalogue tool is dispatched', () => {
    const unknown = toolDefinitions.map(tool => tool.name).filter(name => !isKnownTool(name));
    expect(unknown).toEqual([]);
  });
});

describe('delete_route catalogue and schema parity (v1.38.0)', () => {
  it('the catalogue advertises exactly the fields the schema reads', () => {
    const catalogue = toolDefinitions.find(tool => tool.name === 'delete_route');
    expect(Object.keys(catalogue?.inputSchema.properties ?? {}).toSorted()).toEqual(
      Object.keys(DeleteRouteInputSchema.shape).toSorted(),
    );
  });
});

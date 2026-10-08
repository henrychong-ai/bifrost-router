/**
 * The MCP dispatcher (v1.38.0): JSON-RPC arguments are read as unknown and
 * validated with each tool's shared schema before a handler runs; nothing is
 * cast and a refused call reaches no client method.
 */
import { DeleteRouteInputSchema, type EdgeRouterClient, toolDefinitions } from '@bifrost/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, isKnownTool } from './dispatch';
import { NO_DOMAIN_ERROR } from './tools/domain';

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

/** The first value of `key` anywhere in the recorded client calls' arguments. */
function sentValue(key: string): unknown {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array)) {
      if (Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key];
      return visit(Object.values(value));
    }
    return undefined;
  };
  return visit(calls.map(call => call.args));
}

/**
 * Some MCP clients send every argument as a string. Before the dispatcher
 * validated arguments (v1.38.0) such numbers reached the query string and the
 * Worker coerced them; a stringified number or boolean is now parsed by the
 * tool schema itself (`mcpNumber`, `mcpBoolean`), never refused.
 */
describe('stringified numeric and boolean arguments keep working', () => {
  const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['get_analytics_summary', { days: '7' }, { days: 7 }],
    ['get_clicks', { days: '7', limit: '20', offset: '5' }, { days: 7, limit: 20, offset: 5 }],
    ['get_views', { days: '7', limit: '20', offset: '5' }, { days: 7, limit: 20, offset: 5 }],
    ['get_slug_stats', { slug: '/promo', domain: DOMAIN, days: '7' }, { days: 7 }],
    ['list_objects', { bucket: 'files', limit: '20' }, { limit: 20 }],
    ['list_qrs', { domain: DOMAIN, limit: '20', offset: '0' }, { limit: 20, offset: 0 }],
    ['get_route_qr', { domain: DOMAIN, path: '/promo', size: '512' }, { size: 512 }],
    [
      'create_route',
      {
        path: '/promo',
        type: 'redirect',
        target: 'https://example.net/',
        statusCode: '301',
        preserveQuery: 'false',
        preservePath: 'true',
        forceDownload: 'false',
        acknowledgeCredentialTarget: 'true',
        domain: DOMAIN,
      },
      {
        statusCode: 301,
        preserveQuery: false,
        preservePath: true,
        forceDownload: false,
        acknowledgeCredentialTarget: true,
      },
    ],
    [
      'update_route',
      {
        path: '/promo',
        statusCode: '308',
        preserveQuery: 'true',
        preservePath: 'false',
        forceDownload: 'true',
        acknowledgeCredentialTarget: 'false',
        domain: DOMAIN,
      },
      {
        statusCode: 308,
        preserveQuery: true,
        preservePath: false,
        forceDownload: true,
        acknowledgeCredentialTarget: false,
      },
    ],
    [
      'toggle_route',
      { path: '/promo', enabled: 'false', acknowledgeCredentialTarget: '1', domain: DOMAIN },
      { acknowledgeCredentialTarget: true },
    ],
    ['delete_route', { path: '/promo', domain: DOMAIN, recover_invalid: 'false' }, {}],
    [
      'transfer_route',
      {
        path: '/promo',
        from_domain: DOMAIN,
        to_domain: 'secondary.example.net',
        acknowledgeCredentialTarget: 'yes',
      },
      { acknowledgeCredentialTarget: true },
    ],
    ['get_object', { bucket: 'files', key: 'a.txt', metadata_only: 'true' }, {}],
    [
      'upload_object',
      { bucket: 'files', key: 'a.txt', content_base64: 'aGk=', overwrite: 'false' },
      { overwrite: false },
    ],
    ['update_qr', { id: 'promo', domain: DOMAIN, clearLinkedRoute: 'false' }, {}],
  ];

  it.each(CASES)('%s parses its stringified arguments', async (name, args, sent) => {
    const result = await callTool(client, name, args);
    expect(result).not.toMatch(/invalid arguments/);
    expect(calls.length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(sent)) expect(sentValue(key)).toBe(value);
  });

  it('reads the strings by value, never by truthiness', async () => {
    await callTool(client, 'toggle_route', { path: '/promo', enabled: 'false', domain: DOMAIN });
    expect(calls[0]?.args[1]).toBe(false);
    calls = [];
    await callTool(client, 'update_qr', { id: 'promo', domain: DOMAIN, clearLinkedRoute: 'false' });
    expect(sentValue('linkedRoute')).toBeUndefined();
    calls = [];
    await callTool(client, 'update_qr', { id: 'promo', domain: DOMAIN, clearLinkedRoute: 'true' });
    expect(sentValue('linkedRoute')).toBeNull();
  });

  it.each([
    ['get_clicks', { limit: '' }],
    ['get_clicks', { limit: 'twenty' }],
    ['get_clicks', { days: '7 days' }],
    ['get_clicks', { limit: '0x10' }],
    ['list_qrs', { domain: DOMAIN, limit: '1.5' }],
    ['get_route_qr', { domain: DOMAIN, path: '/promo', size: '99999' }],
    ['get_object', { bucket: 'files', key: 'a.txt', metadata_only: 'maybe' }],
  ])('still refuses %s %j, sending nothing', async (name, args) => {
    expect(await callTool(client, name, args)).toMatch(
      new RegExp(`^Error: invalid arguments for ${name}: `),
    );
    expect(calls).toEqual([]);
  });

  it('covers every numeric and boolean field the catalogue advertises', () => {
    const advertised = toolDefinitions.flatMap(tool =>
      Object.entries(tool.inputSchema.properties ?? {})
        .filter(([, field]) => ['number', 'integer', 'boolean'].includes(String(field.type)))
        .map(([field]) => `${tool.name}.${field}`),
    );
    const covered = new Set(
      CASES.flatMap(([name, args]) => Object.keys(args).map(key => `${name}.${key}`)),
    );
    expect(advertised.filter(field => !covered.has(field))).toEqual([]);
  });
});

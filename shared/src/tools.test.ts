import { describe, it, expect } from 'vitest';
import {
  toolDefinitions,
  getToolDefinition,
  toMCPTools,
  toClaudeTools,
  toolCategories,
  getToolsByCategory,
  routeTools,
  analyticsTools,
  storageTools,
  qrTools,
} from './tools.js';
import { SUPPORTED_DOMAINS } from './types.js';

describe('tools', () => {
  describe('toolDefinitions', () => {
    it('contains all route, analytics, and storage tools', () => {
      expect(toolDefinitions.length).toBe(
        routeTools.length + analyticsTools.length + storageTools.length + qrTools.length,
      );
    });

    it('has all expected route tools', () => {
      const names = toolDefinitions.map(t => t.name);
      expect(names).toContain('list_routes');
      expect(names).toContain('get_route');
      expect(names).toContain('create_route');
      expect(names).toContain('update_route');
      expect(names).toContain('delete_route');
      expect(names).toContain('toggle_route');
      expect(names).toContain('migrate_route');
      expect(names).toContain('transfer_route');
    });

    it('has all expected analytics tools', () => {
      const names = toolDefinitions.map(t => t.name);
      expect(names).toContain('get_analytics_summary');
      expect(names).toContain('get_clicks');
      expect(names).toContain('get_views');
      expect(names).toContain('get_slug_stats');
    });

    it('each tool has required fields', () => {
      for (const tool of toolDefinitions) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });
  });

  describe('getToolDefinition', () => {
    it('returns tool by name', () => {
      const tool = getToolDefinition('list_routes');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('list_routes');
    });

    it('returns undefined for unknown tool', () => {
      expect(getToolDefinition('unknown_tool')).toBeUndefined();
    });
  });

  describe('toMCPTools', () => {
    it('returns all tools in MCP format', () => {
      const mcpTools = toMCPTools();
      expect(mcpTools.length).toBe(toolDefinitions.length);

      // MCP uses inputSchema (camelCase)
      for (const tool of mcpTools) {
        expect(tool.inputSchema).toBeDefined();
      }
    });
  });

  describe('toClaudeTools', () => {
    it('returns all tools in Claude API format', () => {
      const claudeTools = toClaudeTools();
      expect(claudeTools.length).toBe(toolDefinitions.length);

      // Claude API uses input_schema (snake_case)
      for (const tool of claudeTools) {
        expect(tool.input_schema).toBeDefined();
        expect(tool.inputSchema).toBeUndefined();
      }
    });
  });

  describe('toolCategories', () => {
    it('maps route tools correctly', () => {
      expect(toolCategories.list_routes).toBe('route');
      expect(toolCategories.get_route).toBe('route');
      expect(toolCategories.create_route).toBe('route');
      expect(toolCategories.update_route).toBe('route');
      expect(toolCategories.delete_route).toBe('route');
      expect(toolCategories.toggle_route).toBe('route');
      expect(toolCategories.migrate_route).toBe('route');
    });

    it('maps analytics tools correctly', () => {
      expect(toolCategories.get_analytics_summary).toBe('analytics');
      expect(toolCategories.get_clicks).toBe('analytics');
      expect(toolCategories.get_views).toBe('analytics');
      expect(toolCategories.get_slug_stats).toBe('analytics');
    });

    it('maps storage tools correctly', () => {
      expect(toolCategories.list_buckets).toBe('storage');
      expect(toolCategories.list_objects).toBe('storage');
      expect(toolCategories.get_object_meta).toBe('storage');
      expect(toolCategories.get_object).toBe('storage');
      expect(toolCategories.upload_object).toBe('storage');
      expect(toolCategories.delete_object).toBe('storage');
      expect(toolCategories.rename_object).toBe('storage');
      expect(toolCategories.update_object_metadata).toBe('storage');
    });
  });

  describe('getToolsByCategory', () => {
    it('returns route tools', () => {
      const tools = getToolsByCategory('route');
      expect(tools.length).toBe(routeTools.length);
      for (const tool of tools) {
        expect(toolCategories[tool.name]).toBe('route');
      }
    });

    it('returns analytics tools', () => {
      const tools = getToolsByCategory('analytics');
      expect(tools.length).toBe(analyticsTools.length);
      for (const tool of tools) {
        expect(toolCategories[tool.name]).toBe('analytics');
      }
    });

    it('returns storage tools', () => {
      const tools = getToolsByCategory('storage');
      expect(tools.length).toBe(storageTools.length);
      for (const tool of tools) {
        expect(toolCategories[tool.name]).toBe('storage');
      }
    });
  });

  describe('routeTools', () => {
    it('contains all route tools', () => {
      expect(routeTools.length).toBeGreaterThan(0);
      for (const tool of routeTools) {
        expect(toolCategories[tool.name]).toBe('route');
      }
    });
  });

  describe('analyticsTools', () => {
    it('contains all analytics tools', () => {
      expect(analyticsTools.length).toBeGreaterThan(0);
      for (const tool of analyticsTools) {
        expect(toolCategories[tool.name]).toBe('analytics');
      }
    });
  });

  describe('storageTools', () => {
    it('contains all storage tools', () => {
      expect(storageTools.length).toBe(11);
      for (const tool of storageTools) {
        expect(toolCategories[tool.name]).toBe('storage');
      }
    });

    it('has all expected storage tools', () => {
      const names = storageTools.map(t => t.name);
      expect(names).toContain('list_buckets');
      expect(names).toContain('list_objects');
      expect(names).toContain('get_object_meta');
      expect(names).toContain('get_object');
      expect(names).toContain('upload_object');
      expect(names).toContain('delete_object');
      expect(names).toContain('rename_object');
      expect(names).toContain('move_object');
      expect(names).toContain('update_object_metadata');
      expect(names).toContain('purge_cache');
    });
  });

  describe('v1.30.0 catalog pins', () => {
    it('exposes exactly 29 tools (8 route + 4 analytics + 11 storage + 6 qr)', () => {
      expect(toolDefinitions.length).toBe(29);
      expect(routeTools.length).toBe(8);
      expect(analyticsTools.length).toBe(4);
      expect(storageTools.length).toBe(11);
      expect(qrTools.length).toBe(6);
    });

    it('names the new v1.30.0 tools explicitly', () => {
      const names = toolDefinitions.map(t => t.name);
      expect(names).toContain('update_object_comment');
      for (const qrTool of [
        'list_qrs',
        'get_qr',
        'create_qr',
        'update_qr',
        'delete_qr',
        'get_route_qr',
      ]) {
        expect(names).toContain(qrTool);
      }
    });
  });
});

/**
 * v1.35.0 domain contract, pinned catalog-side.
 *
 * There is no hosted MCP server in this repo and the stdio server's low-level
 * `Server` validates nothing, so the JSON-Schema catalog is what a client
 * actually sees: it is the only machine-readable half of the contract, and the
 * handler guards (mcp/src/tools/routes.no-domain.test.ts) are the enforcement.
 * These assertions keep the two halves from drifting apart.
 */
describe('v1.35.0 domain contract (catalog)', () => {
  /** 7 route + 6 QR + get_slug_stats. */
  const REQUIRED_DOMAIN_TOOLS = [
    'list_routes',
    'get_route',
    'create_route',
    'update_route',
    'delete_route',
    'toggle_route',
    'migrate_route',
    'list_qrs',
    'get_qr',
    'create_qr',
    'update_qr',
    'delete_qr',
    'get_route_qr',
    'get_slug_stats',
  ] as const;

  /** The only three tools where an omitted domain means "all domains". */
  const OPTIONAL_DOMAIN_TOOLS = ['get_analytics_summary', 'get_clicks', 'get_views'] as const;

  it('pins the split at 14 required and 3 optional', () => {
    expect(REQUIRED_DOMAIN_TOOLS).toHaveLength(14);
    expect(OPTIONAL_DOMAIN_TOOLS).toHaveLength(3);
  });

  it.each(REQUIRED_DOMAIN_TOOLS)('%s requires an enumerated domain', name => {
    const tool = getToolDefinition(name);
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema;
    expect(schema?.required ?? []).toContain('domain');
    expect(schema?.properties.domain?.enum).toEqual([...SUPPORTED_DOMAINS]);
  });

  it('transfer_route requires both domains, enumerated', () => {
    const schema = getToolDefinition('transfer_route')?.inputSchema;
    expect(schema?.required ?? []).toEqual(
      expect.arrayContaining(['from_domain', 'to_domain', 'path']),
    );
    expect(schema?.properties.from_domain?.enum).toEqual([...SUPPORTED_DOMAINS]);
    expect(schema?.properties.to_domain?.enum).toEqual([...SUPPORTED_DOMAINS]);
  });

  it.each(OPTIONAL_DOMAIN_TOOLS)('%s keeps domain optional but enumerated', name => {
    const schema = getToolDefinition(name)?.inputSchema;
    // `required` may be absent entirely on these tools; either way domain is not in it.
    expect(schema?.required ?? []).not.toContain('domain');
    expect(schema?.properties.domain?.enum).toEqual([...SUPPORTED_DOMAINS]);
  });

  it('no catalog description mentions a default-domain environment variable', () => {
    const rendered = JSON.stringify(toolDefinitions);
    expect(rendered).not.toContain('EDGE_ROUTER_DOMAIN');
    expect(rendered).not.toContain('ADMIN_API_DOMAIN');
  });

  it('every tool carrying a domain property is covered by exactly one list', () => {
    const withDomain = toolDefinitions
      .filter(tool => 'domain' in tool.inputSchema.properties)
      .map(tool => tool.name)
      .sort();
    expect(withDomain).toEqual([...REQUIRED_DOMAIN_TOOLS, ...OPTIONAL_DOMAIN_TOOLS].slice().sort());
  });
});

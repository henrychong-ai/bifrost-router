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
} from './tools.js';

describe('tools', () => {
  describe('toolDefinitions', () => {
    it('contains all route and analytics tools', () => {
      expect(toolDefinitions.length).toBe(
        routeTools.length + analyticsTools.length,
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
});

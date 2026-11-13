import type * as SharedModule from '@bifrost/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The MCP page's text, rendered with the current module graph. */
async function renderMcpPage(): Promise<string> {
  const { McpPage } = await import('./mcp');
  return renderToStaticMarkup(<McpPage />);
}

describe('MCP page tool catalogue', () => {
  afterEach(() => {
    vi.doUnmock('@bifrost/shared');
    vi.resetModules();
  });

  it('shows a card per tool category, with its tool count', async () => {
    const html = await renderMcpPage();
    expect(html).toMatch(/QR Codes <span[^>]*>\(\d+\)<\/span>/);
    expect(html).toContain('create_qr');
    expect(html).toMatch(/Routes <span[^>]*>\(\d+\)<\/span>/);
  });

  it('leaves out a tool category that has no tools', async () => {
    vi.resetModules();
    vi.doMock('@bifrost/shared', async importOriginal => {
      const actual = await importOriginal<typeof SharedModule>();
      return {
        ...actual,
        getToolsByCategory: (category: Parameters<typeof actual.getToolsByCategory>[0]) =>
          category === 'qr' ? [] : actual.getToolsByCategory(category),
      };
    });
    const html = await renderMcpPage();
    expect(html).not.toMatch(/QR Codes <span[^>]*>\(\d+\)<\/span>/);
    expect(html).toMatch(/Routes <span[^>]*>\(\d+\)<\/span>/);
    expect(html).toContain('list_routes');
  });
});

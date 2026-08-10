import { describe, expect, it } from 'vitest';
import appSource from '@/App.tsx?raw';

describe('route-level code splitting', () => {
  const pageModules = [
    'dashboard',
    'routes',
    'storage',
    'qr-codes',
    'redirects',
    'views',
    'downloads',
    'proxy',
    'audit',
    'feedback',
    'mcp',
    'guide/guide',
    'changelog',
  ];

  it('keeps every routed page behind a static dynamic-import boundary', () => {
    expect(appSource).not.toContain("from '@/pages'");
    for (const pageModule of pageModules) {
      expect(appSource).toContain(`import('@/pages/${pageModule}')`);
    }
  });

  it('renders a shared fallback while a page chunk loads', () => {
    expect(appSource).toContain('<Suspense fallback={<PageFallback />}>');
  });
});

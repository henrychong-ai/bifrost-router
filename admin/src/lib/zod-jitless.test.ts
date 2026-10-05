import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isZodJitless } from '@/lib/zod-jitless';
import mainSource from '@/main.tsx?raw';
import viteConfigSource from '../../vite.config.ts?raw';

describe('zod jitless mode (v1.37.0)', () => {
  it('turns on jitless, so zod never probes eval under the CSP', () => {
    expect(z.config().jitless).toBe(true);
    expect(isZodJitless()).toBe(true);
  });

  it('reports false when zod is not jitless', () => {
    z.config({ jitless: false });
    try {
      expect(isZodJitless()).toBe(false);
    } finally {
      z.config({ jitless: true });
    }
  });

  it("is main.tsx's first import, ahead of every module that builds a schema", () => {
    const imports = mainSource.split('\n').filter(line => line.startsWith('import '));
    expect(imports[0]).toBe("import { isZodJitless } from '@/lib/zod-jitless';");
  });

  // Import order alone does not survive chunking: the build must keep zod and
  // this module in their own chunk, which every schema-building chunk imports.
  it('keeps zod and the jitless module together in the dedicated zod chunk', () => {
    expect(viteConfigSource).toContain("groups: [{ name: 'zod', test: ZOD_CHUNK }]");
    const literal = /const ZOD_CHUNK =\s*\/(.+)\/;/.exec(viteConfigSource)?.[1];
    expect(literal).toBeDefined();
    const zodChunk = new RegExp(literal!);
    const inChunk = [
      '/repo/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js',
      '/repo/admin/node_modules/zod/index.js',
      'C:\\repo\\node_modules\\zod\\v4\\classic\\schemas.js',
      '/repo/admin/src/lib/zod-jitless.ts',
    ];
    const outOfChunk = [
      '/repo/shared/dist/index.js',
      '/repo/node_modules/.pnpm/@hono+zod-openapi@1.0.0/node_modules/@hono/zod-openapi/dist/index.js',
      '/repo/admin/src/lib/api-client.ts',
      '/repo/admin/src/lib/zod-jitless.test.ts',
    ];
    // Lists, not booleans, so a failure names the module ids that missed.
    expect(inChunk.filter(id => !zodChunk.test(id))).toEqual([]);
    expect(outOfChunk.filter(id => zodChunk.test(id))).toEqual([]);
  });
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import path from 'path';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vite';
import { stripHtmlComments } from './src/lib/strip-html-comments';

// Read version from root package.json at build time
const rootPackageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf-8'),
) as { version: string };
const APP_VERSION = rootPackageJson.version;

/**
 * Middleware to expose Tailscale identity headers as a JSON endpoint.
 * When the admin dashboard is served via Tailscale Serve, these headers
 * are injected automatically by the Tailscale proxy.
 */
function tailscaleIdentityMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url === '/api/tailscale/identity') {
      const login = req.headers['tailscale-user-login'] as string | undefined;
      const name = req.headers['tailscale-user-name'] as string | undefined;
      const profilePic = req.headers['tailscale-user-profile-pic'] as string | undefined;

      const identity = {
        login: login || null,
        name: name || null,
        profilePic: profilePic || null,
        isAuthenticated: Boolean(login),
      };

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(identity));
      return;
    }
    next();
  };
}

/**
 * Vite plugin to add Tailscale identity endpoint middleware.
 * Works in both dev and preview servers.
 */
function tailscaleIdentityPlugin(): Plugin {
  return {
    name: 'tailscale-identity',
    configureServer(server) {
      server.middlewares.use(tailscaleIdentityMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(tailscaleIdentityMiddleware());
    },
  };
}

/** The zod package (plain or pnpm store path) and the module that configures it. */
const ZOD_CHUNK =
  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?zod[\\/]|[\\/]src[\\/]lib[\\/]zod-jitless\.ts$/;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), tailscaleIdentityPlugin(), stripHtmlComments()],
  define: {
    // Inject version at build time from root package.json
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // zod + the jitless config in one import-free chunk (v1.37.0). Chunk
        // evaluation order, not source import order, decides when the config
        // runs: imported chunks evaluate before the entry body, and by default
        // zod shares a chunk with @bifrost/shared's schemas, which trigger
        // zod's eval probe under the CSP before main.tsx's first import runs.
        // Every zod user imports this chunk, so jitless is set before any
        // schema is built (src/lib/zod-jitless.ts).
        codeSplitting: {
          groups: [{ name: 'zod', test: ZOD_CHUNK }],
        },
      },
    },
  },
  server: {
    port: 3001,
  },
  preview: {
    port: 3001,
  },
});

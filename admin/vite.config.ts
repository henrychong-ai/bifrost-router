import { defineConfig } from 'vite';
import type { Plugin, Connect } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

// Read version from root package.json at build time
const rootPackageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'),
);
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
      const profilePic = req.headers['tailscale-user-profile-pic'] as
        | string
        | undefined;

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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), tailscaleIdentityPlugin()],
  define: {
    // Inject version at build time from root package.json
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3001,
  },
  preview: {
    port: 3001,
  },
});

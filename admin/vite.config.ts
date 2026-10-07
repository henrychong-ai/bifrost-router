import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import path from 'path';
import type { Connect, Plugin } from 'vite';
import { defineConfig, loadEnv } from 'vite';
import {
  DEV_ENV_PREFIX,
  dashboardApiGuard,
  devApiProxy,
  isIdentityRequest,
  missingDevKeyWarning,
} from './dev-api-proxy';
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
    if (isIdentityRequest(req.url)) {
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
 * Vite plugin to add the Tailscale identity endpoint and the /api guard.
 * Works in both dev and preview servers. Identity first: it is answered
 * locally and never proxied.
 */
function dashboardServerPlugin(): Plugin {
  return {
    name: 'dashboard-server',
    configureServer(server) {
      server.middlewares.use(tailscaleIdentityMiddleware());
      server.middlewares.use(dashboardApiGuard());
    },
    configurePreviewServer(server) {
      server.middlewares.use(tailscaleIdentityMiddleware());
      server.middlewares.use(dashboardApiGuard());
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // One proxy config for the dev and preview servers, from admin/.env.local
  // (DASHBOARD_DEV_*; see dev-api-proxy.ts)
  const devEnv = loadEnv(mode, import.meta.dirname, DEV_ENV_PREFIX);
  const warning = command === 'serve' ? missingDevKeyWarning(devEnv) : null;
  if (warning) console.warn(warning);
  const proxy = devApiProxy(devEnv);
  return {
    plugins: [react(), tailwindcss(), dashboardServerPlugin(), stripHtmlComments()],
    define: {
      // Inject version at build time from root package.json
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    // No CORS on either server (v1.39.0): the dashboard calls its own origin,
    // so no other origin has a reason to read it, and Vite's default allows
    // any localhost origin
    server: {
      port: 3001,
      proxy,
      cors: false,
    },
    preview: {
      port: 3001,
      proxy,
      cors: false,
    },
  };
});

/// <reference types="vite/client" />

/**
 * Version injected at build time from root package.json
 * @see vite.config.ts define.APP_VERSION
 */
declare const __APP_VERSION__: string;

// No ImportMetaEnv entries (v1.39.0): the bundle reads no build-time variable.
// The `pnpm dev` proxy's settings (DASHBOARD_DEV_API_URL,
// DASHBOARD_DEV_ADMIN_API_KEY) are read by vite.config.ts in Node only, never
// by the bundle, so the key can never be inlined into a build.

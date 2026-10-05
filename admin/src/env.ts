import { z } from 'zod';

// Runtime env injected by container startup script (env-config.js).
// Falls back to VITE_ADMIN_API_KEY ONLY in development (pnpm dev): a production
// build never reads it, so a key in admin/.env.local cannot be inlined into the
// shipped bundle.
declare global {
  interface Window {
    __ENV__?: { ADMIN_API_KEY?: string };
  }
}

const ADMIN_API_KEY_REQUIRED =
  'ADMIN_API_KEY is required (production: the container ADMIN_API_KEY written to env-config.js at start; development: VITE_ADMIN_API_KEY in admin/.env.local)';

const envSchema = z.object({
  VITE_API_URL: z.string().url().default('https://example.com'),
  ADMIN_API_KEY: z.string({ error: ADMIN_API_KEY_REQUIRED }).min(1, ADMIN_API_KEY_REQUIRED),
});

// Parse and validate environment variables
export const env = envSchema.parse({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  // Runtime injection (production) takes precedence; the build-time variable is
  // a development-only fallback, gated on DEV so Vite drops it from a build.
  ADMIN_API_KEY:
    window.__ENV__?.ADMIN_API_KEY ??
    (import.meta.env.DEV ? import.meta.env.VITE_ADMIN_API_KEY : undefined),
});

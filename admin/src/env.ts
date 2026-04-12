import { z } from 'zod';

// Runtime env injected by container startup script (env-config.js).
// Falls back to import.meta.env for local dev (pnpm dev / .env file).
declare global {
  interface Window {
    __ENV__?: { ADMIN_API_KEY?: string };
  }
}

const envSchema = z.object({
  VITE_API_URL: z.string().url().default('https://example.com'),
  ADMIN_API_KEY: z
    .string()
    .min(
      1,
      'ADMIN_API_KEY is required (set via runtime env-config.js or VITE_ADMIN_API_KEY in .env)',
    ),
});

// Parse and validate environment variables
export const env = envSchema.parse({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  // Runtime injection (production) takes precedence over build-time env var (local dev)
  ADMIN_API_KEY: window.__ENV__?.ADMIN_API_KEY ?? import.meta.env.VITE_ADMIN_API_KEY,
});

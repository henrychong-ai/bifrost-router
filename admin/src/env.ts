import { z } from 'zod';

const envSchema = z.object({
  VITE_API_URL: z.string().url().default('https://henrychong.com'),
  VITE_ADMIN_API_KEY: z.string().min(1),
});

// Parse and validate environment variables
export const env = envSchema.parse({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  VITE_ADMIN_API_KEY: import.meta.env.VITE_ADMIN_API_KEY,
});

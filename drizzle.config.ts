import { defineConfig } from 'drizzle-kit';
import { globSync } from 'node:fs';

// Wrangler assigns a machine-local UUID to the Miniflare D1 file. Discover it
// instead of committing one developer's generated path. The environment
// variable remains available for unusual state layouts and CI tooling.
const [discoveredLocalDatabase] = globSync(
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite',
);
const localDatabase =
  process.env.BIFROST_LOCAL_D1_PATH ??
  discoveredLocalDatabase ??
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/bifrost-local.sqlite';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: localDatabase,
  },
});

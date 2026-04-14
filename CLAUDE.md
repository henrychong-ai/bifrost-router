# CLAUDE.md

Guidance for Claude Code when working with this repository.

**Version:** 1.22.5 | **Changelog:** [CHANGELOG.md](./CHANGELOG.md)

## Project Overview

**Bifrost** is an edge router built on Cloudflare Workers with the Hono framework. Dynamic routing via KV, supporting redirects, reverse proxying, and R2 bucket serving.

> **Setup & deployment:** See [README.md](README.md) for the Fork & Deploy guide.

## Monorepo Structure

| Package | Purpose |
|---------|---------|
| **Root** | Main edge router Worker (`src/`, `test/`) |
| **shared/** | Types, schemas, HTTP client (`@bifrost/shared`) |
| **mcp/** | MCP server for AI route management |
| **admin/** | React SPA dashboard (Vite + shadcn/ui) |
| **slackbot/** | Slack bot Worker for route management |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers, TypeScript, Hono |
| Storage | KV (routes), D1 (analytics), R2 (files) |
| Testing | Vitest + @cloudflare/vitest-pool-workers |
| Dashboard | React 19 + Vite + Tailwind CSS + TanStack Query |
| Linting | Oxlint (primary) + Biome (formatter) + residual ESLint (admin only) |

## Commands

```bash
pnpm run dev          # Local dev (localhost:8787)
pnpm run deploy       # Deploy to production
pnpm run deploy:dev   # Deploy to dev environment
pnpm run test         # Run tests
pnpm run lint         # Lint (oxlint)
pnpm run format       # Format (biome)
pnpm run format:check # Format check (CI)
pnpm run typecheck    # TypeScript check
pnpm run check        # All checks (lint + format + typecheck + test)
```

### Local Development

```bash
# Terminal 1: Worker
pnpm run dev

# Terminal 2: Dashboard
pnpm --filter admin dev  # Port 3001
```

**Config files:**
- `admin/.env`: `VITE_API_URL=http://localhost:8787`
- `.dev.vars`: `CLOUDFLARE_API_TOKEN` (for zone cache purge in local dev)

## Deployment

### Credentials (1Password)

```bash
CLOUDFLARE_API_TOKEN=$(op read "op://Your-Vault/Cloudflare/API-Token" --account your-1password-account) \
CLOUDFLARE_ACCOUNT_ID="your-cloudflare-account-id" \
pnpm run deploy
```

### CI/CD (GitHub Actions)

| Trigger | Actions |
|---------|---------|
| Push to any branch / PR | Lint → Format → Typecheck → Test |
| Version tag (`v*`) | Lint → Format → Typecheck → Test → Deploy Worker → Upload API Shield → Build & Deploy Dashboard |
| Manual dispatch | Same as version tag |

**Required Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `ADMIN_API_KEY`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`

### Cloudflare Resources

| Resource | ID |
|----------|-----|
| **Account** | `your-cloudflare-account-id` |
| **Zone** | `your-zone-id` (example.com) |
| **KV (prod)** | `your-kv-namespace-id` |
| **KV (dev)** | `your-kv-dev-namespace-id` |
| **D1** | `your-d1-database-id` |

**KV Key Format:** `{domain}:{path}` (e.g., `example.com:/linkedin`). Paths are always lowercase — `normalizePath()` applies `.toLowerCase()`.

### R2 Buckets

`files` (default), `assets`, `files-user1`, `files-user2`, `files-user3`, `files-user4`, `files-user5`, `files-user6`, `bifrost-backups`

## Supported Domains

Defined in `src/types.ts`:

| Domain | Purpose |
|--------|---------|
| `links.example.com` | Primary short links |
| `bifrost.example.com` | Admin API (protected) |
| `example.com` | Primary domain |
| `secondary.example.net` | Secondary domain |
| `user1.example.com` | User domain (pending) |
| `user2.example.com` | User domain (pending) |
| `user3.example.com` | User domain (pending) |
| `couple.example.com` | User domain (pending) |
| `user5.example.com` | User domain (pending) |

### Adding a New Supported Domain

Update **all 6 locations** — missing any one causes silent failures (routes rejected, MCP tools broken, API 403s, or domain missing from dashboard dropdown):

| # | File | What to update |
|---|------|----------------|
| 1 | `src/types.ts` | `SUPPORTED_DOMAINS` array — Worker-side route validation |
| 2 | `shared/src/types.ts` | `SUPPORTED_DOMAINS` array — MCP tool enums + admin form schemas. Rebuild with `pnpm -C shared build` after |
| 3 | `admin/src/context/filter-types.ts` | `SUPPORTED_DOMAINS` array — dashboard Domain filter dropdown (duplicates the shared list) |
| 4 | `openapi/bifrost-api.yaml` | `DomainQuery` enum — **API Shield (block mode) returns 403 for unknown domain values** |
| 5 | Cloudflare Dashboard | Add as Custom Domain on the Worker |
| 6 | `wrangler.toml` | Add service binding if domain uses Worker-to-Worker fallback |

A drift-detection test (`test/supported-domains-consistency.test.ts`) asserts that copies 1-4 stay in sync — CI will fail if they drift.

## Route Types

| Type | Handler | Description |
|------|---------|-------------|
| `redirect` | `handleRedirect` | URL redirect (301/302/307/308) |
| `proxy` | `handleProxy` | Reverse proxy to external URL |
| `r2` | `handleR2` | Serve from R2 bucket |

### Route Config Schema

```typescript
interface KVRouteConfig {
  path: string;            // "/github", "/blog/*"
  type: RouteType;         // "redirect" | "proxy" | "r2"
  target: string;          // Target URL or R2 key
  statusCode?: number;     // 301, 302, 307, 308
  preserveQuery?: boolean; // Default: true
  preservePath?: boolean;  // Default: false
  cacheControl?: string;
  hostHeader?: string;     // Override Host header (proxy)
  forceDownload?: boolean; // Force download (R2)
  bucket?: string;         // R2 bucket name
  enabled?: boolean;       // Default: true
}
```

## Admin API

**Base:** `https://bifrost.example.com/api`
**Auth:** `X-Admin-Key: <api_key>` or `Authorization: Bearer <key>`
**Access:** Protected network access only

| Endpoint | Description |
|----------|-------------|
| `GET /api/routes` | List routes (`?domain=&search=&limit=&offset=`) |
| `GET /api/routes?path=` | Get single route |
| `POST /api/routes` | Create route |
| `PUT /api/routes?path=` | Update route |
| `DELETE /api/routes?path=` | Delete route |
| `POST /api/routes/seed` | Bulk import routes |
| `POST /api/routes/migrate` | Migrate route to new path |
| `POST /api/routes/transfer` | Transfer route between domains |
| `POST /api/routes/normalize-case` | One-time migration: convert all route paths to lowercase |
| `GET /api/routes/by-target` | Find routes serving an R2 object |
| `GET /api/analytics/*` | Analytics endpoints |
| `GET /api/storage/buckets` | List R2 buckets |
| `GET /api/storage/:bucket/objects` | List objects |
| `GET /api/storage/:bucket/meta/:key` | Get object metadata |
| `GET /api/storage/:bucket/objects/:key` | Download object |
| `POST /api/storage/:bucket/upload` | Upload object |
| `DELETE /api/storage/:bucket/objects/:key` | Delete object |
| `POST /api/storage/:bucket/rename` | Rename object within bucket |
| `POST /api/storage/:bucket/move` | Move object to different bucket |
| `PUT /api/storage/:bucket/metadata/:key` | Update metadata |
| `POST /api/storage/:bucket/purge-cache/:key` | Purge CDN cache for object |

### Analytics Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/analytics/summary` | Dashboard overview |
| `GET /api/analytics/clicks` | Paginated click records |
| `GET /api/analytics/views` | Paginated view records |
| `GET /api/analytics/clicks/:slug` | Stats for specific link |

**Query params:** `domain`, `days` (1-365), `limit` (max 1000), `offset`, `slug`, `path`, `country`

## API Shield

**Status:** Active (block mode) on `example.com` zone
**Schema:** `openapi/bifrost-api.yaml` (OpenAPI 3.0.3)

The pipeline **automatically uploads** the OpenAPI schema to API Shield after every production deploy via `scripts/upload-api-shield.mjs`. The upload is non-fatal — if it fails, the Worker is already deployed and the schema can be uploaded manually.

**To update:** Edit schema → Validate → Tag and push (CI/CD deploys Worker + uploads schema)
**Fallback:** Upload via Cloudflare Dashboard → Security → API Shield

## Key Files

| File | Purpose |
|------|---------|
| `wrangler.toml` | Worker config, bindings, env vars |
| `src/index.ts` | Hono app entry point |
| `src/routes/admin.ts` | Admin API routes |
| `src/routes/storage.ts` | R2 storage management routes |
| `src/routes/analytics.ts` | Analytics API routes |
| `src/types.ts` | Domain list, route types |
| `src/utils/path-validation.ts` | R2 key validation (strict reject) |
| `openapi/bifrost-api.yaml` | API Shield schema |
| `scripts/upload-api-shield.mjs` | Auto-upload schema to API Shield (called by CI/CD) |

## MCP Server

**Package:** `@bifrost/mcp` - 22 tools (8 route + 4 analytics + 10 storage)

Config in `~/.claude.json`:
```json
{
  "bifrost": {
    "type": "stdio",
    "command": "op",
    "args": ["run", "--account", "your-1password-account", "--", "node", "/path/to/mcp/dist/index.js"],
    "env": {
      "EDGE_ROUTER_API_KEY": "op://Your-Vault/Cloudflare/ADMIN_API_KEY",
      "EDGE_ROUTER_URL": "https://bifrost.example.com",
      "EDGE_ROUTER_DOMAIN": "links.example.com"
    }
  }
}
```

## Backup System

### KV Routes (R2)

**Schedule:** Daily 8 PM UTC (4 AM SGT) via cron trigger
**Storage:** R2 bucket `bifrost-backups` → `daily/YYYYMMDD/`
**Contents:** KV routes as compressed NDJSON (`kv-routes.ndjson.gz`) + manifest (`manifest.json`)
**Retention:** Indefinite (~8KB/day, negligible storage)
**Manifest version:** 2.0.0

### D1 Analytics (Time Travel)

D1 analytics are **not** backed up to R2. Cloudflare D1 Time Travel provides automatic 30-day point-in-time recovery at minute-level granularity, at no extra cost.

**Database:** `bifrost-analytics` (`your-d1-database-id`)
**Region:** APAC
**Tables:** `link_clicks`, `page_views`, `file_downloads`, `proxy_requests`, `audit_logs`

**Restore via CLI:**
```bash
# Restore to a specific timestamp (RFC3339 or Unix seconds)
wrangler d1 time-travel restore bifrost-analytics --timestamp=2026-03-25T12:00:00Z

# Restore to a specific bookmark
wrangler d1 time-travel restore bifrost-analytics --bookmark=<bookmark-id>

# Get current bookmark
wrangler d1 time-travel info bifrost-analytics
```

**Note:** Restore is destructive (overwrites DB in place) but returns a bookmark to undo.

## Dashboard

React 19 SPA built with Vite 7, Tailwind CSS 4, shadcn/ui, TanStack Query, and React Router v7.

```bash
pnpm --filter admin dev      # Dev server on port 3001
pnpm --filter admin build    # Production build
pnpm -C admin lint           # Lint (oxlint + residual ESLint)
```

**Environment variables:** `VITE_API_URL` (API base URL), `VITE_ADMIN_API_KEY` (admin API key)

### Docker Container Architecture

The `:tailscale` image includes nginx (serves SPA on localhost:3001), tailscaled (userspace networking), and Tailscale Serve (proxies HTTPS). Authenticates to tailnet as `bifrost.your-tailnet.ts.net`.

| File | Purpose |
|------|---------|
| `admin/Dockerfile.tailscale` | Multi-stage build with Tailscale |
| `admin/docker-compose.tailscale.yml` | Production deployment config |
| `admin/scripts/start-with-tailscale.sh` | Container startup script |

## Implementation Notes

### Cross-Page Navigation (v1.16.2–v1.16.3)

Routes and storage dialogs link to each other for R2-type routes:

**Routes → Storage** (URL params): "View in Storage" pill button navigates to `/storage?bucket={bucket}&open={key}`. Storage page reads params, selects bucket, sets prefix for nested keys, and auto-opens the file's edit dialog. Params cleared with `replace: true` after consuming.

**Storage → Routes** (navigate state): Clicking an associated route row navigates to `/routes` with `{ state: { editRoute: routeObj } }`. Routes page reads `location.state.editRoute`, opens edit dialog, and clears state via `window.history.replaceState`.

### Domain Parameter Handling (v1.8.2)

When mutating routes, the dashboard passes the correct domain using a fallback pattern:
```typescript
domain: route.domain ?? filters.domain  // Fallback to active filter
```
Single-domain API responses include `domain` on each route, but the fallback ensures correct behaviour if the field is missing.

### API Client Query Parameters

All single-route operations use query parameters (not path parameters) to avoid URL encoding issues with special characters (`/`, `*`, etc.) in route paths.

### R2 Cache Purge

When "Purge Cache" is triggered from the storage edit dialog, the Worker uses the **Cloudflare Zone Cache Purge API** (`POST /zones/{zone_id}/purge_cache`) to globally invalidate CDN cache across all edge PoPs. URLs are collected from two sources:
1. **Bifrost KV routes** — all R2-type routes pointing to the object
2. **R2 custom domain URLs** — bucket-to-domain mapping in `src/types.ts`

Requires `CLOUDFLARE_API_TOKEN` Worker secret with **Zone > Cache Purge > Purge** permission. Without it, URLs are collected but not purged (graceful degradation). Set via:
```bash
wrangler secret put CLOUDFLARE_API_TOKEN
```
Use the same "API Token - Workers Edit" token from 1Password, after adding Cache Purge permission in the Cloudflare dashboard.

### Rate Limiting

Handled by **Cloudflare WAF**, not in Worker code. Worker-level middleware available at `src/middleware/rate-limit.ts` if needed.

### wrangler.toml Environment Inheritance

**NOT inherited** (must define per-environment):
- `[[kv_namespaces]]`, `[[d1_databases]]`, `[[r2_buckets]]`, `[vars]`

**IS inherited** (do NOT define per-environment):
- `[observability]`

### Linting Architecture

**Oxlint** (primary linter) with native plugins: import, promise, node, vitest, react, jsx-a11y. Config: `oxlint.json`.
**Biome** (formatter only, linter disabled). Config: `biome.json`.
**Residual ESLint** in admin/ only for `eslint-plugin-react-refresh` (Vite HMR). Uses `eslint-plugin-oxlint` to avoid rule duplication. Relaxed rules for `src/components/ui/` (shadcn generated code).

**Disabled Oxlint rules (intentional):**
- `vitest/require-mock-type-parameters` — `vi.fn()` calls in tests are typed via `as unknown as Type` casts; adding type params is redundant
- `react/hook-use-state` — `sidebar.tsx` uses `[_open, _setOpen]` (shadcn/ui internal state pattern); `filter-context.tsx` uses `[filters, setFiltersState]` to distinguish raw setter from wrapped API

### Dashboard architecture (not Workers Static Assets)

The dashboard is served via a Docker container (nginx + Tailscale), not via Cloudflare Workers Static Assets. The Worker has **no `[assets]` binding** and **no admin-domain SPA middleware** in `src/index.ts`.

If switching to Workers Static Assets in future, add a KV-route-precedence check (call `matchRoute()` first, fall through to the KV catch-all if a route exists; otherwise serve the SPA) to prevent KV-configured routes on admin domains from being masked by `index.html`.

## Versioning

1. Update `version` in `package.json`
2. Update `VERSION` in `wrangler.toml` `[vars]` section
3. Update `admin/package.json` version
4. Update version in this file header
5. **Update `CHANGELOG.md`** with new version entry
6. Commit, tag (`git tag v1.x.x`), and push with tags (`git push origin main --tags`)

**Deploy requires a version tag.** Push to main runs CI only. Production deploy (Worker + Dashboard) triggers on `v*` tags.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Setup & deployment:** See [README.md](README.md) for the Fork & Deploy guide, API reference, and tech stack.
> **Version history:** See [CHANGELOG.md](CHANGELOG.md).

## Project Overview

**Bifrost** is an edge router built on Cloudflare Workers with the Hono framework. It provides dynamic routing via Cloudflare KV, supporting redirects, reverse proxying, and R2 bucket serving. Check `package.json` for the current version.

**Monorepo packages:**

| Package | Path | Description |
|---------|------|-------------|
| Root Worker | `src/`, `test/` | Main edge router (Hono + Cloudflare Workers) |
| `@bifrost/shared` | `shared/` | Types, Zod schemas, EdgeRouterClient HTTP client |
| `@bifrost/mcp` | `mcp/` | MCP server for AI-powered route management (11 tools) |
| Admin Dashboard | `admin/` | React 19 SPA (Vite, Tailwind CSS, shadcn/ui, TanStack Query) |
| `@bifrost/slackbot` | `slackbot/` | Slack bot Worker for route management |

## Development Commands

```bash
pnpm run dev           # Local dev server (localhost:8787)
pnpm run test          # Run all tests (~450 across root, shared, mcp, slackbot)
pnpm run typecheck     # TypeScript check
pnpm run lint          # Lint all packages
pnpm run lint:fix      # Fix auto-fixable lint issues
pnpm run deploy        # Deploy to production
pnpm run deploy:dev    # Deploy to dev environment
pnpm run tail          # View production logs
```

**Build shared packages** (required after changing shared/ or mcp/):
```bash
pnpm -C shared build   # Must build BEFORE mcp
pnpm -C mcp build
```

**Admin dashboard:**
```bash
pnpm --filter admin dev       # Port 3001
pnpm --filter admin build
```

## Architecture

### Route Matching Flow

1. Request arrives at Cloudflare edge
2. Global middleware applied (logger, secureHeaders)
3. System routes checked (`/health`, `/api/*`)
4. KV route lookup via `matchRoute()` — exact match first, then wildcard
5. Dispatch to handler based on route type (`redirect`, `proxy`, `r2`)
6. If no match and domain has service binding fallback → forward to bound Worker

### Domain Restriction

The admin API (`/api/*`) is only accessible from the domain set in `ADMIN_API_DOMAIN` env var. Requests to `/api/*` from any other domain return 404 to hide the API's existence.

### KV Key Format

Routes are stored with domain-prefixed keys: `{domain}:{path}` (e.g., `example.com:/github`).

### Latency Characteristics

| Scenario | Latency | Notes |
|----------|---------|-------|
| Cold request | ~200-250ms | Full KV lookup from origin |
| Warm request | ~30-90ms | KV edge cache hit |
| CPU time | ~3ms | Actual worker execution |

KV lookup dominates latency. Use 301 for permanent redirects (browser caches, bypasses worker on repeat visits).

## Conventions & Patterns

### Adding Admin API Endpoints

All admin routes live in `src/routes/admin.ts`. Follow the existing pattern:
1. Define a Zod schema for request validation
2. Add the route handler to the `adminRoutes` Hono app
3. Add corresponding tests in `test/routes/admin.test.ts`

### Adding Route Handlers

Route type handlers live in `src/handlers/`. Each exports a single handler function that receives the Hono context and route config.

### Security Requirements

When modifying proxy or R2 handling:
- **Proxy targets** must go through SSRF validation (`src/utils/url-validation.ts`) — blocks private/internal IPs
- **R2 keys** must be sanitised via path traversal protection (`src/utils/path-validation.ts`)
- **Auth comparisons** must use timing-safe comparison (`src/utils/crypto.ts`)

### Testing

Tests use **Vitest** with `@cloudflare/vitest-pool-workers`, which runs tests inside the Workers runtime with real KV, D1, and R2 bindings (via Miniflare).

**Key test utilities:**
- `test/fixtures.ts` — Pre-built route configs (`fixtures.redirectRoute`, `fixtures.proxyRoute`, `fixtures.r2Route`, etc.)
- `test/helpers.ts` — `seedRoute()`, `seedRoutes()`, `clearRoutes()` for KV setup; `TEST_DOMAIN` = `example.com`
- Tests access bindings via `import { env, SELF } from 'cloudflare:test'`
- Admin API test key: `test-api-key-12345` (set in `vitest.config.ts`)

**Test file structure mirrors `src/`:**
```
test/
├── fixtures.ts          # Shared test data
├── helpers.ts           # KV seeding utilities
├── handlers/            # redirect, proxy, r2 handler tests
├── kv/                  # KV lookup and CRUD tests
├── middleware/           # CORS, rate limiting tests
├── routes/              # Admin API and analytics API tests
└── utils/               # Security utility tests
```

### Domain Configuration

Domains are configured in `src/types.ts`:
- `SUPPORTED_DOMAINS` array — all domains the worker handles
- `R2_BUCKETS` array + `BUCKET_BINDINGS` map — R2 bucket configuration
- `DOMAIN_SERVICE_FALLBACK` — Worker-to-Worker fallback mapping
- `Bindings` type — must match `wrangler.toml` bindings

### Minimum Required Bindings

| Binding | Type | Required | Purpose |
|---------|------|----------|---------|
| `ROUTES` | KV | Yes | Route storage |
| `DB` | D1 | Yes | Analytics |
| `ADMIN_API_KEY` | Secret | Yes | Admin auth |
| R2 buckets | R2 | No | File serving |
| `BACKUP_BUCKET` | R2 | No | Daily backups |
| Service bindings | Service | No | Worker-to-Worker fallback |

## Rate Limiting

Rate limiting is handled by **Cloudflare WAF**, not in Worker code. Worker-level middleware is available at `src/middleware/rate-limit.ts` but inactive. To reactivate:

```typescript
// In src/routes/admin.ts
import { rateLimit } from '../middleware/rate-limit';
adminRoutes.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') { await next(); return; }
  return rateLimit({ maxRequests: 100, windowSeconds: 60 })(c, next);
});
```

## R2 Backup System

Automated daily backups via cron trigger at 20:00 UTC.

| Data | Format | Retention |
|------|--------|-----------|
| KV Routes | NDJSON + Gzip | 30 days (daily), 90 days (weekly/Sunday) |
| D1 Analytics | NDJSON + Gzip | 30 days (daily), 90 days (weekly/Sunday) |

## System Routes

| Path | Description |
|------|-------------|
| `/health` | Health check (returns JSON with status, version, timestamp) |
| `/api/*` | Admin API (domain-restricted, API key required) |

## Error Handling

- Invalid routes → 404 with hint to use admin API
- Admin API errors → structured JSON with `success: false`
- Unhandled errors → logged, return 500
- Development mode includes stack traces

## Version Policy

| Change Type | Version | Examples |
|-------------|---------|----------|
| Patch (Z) | x.y.**Z** | Bug fixes, typos, minor improvements |
| Minor (Y) | x.**Y**.0 | New features, non-breaking enhancements |
| Major (X) | **X**.0.0 | Breaking changes, architecture changes |

**Files to update:** `package.json` (version) and `wrangler.toml` (`VERSION` in `[vars]`).

## Project Structure

```
bifrost/                        # pnpm monorepo
├── src/
│   ├── index.ts                # Hono app entry point
│   ├── types.ts                # Bindings, domains, route types
│   ├── db/                     # D1: Drizzle schema, analytics writes, queries
│   ├── kv/                     # KV: route CRUD, lookup (exact + wildcard), Zod schemas
│   ├── handlers/               # redirect.ts, proxy.ts, r2.ts
│   ├── middleware/              # CORS, rate limiting
│   ├── utils/                  # crypto, url-validation, path-validation, kv-errors
│   └── routes/                 # admin.ts (CRUD API), analytics.ts (D1 queries)
├── test/                       # Mirrors src/ structure (see Testing section)
├── shared/src/                 # Types, schemas, EdgeRouterClient
├── mcp/src/                    # MCP server (tools/routes.ts, tools/analytics.ts)
├── admin/src/                  # React SPA (components, hooks, pages)
├── slackbot/src/               # Slack bot (events, auth, formatting)
├── drizzle/                    # 8 D1 migration SQL files (0000-0007)
├── openapi/                    # API Shield OpenAPI spec
└── wrangler.toml               # Worker config with placeholder IDs
```

---

*Built with Cloudflare Workers and Hono*

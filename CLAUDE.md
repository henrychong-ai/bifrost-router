# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Bifrost** is an edge router built on Cloudflare Workers with the Hono framework. It provides dynamic routing via Cloudflare KV, supporting redirects, reverse proxying, and R2 bucket serving. Version 1.11.3.

**Monorepo Structure:**
- **Root** - Main edge router Worker (src/, test/)
- **shared/** - Shared code package (types, schemas, HTTP client)
- **mcp/** - MCP server for AI-powered route management
- **admin/** - React SPA admin dashboard
- **slackbot/** - Slack bot Worker for route management via natural language

**Multi-Domain Support:**
- Configure your domains in `src/types.ts` (SUPPORTED_DOMAINS array)
- Routes stored in unified KV namespace with domain-prefixed keys

**Key Features:**
- KV-based dynamic route configuration
- Three route types: redirect, proxy, R2
- Admin API for route management
- Admin dashboard with Command Palette (Cmd+K)
- Query parameter preservation on redirects
- Path preservation for wildcard redirects
- Cache-Control headers for proxied content
- Environment-based configuration (dev/production)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript 5.9.3 |
| Framework | Hono 4.11.8 |
| Runtime | Cloudflare Workers |
| CLI | Wrangler 4.63.0 |
| Validation | Zod 4.3.6 |
| ORM | Drizzle ORM 0.45.1 |
| Testing | Vitest 3.1.0 + @cloudflare/vitest-pool-workers 0.8.0 (441 tests) |
| Storage | Cloudflare KV |
| Database | Cloudflare D1 (analytics) |
| Object Storage | Cloudflare R2 |
| Linting | ESLint 9.39.2 (flat config) + typescript-eslint 8.54.0 |
| Package Manager | pnpm 10.20.0 (workspaces) |
| Admin Dashboard | React 19.2.0 + Vite 7.3.1 + Tailwind CSS 4.1.18 + shadcn/ui |
| Admin State | TanStack Query 5.90.16 + React Hook Form 7.71.1 |
| Admin Routing | React Router 7.12.0 |
| Admin Charts | Recharts 3.6.0 |

## Development Commands

```bash
# Local development server
pnpm run dev

# Deploy to production (requires auth)
pnpm run deploy

# Deploy to dev environment
pnpm run deploy:dev

# TypeScript type checking
pnpm run typecheck

# Run tests (441 tests across root, shared, mcp, slackbot)
pnpm run test

# Lint all packages
pnpm run lint

# Fix lint issues
pnpm run lint:fix

# View production logs
pnpm run tail

# Build shared packages
pnpm -C shared build
pnpm -C mcp build

# Run tests for specific package
pnpm -C shared test
pnpm -C mcp test

# Admin dashboard development
pnpm --filter admin dev       # Port 3001
pnpm --filter admin build
```

## Deployment

### Authentication

Wrangler requires authentication with a scoped API token.

```bash
# Deploy with environment variables
CLOUDFLARE_API_TOKEN="your-token" \
CLOUDFLARE_ACCOUNT_ID="your-account-id" \
pnpm run deploy
```

### Setting Secrets

```bash
# Set ADMIN_API_KEY secret
wrangler secret put ADMIN_API_KEY
# Enter your secure API key when prompted
```

## Project Structure

```
bifrost/                               # pnpm monorepo
├── pnpm-workspace.yaml                # Workspace configuration
├── package.json                       # Root package (main Worker)
├── eslint.config.js                   # ESLint 9 flat config
├── vitest.config.ts                   # Vitest configuration
├── wrangler.toml                      # Cloudflare Worker configuration
├── tsconfig.json                      # TypeScript configuration
│
├── src/                               # Main edge router Worker
│   ├── index.ts                       # Hono app entry point
│   ├── types.ts                       # TypeScript types (Bindings, RouteConfig)
│   ├── db/                            # D1 database operations
│   │   ├── index.ts                   # Drizzle ORM setup
│   │   ├── schema.ts                  # D1 table schemas (link_clicks, page_views)
│   │   ├── analytics.ts               # Analytics write operations
│   │   └── queries.ts                 # Analytics query functions
│   ├── kv/                            # KV storage operations
│   │   ├── index.ts                   # KV exports
│   │   ├── lookup.ts                  # Route matching (exact + wildcard)
│   │   ├── routes.ts                  # CRUD operations for routes
│   │   └── schema.ts                  # Zod schemas for validation
│   ├── handlers/                      # Route type handlers
│   │   ├── redirect.ts                # URL redirect (301/302/307/308)
│   │   ├── proxy.ts                   # Reverse proxy (with SSRF protection)
│   │   └── r2.ts                      # R2 serving (with path traversal protection)
│   ├── middleware/                    # Middleware
│   │   ├── cors.ts                    # CORS middleware
│   │   └── rate-limit.ts              # Rate limiting (available, WAF handles prod)
│   ├── utils/                         # Security utilities
│   │   ├── crypto.ts                  # Timing-safe comparison
│   │   ├── url-validation.ts          # SSRF protection
│   │   ├── path-validation.ts         # Path traversal protection
│   │   └── kv-errors.ts               # Typed KV error handling
│   └── routes/
│       ├── admin.ts                   # Admin API (CRUD for routes)
│       └── analytics.ts               # Analytics API (D1 queries)
│
├── test/                              # Test files (root package)
│   ├── fixtures.ts                    # Test fixtures and mocks
│   ├── helpers.ts                     # Test utilities
│   ├── handlers/                      # Handler tests
│   ├── kv/                            # KV operation tests
│   ├── middleware/                    # Middleware tests
│   ├── routes/                        # Route tests
│   └── utils/                         # Utility tests
│
├── shared/                            # @bifrost/shared
│   ├── package.json
│   └── src/
│       ├── index.ts                   # Public exports
│       ├── client.ts                  # EdgeRouterClient HTTP client
│       ├── types.ts                   # Shared TypeScript types
│       └── schemas.ts                 # Zod validation schemas
│
├── mcp/                               # @bifrost/mcp
│   ├── package.json
│   ├── README.md                      # MCP installation guide
│   └── src/
│       ├── index.ts                   # MCP server entry point
│       └── tools/                     # Tool implementations
│           ├── routes.ts              # Route management (6 tools)
│           └── analytics.ts           # Analytics queries (4 tools)
│
├── admin/                             # React SPA dashboard
│   ├── package.json
│   ├── Dockerfile
│   └── src/
│       ├── components/                # UI components (shadcn/ui)
│       ├── hooks/                     # TanStack Query hooks
│       └── pages/                     # Route pages
│
├── slackbot/                          # @bifrost/slackbot
│   ├── package.json
│   ├── wrangler.toml
│   └── src/
│       ├── index.ts                   # Hono Worker entry point
│       ├── slack/                     # Slack integration
│       │   ├── verify.ts              # Signature verification
│       │   ├── events.ts              # Event handlers
│       │   └── format.ts              # Message formatting
│       └── auth/                      # Permission system
│           ├── types.ts               # Permission types
│           └── permissions.ts         # Permission checking
│
└── drizzle/                           # D1 migrations
```

## Architecture

### Route Matching Flow

1. Request arrives at edge
2. Global middleware applied (logger, secureHeaders)
3. System routes checked (`/health`, `/api/*`)
4. KV route lookup via `matchRoute()`
   - Exact path match first
   - Wildcard pattern match second
5. Dispatch to handler based on route type
6. Error handling returns JSON response

### Route Types

| Type | Handler | Description |
|------|---------|-------------|
| `redirect` | `handleRedirect` | URL redirect with configurable status code |
| `proxy` | `handleProxy` | Reverse proxy to external URL |
| `r2` | `handleR2` | Serve content from R2 bucket |

### KV Route Configuration

```typescript
interface KVRouteConfig {
  path: string;           // "/github", "/blog/*"
  type: RouteType;        // "redirect" | "proxy" | "r2"
  target: string;         // Target URL or R2 key
  statusCode?: number;    // 301, 302, 307, 308 (redirects only)
  preserveQuery?: boolean; // Preserve query params (default: true)
  preservePath?: boolean;  // Preserve path for wildcards (default: false)
  cacheControl?: string;  // Cache-Control header
  enabled?: boolean;      // Enable/disable route (default: true)
  createdAt: number;      // Creation timestamp
  updatedAt: number;      // Last update timestamp
}
```

### Latency Characteristics

| Scenario | End-to-End Latency | Notes |
|----------|-------------------|-------|
| Cold request | ~200-250ms | Full KV lookup from origin |
| Warm request | ~30-90ms | KV edge cache hit |
| CPU time | ~3ms | Actual worker execution |

KV lookup is the dominant latency factor. Consider 301 redirects for permanent links (browser caches, bypasses worker on repeat visits).

## Admin API

**Domain Restriction:** The admin API is only accessible from the domain specified in `ADMIN_API_DOMAIN` env var. Requests from all other domains return 404 to hide the API's existence and reduce attack surface.

All admin endpoints require `X-Admin-Key` header or `Authorization: Bearer <key>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/routes` | List all routes with metadata |
| GET | `/api/routes/:path` | Get single route (URL-encoded path) |
| POST | `/api/routes` | Create new route |
| PUT | `/api/routes/:path` | Update existing route |
| DELETE | `/api/routes/:path` | Delete route |
| POST | `/api/routes/migrate` | Migrate route to new path |
| POST | `/api/routes/seed` | Bulk seed routes |

### Analytics API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/summary` | Dashboard overview (totals, top items, time series) |
| GET | `/api/analytics/clicks` | Paginated list of link clicks |
| GET | `/api/analytics/views` | Paginated list of page views |
| GET | `/api/analytics/clicks/:slug` | Stats for specific link slug |

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `domain` | string | all | Filter by domain |
| `days` | number | 30 | Time range (1-365) |
| `limit` | number | 100 | Results per page (max 1000) |
| `offset` | number | 0 | Pagination offset |
| `slug` | string | - | Filter clicks by slug |
| `path` | string | - | Filter views by path |
| `country` | string | - | Filter by country code (2-letter ISO) |

### Example: Create Route

```bash
curl -X POST https://bifrost.example.com/api/routes \
  -H "X-Admin-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/github",
    "type": "redirect",
    "target": "https://github.com/your-username",
    "statusCode": 302
  }'
```

## Rate Limiting

Rate limiting is handled by **Cloudflare WAF**, not in Worker code.

**Worker-level rate limiting middleware** is available at `src/middleware/rate-limit.ts` but not currently active. To reactivate if WAF is unavailable:

```typescript
// In src/routes/admin.ts, add import:
import { rateLimit } from '../middleware/rate-limit';

// Add middleware after auth:
adminRoutes.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }
  return rateLimit({ maxRequests: 100, windowSeconds: 60 })(c, next);
});
```

## MCP Server

The `@bifrost/mcp` package provides AI-powered route management through Claude Code, Claude Desktop, and other MCP-compatible clients.

### Features

- **11 Tools** - 7 route management + 4 analytics
- **Multi-domain support** - Manage all domains through natural language
- **Type-safe** - Zod validation for all inputs

### Available Tools

| Tool | Description |
|------|-------------|
| `list_routes` | List all routes for a domain |
| `get_route` | Get specific route details |
| `create_route` | Create redirect/proxy/R2 route |
| `update_route` | Modify existing route |
| `delete_route` | Delete a route |
| `toggle_route` | Enable/disable a route |
| `migrate_route` | Migrate route to a new path |
| `get_analytics_summary` | Dashboard overview with totals |
| `get_clicks` | Paginated click records |
| `get_views` | Paginated view records |
| `get_slug_stats` | Detailed stats for specific link |

See `mcp/README.md` for installation and configuration.

## Slackbot

The `@bifrost/slackbot` package provides Slack-based route management through natural language commands.

### Features

- **Natural language commands** - "create redirect from /twitter to https://twitter.com/user"
- **Multi-domain support** - Manage routes across all configured domains
- **Permission system** - Per-user, per-domain access control (read/edit/admin)
- **Slack security** - HMAC-SHA256 signature verification with replay attack protection

### Permission Levels

| Level | Capabilities |
|-------|-------------|
| `read` | List routes, view analytics |
| `edit` | All read + create, update, toggle routes |
| `admin` | All edit + delete routes |

## ESLint Configuration

ESLint 9 flat config with TypeScript support. Uses `typescript-eslint` instead of deprecated `@typescript-eslint/eslint-plugin`.

```bash
pnpm run lint           # Check all packages
pnpm run lint:fix       # Fix auto-fixable issues
```

## Environment Setup

### wrangler.toml Configuration

```toml
name = "bifrost-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
workers_dev = false     # Disabled - using Custom Domains only
preview_urls = false    # Disabled - not using CI/CD preview deployments

# Unified KV namespace for all route configuration
# Key format: {domain}:{path}
[[kv_namespaces]]
binding = "ROUTES"
id = "your-kv-namespace-id"
preview_id = "your-kv-preview-id"

[observability]
[observability.logs]
enabled = true
head_sampling_rate = 1
persist = true
invocation_logs = true

[vars]
ENVIRONMENT = "production"
```

### Required Secrets

| Secret | Purpose |
|--------|---------|
| `ADMIN_API_KEY` | Admin API authentication |

## System Routes (Not in KV)

| Path | Description |
|------|-------------|
| `/health` | Health check endpoint (returns JSON with status, version, timestamp) |
| `/api/*` | Admin API routes (protected by API key) |

## Error Handling

- Invalid routes return 404 with hint to use admin API
- Admin API errors return structured JSON with `success: false`
- Unhandled errors logged to console, return 500
- Development mode includes error stack traces

## R2 Backup System

Automated daily backups of KV routes and D1 analytics to R2.

### Schedule

| Time | Timezone | Description |
|------|----------|-------------|
| **8:00 PM** | UTC | Cron trigger |

### Backup Contents

| Data Source | Format | Description |
|-------------|--------|-------------|
| **KV Routes** | NDJSON + Gzip | All routes from all domains |
| **D1 Analytics** | NDJSON + Gzip | Last 30 days from 5 tables |

### Retention Policy

| Type | Retention | Description |
|------|-----------|-------------|
| **Daily** | 30 days | All backups kept for 30 days |
| **Weekly** | 90 days | Sunday backups kept for 90 days |

## Version Policy

**Recommended:** Increment version number following semantic versioning:

| Change Type | Version | Examples |
|-------------|---------|----------|
| **Patch (Z)** | x.y.**Z** | Bug fixes, typo corrections, minor improvements |
| **Minor (Y)** | x.**Y**.0 | New features, non-breaking enhancements |
| **Major (X)** | **X**.0.0 | Breaking changes, architecture changes |

**Files to Update:**
1. `package.json` - Root package version
2. `wrangler.toml` - VERSION in `[vars]` section

## Version History

### v1.11.3 (2026-02-07)
- Fix: removed duplicate audit log entry on route migration (only 'migrate' recorded, not both 'update' and 'migrate')

### v1.11.2 (2026-02-07)
- Moved AuditAction schema to @bifrost/shared as single source of truth
- Added 'migrate' action to audit log UI (colour, icon, filter dropdown)
- Admin schemas now import AuditActionSchema/AuditLogSchema from shared

### v1.11.1 (2026-02-07)
- Inline path editing in admin dashboard edit dialog with migration confirmation
- AlertDialog component (shadcn/ui + @radix-ui/react-alert-dialog)
- Path changes in edit mode trigger migration workflow with warning dialog
- Dynamic tool count tests across all repos (no more hardcoded assertions)

### v1.11.0 (2026-02-07)
- Route migration feature: atomically move routes between paths preserving config and timestamps
- New API endpoint: `POST /api/routes/migrate?oldPath=...&newPath=...`
- MCP `migrate_route` tool (11 tools total)
- Admin dashboard: `useMigrateRoute` hook and API client method
- Shared client: `migrateRoute()` method on EdgeRouterClient
- AuditAction type extended with 'migrate'
- 9 new tests for migration (450 total)

### v1.10.3 (2026-02-07)
- Replace active CI/CD workflow with PR-only CI pipeline (lint + test + build)
- Rename ci-cd.yml to ci-cd.yml.example (template for forkers)

### v1.10.2 (2026-02-07)
- Non-breaking dependency upgrades (hono 4.11.8, zod 4.3.6, wrangler 4.63.0, typescript-eslint 8.54.0, @modelcontextprotocol/sdk 1.26.0, and admin UI deps)

### v1.10.1 (2026-02-05)
- Command Palette with Cmd+K for quick navigation

### v1.10.0 (2026-02-05)
- Open Graph Parser API with SSRF protection
- Link Preview component for redirect/proxy targets
- Keyboard shortcuts and Kbd UI component

### v1.9.x
- R2 streaming for large files
- Node 24 & ES2024 upgrade
- CI/CD pipeline enhancement

### v1.8.0
- Proxy Host Header Override (`hostHeader` option)

### v1.7.0
- API Shield Schema Validation

### v1.6.0
- R2 Backup Health Check System

### v1.5.0
- Force Download Option for R2 Routes

### v1.4.0
- Preserve Path Feature for Wildcard Redirects

### v1.3.0
- R2 Backup System

### v1.2.0
- Unified KV Architecture (single namespace)

### v1.0.0
- Initial public release
- Project renamed to Bifrost

---

*Built with Cloudflare Workers and Hono*

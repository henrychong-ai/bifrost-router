# Bifrost — Self-Hosted URL Shortener & Edge Router for Cloudflare Workers

<p align="center">
  <img src="https://assets.henrychong.com/bifrost/bifrost-logo-readme.png" alt="Bifrost Logo" width="600" />
</p>

> A free, self-hosted alternative to bit.ly and Rebrandly — built on Cloudflare Workers with zero server costs

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-728%20passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)

> **For full technical specifications and architecture details, see [CLAUDE.md](CLAUDE.md). For version history, see [CHANGELOG.md](CHANGELOG.md).**

A lightweight, high-performance edge router and URL shortener built on Cloudflare Workers and the Hono framework. Replace paid link shorteners like bit.ly, Rebrandly, and TinyURL with your own self-hosted solution. Manage URL redirects, reverse proxies, and R2 bucket file serving through a simple API — all configuration stored in Cloudflare KV for instant global propagation across 300+ edge locations.

### Why Bifrost?

| | **Bifrost** | **bit.ly / Rebrandly** | **YOURLS** | **Kutt** |
|---|---|---|---|---|
| **Cost** | Free (Cloudflare free tier) | $35-$300+/month | Free (self-hosted) | Free (self-hosted) |
| **Infrastructure** | Serverless (zero servers) | Managed SaaS | PHP + MySQL server | Node.js + Docker |
| **Latency** | ~30-90ms (edge cached) | ~100-200ms | ~200-500ms | ~100-300ms |
| **Global CDN** | 300+ Cloudflare locations | Yes | No (single server) | No (single server) |
| **Custom domains** | Unlimited | 1-10 (plan dependent) | 1 | Unlimited |
| **Reverse proxy** | Yes | No | No | No |
| **R2 file serving** | Yes | No | No | No |
| **API management** | Full REST API + MCP + Slack | REST API | REST API | REST API |
| **Setup time** | ~15 minutes | Instant (SaaS) | ~30 minutes | ~30 minutes |

## Features

- **Dynamic Routing** — Configure routes via API without redeployment
- **Three Route Types**:
  - `redirect` — URL redirects (301, 302, 307, 308)
  - `proxy` — Reverse proxy to external URLs
  - `r2` — Serve content from R2 buckets
- **KV-Powered** — Route changes propagate globally in seconds
- **Admin API** — Full CRUD operations with API key authentication, search, and pagination
- **Admin Dashboard** — React SPA with Command Palette (Cmd+K), filters, analytics, R2 Storage browser
- **MCP Server** — AI-powered route and R2 storage management via Claude Code/Desktop (19 tools)
- **Analytics** — D1-powered click and page view tracking
- **Wildcard Patterns** — Support for path patterns like `/blog/*`
- **R2 Storage Management** — Browse, upload, download, rename, and delete R2 objects via API and dashboard
- **R2 Backup System** — Automated daily backups with health monitoring
- **API Shield** — OpenAPI schema validation at the Cloudflare edge
- **Built on Hono** — Fast, lightweight, TypeScript-first

### Security Features

- **Multi-Domain Routing** — Single worker handles multiple custom domains
- **Domain-Restricted Admin API** — Admin API only accessible from designated domain
- **Timing-Safe Auth** — API key comparison resistant to timing attacks
- **SSRF Protection** — Blocks proxy requests to private/internal IPs
- **Path Traversal Protection** — R2 keys sanitized to prevent directory traversal
- **Rate Limiting** — Via Cloudflare WAF (Worker middleware available if needed)

### Project Structure

```
bifrost/                         # pnpm monorepo
├── src/                         # Main edge router Worker
├── shared/                      # Shared types, schemas, HTTP client
├── mcp/                         # MCP server for AI route management
├── admin/                       # React SPA admin dashboard
└── slackbot/                    # Slack bot for route management
```

## Fork & Deploy Guide

This repo is designed as a forkable template. Follow these steps to deploy your own instance.

### Prerequisites

- Node.js >= 24 (see `.nvmrc`)
- [pnpm](https://pnpm.io/) (`corepack enable && corepack prepare`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers enabled (free plan works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) authenticated (`wrangler login`)

### Step 1: Fork & Clone

```bash
# Fork via GitHub UI, then clone your fork
git clone https://github.com/YOUR-USERNAME/bifrost-router.git
cd bifrost-router
pnpm install
```

### Step 2: Create Cloudflare Resources

Run these commands to create the required Cloudflare resources. Save the IDs printed by each command.

```bash
# KV namespace for route storage
wrangler kv namespace create ROUTES
wrangler kv namespace create ROUTES --preview    # For local dev

# D1 database for analytics
wrangler d1 create bifrost-analytics

# R2 buckets (create only the ones you need)
wrangler r2 bucket create files              # Default file serving
wrangler r2 bucket create assets             # Brand/static assets
wrangler r2 bucket create bifrost-backups    # Automated backups
# Optional per-user buckets:
# wrangler r2 bucket create files-user1
# wrangler r2 bucket create files-user2
```

### Step 3: Configure wrangler.toml

Replace all placeholder IDs with the values from Step 2:

```toml
# KV namespace (paste your IDs)
[[kv_namespaces]]
binding = "ROUTES"
id = "paste-your-kv-namespace-id"
preview_id = "paste-your-kv-preview-id"

# D1 database (paste your ID)
[[d1_databases]]
binding = "DB"
database_name = "bifrost-analytics"
database_id = "paste-your-d1-database-id"

# R2 buckets (remove any you don't need)
[[r2_buckets]]
binding = "FILES_BUCKET"
bucket_name = "files"

[[r2_buckets]]
binding = "ASSETS_BUCKET"
bucket_name = "assets"

[[r2_buckets]]
binding = "BACKUP_BUCKET"
bucket_name = "bifrost-backups"

# Set your admin API domain
[vars]
ENVIRONMENT = "production"
ADMIN_API_DOMAIN = "bifrost.yourdomain.com"
```

Also update the `[env.dev]` section with your dev domain.

> **Tip:** Remove any R2 bucket bindings and service bindings you don't need. The worker only requires KV (ROUTES) and D1 (DB) as minimum bindings.

### Step 4: Configure Your Domains

Edit `src/types.ts` to list your domains:

```typescript
export const SUPPORTED_DOMAINS = [
  'yourdomain.com',
  'link.yourdomain.com',
  'bifrost.yourdomain.com',    // Admin API domain
] as const;
```

Also update the R2 bucket arrays and `BUCKET_BINDINGS` map if you changed the bucket configuration.

Then set up [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) in the Cloudflare Dashboard to route traffic from your domains to the worker.

### Step 5: Run Database Migrations

```bash
# Apply all migrations to production D1
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0000_large_slipstream.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0001_add_analytics_fields.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0002_analytics_indexes.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0003_add_query_string.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0004_file_downloads.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0005_proxy_requests.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0006_audit_logs.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0007_add_cache_status.sql

# For local dev, use --local instead of --remote
```

### Step 6: Set Secrets & Deploy

```bash
# Set your admin API key (you'll be prompted to enter it)
wrangler secret put ADMIN_API_KEY

# Deploy
pnpm run deploy
```

### Step 7: Verify

```bash
# Health check
curl https://bifrost.yourdomain.com/health

# Create your first route
curl -X POST https://bifrost.yourdomain.com/api/routes \
  -H "X-Admin-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "domain": "yourdomain.com",
    "path": "/github",
    "type": "redirect",
    "target": "https://github.com/YOUR-USERNAME",
    "statusCode": 302
  }'
```

### Optional: Admin Dashboard

The admin dashboard is a React SPA that connects to your Bifrost API.

```bash
# Create admin/.env.local
cat > admin/.env.local << 'EOF'
VITE_API_URL=https://bifrost.yourdomain.com
VITE_ADMIN_API_KEY=your-admin-api-key
EOF

# Development
pnpm --filter admin dev    # Runs on port 3001

# Production (Docker)
docker build \
  --build-arg VITE_API_URL=https://bifrost.yourdomain.com \
  --build-arg VITE_ADMIN_API_KEY=your-api-key \
  -f admin/Dockerfile \
  -t bifrost-dashboard:latest .
```

### Optional: MCP Server

The MCP server lets you manage routes through Claude Code or Claude Desktop using natural language.

```bash
# Build the MCP server
pnpm -C shared build
pnpm -C mcp build
```

Add to your Claude Code config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "node",
      "args": ["/absolute/path/to/bifrost-router/mcp/dist/index.js"],
      "env": {
        "EDGE_ROUTER_API_KEY": "your-admin-api-key",
        "EDGE_ROUTER_URL": "https://bifrost.yourdomain.com",
        "EDGE_ROUTER_DOMAIN": "yourdomain.com"
      }
    }
  }
}
```

See `mcp/README.md` for Claude Desktop setup and available tools.

### Optional: Slackbot

The Slackbot lets your team manage routes via Slack messages.

1. Create a [Slack App](https://api.slack.com/apps) with Events API enabled
2. Create a KV namespace for permissions: `wrangler kv namespace create SLACK_PERMISSIONS`
3. Update `slackbot/wrangler.toml` with your KV, D1 IDs and `EDGE_ROUTER_URL`
4. Set secrets:
   ```bash
   cd slackbot
   wrangler secret put SLACK_SIGNING_SECRET
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put ADMIN_API_KEY
   ```
5. Deploy: `wrangler deploy` (from `slackbot/` directory)

### Optional: CI/CD

A GitHub Actions template is provided at `.github/workflows/ci-cd.yml.example`.

1. Rename to `ci-cd.yml`
2. Add repository secrets:
   - `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Workers Edit scope
   - `CLOUDFLARE_ACCOUNT_ID` — Your Cloudflare account ID
   - `ADMIN_API_KEY` — For admin dashboard build

The active CI pipeline (`.github/workflows/ci.yml`) runs lint, typecheck, and tests on every PR.

## Usage

### Add a Redirect

```bash
curl -X POST https://bifrost.yourdomain.com/api/routes \
  -H "X-Admin-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/github",
    "type": "redirect",
    "target": "https://github.com/your-username"
  }'
```

### Add a Proxy

```bash
curl -X POST https://bifrost.yourdomain.com/api/routes \
  -H "X-Admin-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/blog/*",
    "type": "proxy",
    "target": "https://your-blog.com",
    "preservePath": true,
    "cacheControl": "public, max-age=60"
  }'
```

### Migrate a Route

```bash
curl -X POST "https://bifrost.yourdomain.com/api/routes/migrate?domain=yourdomain.com&oldPath=/old&newPath=/new" \
  -H "X-Admin-Key: your-api-key"
```

## API Reference

All admin endpoints require `X-Admin-Key` header or `Authorization: Bearer <key>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/routes` | List routes (`?search=`, `?type=`, `?enabled=`, `?limit=`, `?offset=`, `?domain=`) |
| `GET` | `/api/routes?path=` | Get single route |
| `POST` | `/api/routes` | Create route |
| `PUT` | `/api/routes?path=` | Update route |
| `DELETE` | `/api/routes?path=` | Delete route |
| `POST` | `/api/routes/migrate` | Migrate route to new path |
| `POST` | `/api/routes/seed` | Bulk import routes |
| `GET` | `/api/analytics/summary` | Analytics overview |
| `GET` | `/api/analytics/clicks` | Click records (paginated) |
| `GET` | `/api/analytics/views` | View records (paginated) |
| `GET` | `/api/analytics/clicks/:slug` | Stats for specific link |
| `GET` | `/api/storage/buckets` | List all R2 buckets |
| `GET` | `/api/storage/:bucket/objects` | List objects (`?prefix=`, `?cursor=`, `?limit=`, `?delimiter=`) |
| `GET` | `/api/storage/:bucket/meta/:key` | Get object metadata |
| `GET` | `/api/storage/:bucket/objects/:key` | Download object |
| `POST` | `/api/storage/:bucket/upload` | Upload object (multipart, 100MB max) |
| `DELETE` | `/api/storage/:bucket/objects/:key` | Delete object |
| `POST` | `/api/storage/:bucket/rename` | Rename/move object |
| `PUT` | `/api/storage/:bucket/metadata/:key` | Update object HTTP metadata |

### Route Configuration

```typescript
{
  path: string;           // Route path (e.g., "/blog", "/docs/*")
  type: "redirect" | "proxy" | "r2";
  target: string;         // Target URL or R2 key
  statusCode?: 301 | 302 | 307 | 308;  // Redirect status (default: 302)
  preserveQuery?: boolean; // Pass query params (default: true)
  preservePath?: boolean;  // Preserve path for wildcards (default: false)
  hostHeader?: string;    // Override Host header for proxy routes
  forceDownload?: boolean; // Force download for R2 routes (default: false)
  bucket?: string;        // R2 bucket name (default: "files")
  cacheControl?: string;  // Cache-Control header
  enabled?: boolean;      // Enable/disable (default: true)
}
```

## Development

```bash
pnpm run dev          # Local dev server (localhost:8787)
pnpm run test         # Run all tests (728 tests)
pnpm run typecheck    # TypeScript check
pnpm run lint         # Lint all packages
pnpm run deploy:dev   # Deploy to dev environment
```

## Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| **Language** | TypeScript | 5.9.3 |
| **Framework** | [Hono](https://hono.dev/) | 4.11.8 |
| **Runtime** | Cloudflare Workers | — |
| **CLI** | Wrangler | 4.63.0 |
| **Validation** | Zod | 4.3.6 |
| **ORM** | Drizzle ORM | 0.45.1 |
| **Storage** | Cloudflare KV | — |
| **Database** | Cloudflare D1 (analytics) | — |
| **Object Storage** | Cloudflare R2 | — |
| **Testing** | Vitest + @cloudflare/vitest-pool-workers | 3.1.0 / 0.8.0 |
| **Linting** | Oxlint + Biome (formatter) | — |
| **Package Manager** | pnpm (workspaces) | 10.20.0 |
| **Admin Dashboard** | React 19 + Vite 7 + Tailwind CSS 4 + shadcn/ui | — |

## License

MIT

---

*Built with Cloudflare Workers and Hono*

# Bifrost

<p align="center">
  <img src="https://assets.henrychong.com/bifrost/bifrost-logo-readme.png" alt="Bifrost Logo" width="600" />
</p>

> Dynamic edge routing for Cloudflare Workers with KV-based configuration

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **For full technical specifications, architecture details, deployment procedures, and version history, see [CLAUDE.md](CLAUDE.md).**

A lightweight, high-performance edge router built on Cloudflare Workers and the Hono framework. Manage URL redirects, reverse proxies, and R2 bucket serving through a simple API, with all configuration stored in Cloudflare KV for instant propagation across edge locations.

## Features

- **Dynamic Routing** — Configure routes via API without redeployment
- **Three Route Types**:
  - `redirect` — URL redirects (301, 302, 307, 308)
  - `proxy` — Reverse proxy to external URLs
  - `r2` — Serve content from R2 buckets
- **KV-Powered** — Route changes propagate globally in seconds
- **Admin API** — Full CRUD operations with API key authentication
- **Admin Dashboard** — React SPA with Command Palette (Cmd+K), filters, analytics
- **MCP Server** — AI-powered route management via Claude Code/Desktop
- **Analytics** — D1-powered click and page view tracking
- **Query Preservation** — Optionally pass through query parameters
- **Path Preservation** — Preserve URL path for wildcard redirects (`preservePath`)
- **Host Header Override** — Override Host header for proxy routes (CDN/virtual hosting support)
- **Force Download** — Control Content-Disposition for R2 routes (`forceDownload`)
- **Wildcard Patterns** — Support for path patterns like `/blog/*`
- **R2 Backup System** — Automated daily backups with health monitoring
- **API Shield** — OpenAPI schema validation at the Cloudflare edge
- **Built on Hono** — Fast, lightweight, TypeScript-first

### Security Features

- **Multi-Domain Routing** — Single worker handles multiple custom domains with unified KV namespace (domain-prefixed keys)
- **Domain-Restricted Admin API** — Admin API only accessible from primary domain
- **Timing-Safe Auth** — API key comparison resistant to timing attacks
- **SSRF Protection** — Blocks proxy requests to private/internal IPs
- **Path Traversal Protection** — R2 keys sanitized to prevent directory traversal
- **Rate Limiting** — Via Cloudflare WAF (Worker middleware available if needed)
- **CORS Support** — Configurable CORS headers for admin API
- **Request Timeouts** — Proxy requests timeout after 30s (configurable)

### Project Structure

```
bifrost/                         # pnpm monorepo
├── src/                         # Main edge router Worker
├── shared/                      # Shared types, schemas, HTTP client
├── mcp/                         # MCP server for AI integration
├── admin/                       # React SPA dashboard
└── slackbot/                    # Slack bot for route management
```

## Quick Start

### Prerequisites

- Node.js >= 24 (see `.nvmrc`)
- pnpm
- Cloudflare account with Workers enabled

### Installation

```bash
git clone https://github.com/your-username/bifrost-router.git
cd bifrost-router
pnpm install
```

### Setup KV Namespace

```bash
# Create KV namespace
wrangler kv namespace create ROUTES

# Add the namespace ID to wrangler.toml
# [[kv_namespaces]]
# binding = "ROUTES"
# id = "your-namespace-id"
```

### Set Admin API Key

```bash
wrangler secret put ADMIN_API_KEY
# Enter your secure API key when prompted
```

### Deploy

```bash
# Development
pnpm run dev

# Production
pnpm run deploy
```

## Usage

### Add a Redirect

```bash
curl -X POST https://your-worker.dev/api/routes \
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
curl -X POST https://your-worker.dev/api/routes \
  -H "X-Admin-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/api/*",
    "type": "proxy",
    "target": "https://api.example.com",
    "cacheControl": "public, max-age=60"
  }'
```

### List All Routes

```bash
curl https://your-worker.dev/api/routes \
  -H "X-Admin-Key: your-api-key"
```

## API Reference

All admin endpoints require `X-Admin-Key` header or `Authorization: Bearer <key>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/routes` | List all routes |
| `GET` | `/api/routes/:path` | Get single route |
| `POST` | `/api/routes` | Create route |
| `PUT` | `/api/routes/:path` | Update route |
| `DELETE` | `/api/routes/:path` | Delete route |
| `POST` | `/api/routes/seed` | Bulk import routes |

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
  cacheControl?: string;  // Cache-Control header
  enabled?: boolean;      // Enable/disable (default: true)
}
```

### System Endpoints

| Path | Description |
|------|-------------|
| `/health` | Health check (no auth required) |

## Configuration

### wrangler.toml

```toml
name = "bifrost-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "ROUTES"
id = "your-namespace-id"

[vars]
ENVIRONMENT = "production"

[env.dev]
name = "bifrost-worker-dev"
[env.dev.vars]
ENVIRONMENT = "development"
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ADMIN_API_KEY` | API key for admin endpoints | Yes |
| `ENVIRONMENT` | `development` or `production` | No |

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm run dev

# Type check
pnpm run typecheck

# Deploy to dev
pnpm run deploy:dev

# Deploy to production
pnpm run deploy

# View logs
pnpm run tail
```

## Testing

```bash
# Run tests
pnpm run test

# Type check
pnpm run typecheck
```

The project includes comprehensive tests (441 tests) covering:
- Security utilities (timing-safe comparison, URL validation, path sanitization)
- Handlers (redirect, proxy, R2)
- Middleware (rate limiting, CORS)
- Admin API endpoints
- KV operations and route matching
- MCP server tools
- Slackbot command parsing and permissions

## Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| **Language** | TypeScript | 5.9.3 |
| **Framework** | [Hono](https://hono.dev/) | 4.11.4 |
| **Runtime** | Cloudflare Workers | — |
| **CLI** | Wrangler | 4.59.1 |
| **Validation** | Zod | 4.3.5 |
| **ORM** | Drizzle ORM | 0.45.1 |
| **Storage** | Cloudflare KV | — |
| **Database** | Cloudflare D1 (analytics) | — |
| **Object Storage** | Cloudflare R2 | — |
| **Testing** | Vitest + @cloudflare/vitest-pool-workers | 3.1.0 / 0.8.0 |
| **Linting** | ESLint 9 (flat config) + typescript-eslint | 9.39.2 / 8.53.0 |
| **Package Manager** | pnpm (workspaces) | 10.20.0 |
| **Admin Dashboard** | React 19 + Vite 7 + Tailwind CSS 4 + shadcn/ui | 19.2.0 / 7.3.1 / 4.1.18 |
| **Admin State** | TanStack Query + React Hook Form | 5.90.16 / 7.71.1 |
| **Admin Routing** | React Router | 7.12.0 |
| **Admin Charts** | Recharts | 3.6.0 |

## Zod Schema Architecture

Bifrost uses Zod for runtime validation and TypeScript type inference across all packages.

### Schema Locations

| Package | File | Purpose |
|---------|------|---------|
| `shared/` | `src/schemas.ts` | Primary schemas for MCP server and HTTP client |
| `src/` | `kv/schema.ts` | Worker-internal KV storage validation |
| `admin/` | `lib/schemas.ts` | Dashboard form validation and API response parsing |

### Validation Flow

```
Request → Worker (safeParse) → 400 if invalid → Business Logic
                    ↓
              Type inference (z.infer<>)
                    ↓
              Fully typed handlers
```

### Key Patterns

- **safeParse()** — Non-throwing validation on all API inputs (`src/routes/admin.ts`)
- **z.infer<>** — Types derived from schemas (single source of truth)
- **Schema methods** — `.partial()`, `.required()`, `.omit()` for create/update variants
- **.describe()** — Self-documenting schemas for OpenAPI and MCP tooling

## License

MIT

---

*Built with Cloudflare Workers and Hono*

# Bifrost — Self-Hosted URL Shortener & Edge Router for Cloudflare Workers

<p align="center">
  <img src="https://assets.example.com/bifrost/bifrost-logo-readme.png" alt="Bifrost Logo" width="600" />
</p>

> A free, self-hosted alternative to bit.ly and Rebrandly — built on Cloudflare Workers with zero server costs

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-1218%20passing-brightgreen)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)](https://workers.cloudflare.com/)

> **For full technical specifications and architecture details, see [AGENTS.md](AGENTS.md). For version history, see [CHANGELOG.md](CHANGELOG.md).**

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
| **API management** | Full REST API + MCP | REST API | REST API | REST API |
| **Setup time** | ~15 minutes | Instant (SaaS) | ~30 minutes | ~30 minutes |

## Features

- **Dynamic Routing** — Configure routes via API without redeployment
- **Three Route Types**:
  - `redirect` — URL redirects (301, 302, 307, 308)
  - `proxy` — Reverse proxy to external URLs
  - `r2` — Serve content from R2 buckets
- **Case-Insensitive Paths** — Visitors can use any case in the URL (`/LinkedIn`, `/LINKEDIN`, `/linkedin` all match the same route)
- **KV-Powered** — Route changes propagate globally in seconds
- **Admin API** — Full CRUD operations with API key authentication, search, and pagination
- **Forgiving Search** (v1.38.0) — route and QR search ignores case and separators (`summer sale`, `Summer_Sale` and `summersale` all find `/summer-sale`), takes words in any order, and lists the closest path matches first; the same matcher drives the API, the dashboard, Cmd+K and the MCP list tools
- **Admin Dashboard** — React SPA with Command Palette (Cmd+K), filters, analytics, R2 Storage browser with file preview (images, PDFs) and standalone target links
- **MCP Server** — AI-powered route and R2 storage management via Claude Code/Desktop (29 tools)
- **QR Codes** (v1.30.0) — unified QR resource (URL / text / Wi-Fi / vCard) with optional route linking (re-point, never reprint), a preset registry for your own branding, live preview, SVG + PNG export, and authed-only image serving. Since v1.38.0 the editor links a code to an existing route or creates a new 302 redirect for it, and an edit sends only the fields you changed. A route or QR record stored in a shape that cannot be read is listed as "Unreadable record" with a Delete action, never served, and answers a coded 409 on any other read or write
- **UTM Tracking** (v1.38.0) — the route dialog edits the five UTM tags of a redirect target, lowercased, with a live final-target preview; an untouched stored target is never rewritten (dashboard only: the API and MCP see an ordinary target URL)
- **Link-Naming Advice** (v1.38.0) — the route and QR dialogs flag file extensions, dates and version words in a link's name, as advice that never blocks a save
- **User Guide** (v1.30.0) — in-dashboard guide (11 task-first sections) with a first-visit welcome dialog, contextual ? help links, an MCP integration tab, and dated changelog
- **Operational Analytics** — domain-aware full URLs, redirect/proxy/service-page leaders, recent activity, period comparisons, and actionable traffic signals; Cloudflare Health Checks are excluded by default
- **Wildcard Patterns** — Support for path patterns like `/blog/*`
- **R2 Storage Management** — Browse, upload, download, rename, move, and delete R2 objects via API and dashboard
- **Range & Conditional R2 Serving** (v1.33.0) — byte-range resume and media seeking (206 with absolute `Content-Range`, suffix ranges included), cache revalidation (304), and precondition failures (412), served straight from R2 with a quoted `ETag` and `Last-Modified` on every response
- **CDN Cache Purge** — Purge Cloudflare edge cache globally for R2 objects via Zone Cache Purge API, automatically on every route and object mutation as well as on demand
- **Route Domain Transfer** — Move routes between domains preserving configuration and audit trail
- **R2 Backup System** — Automated daily KV route backups with health monitoring (D1 covered by Time Travel)
- **API Shield** — OpenAPI schema validation at the Cloudflare edge
- **Built on Hono** — Fast, lightweight, TypeScript-first

### Security Features

- **Multi-Domain Routing** — Single worker handles multiple custom domains
- **Domain-Restricted Admin API** — Admin API only accessible from designated domain
- **Timing-Safe Auth** — API key comparison resistant to timing attacks
- **SSRF Protection** — Blocks proxy requests to private/internal IPs
- **Path Traversal Protection** — R2 keys sanitized to prevent directory traversal
- **Rate Limiting** — Via Cloudflare WAF (Worker middleware available if needed). **Recommended if you serve large public R2 objects:** add a WAF rate-limit rule scoped to your R2-serving paths and keyed on client IP. Range and conditional requests bypass the edge cache by design, and a *malformed* conditional header degrades to a full, cache-bypassed 200 that is also recorded as a download — so a client repeating one drives your download count up and your cache-hit rate to zero while every request hits R2. Never key such a rule on a caller-controlled header; an attacker just rotates it.
- **Service-Binding Fetch Resilience** — Worker-to-Worker service-binding calls are wrapped in `try/catch` via the `safeServiceFetch` helper, so URL-parse errors and binding failures become 404s + warn logs instead of `scriptThrewException` worker errors
- **Credential Redaction in Analytics (v1.36.0)** — short links are routinely used as the landing URL of a magic-link or OAuth flow, so the four per-feature recorders store `[redacted]` for credential-named query values in both `query_string` and `referrer`. Campaign parameters (`utm_*` and the rest) stay byte-identical. See [Analytics credential redaction](#analytics-credential-redaction-v1360)
- **Route-Target Credential Guard (v1.36.0)** — creating, updating, re-enabling, seeding or transferring a route whose TARGET carries a credential-named parameter is refused unless the operator acknowledges it. A target is stored in KV, copied into the click analytics and exercised by every visitor to the short link

### Project Structure

```
bifrost/                         # pnpm monorepo
├── src/                         # Main edge router Worker
├── shared/                      # Shared types, schemas, HTTP client
├── mcp/                         # MCP server for AI route management
└── admin/                       # React SPA admin dashboard
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

The example `[env.dev]` repeats every binding with isolated placeholder
resources because Wrangler environments do not inherit bindings. Replace both
production and development placeholders before using either deployment target;
keep the development D1/KV/R2/service resources separate from production.

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

**Optional: CDN Cache Purge** — To enable global cache purge for R2 objects, configure zone IDs and R2 custom domains in `src/types.ts`:

```typescript
export const CLOUDFLARE_ZONE_IDS: Record<string, string> = {
  'yourdomain.com': 'your-zone-id-from-cloudflare-dashboard',
};

export const R2_BUCKET_CUSTOM_DOMAINS: Record<string, string[]> = {
  files: ['files.yourdomain.com'],  // If you have R2 custom domains
};
```

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
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0008_file_comments.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0009_feedback.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0010_external_audit_capture.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0011_unified_traffic_events.sql
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0012_feedback_priority_scale.sql

# For local dev, use --local instead of --remote
```

> **Upgrading an existing deployment to v1.34.0?** `0012` is a **one-shot** data
> migration, not a plain schema add. It rescales `feedback.priority` to the
> P0-P3 scale (old `0` none and `4` low become `3`; old `1`, `2`, and `3` keep
> their numbers, so a `1` now reads P1 - Urgent, a `2` reads P2 - Important, and
> a `3` reads P3 - Routine), moves the column to `NOT NULL DEFAULT 3`, and
> **drops `severity`** — any stored severity values are lost, so export the
> table first if you want them (`GET /api/feedback/export?format=json`).
>
> **Deploy the v1.34.0 Worker to an environment FIRST, then apply `0012` to that
> environment in the same window, once per environment, never twice.** The
> migration drops `severity`, and the old Worker names that column on every
> feedback insert and read — apply it first and every feedback submit, list,
> detail, and export returns a 500 (`no such column: severity`) until the deploy
> lands. Deploying first is free: the new Worker never names `severity` and
> writes priority `3` explicitly on create, which the rescale leaves alone. Do
> not triage between the two steps, though — a priority set to `0` before the
> rescale runs is mapped down to `3` along with the legacy zeroes.
>
> **Never run it twice**: a replay maps every deliberate P0 back down to P3.
> Check first — `dflt_value` of `3` means it is already applied:
>
> ```bash
> wrangler d1 execute bifrost-analytics --remote \
>   --command "SELECT dflt_value FROM pragma_table_info('feedback') WHERE name='priority'"
> ```

### Step 6: Set Secrets & Deploy

```bash
# Set your admin API key (you'll be prompted to enter it)
wrangler secret put ADMIN_API_KEY

# Optional: Set Cloudflare API token for CDN cache purge
# (requires Zone > Cache Purge permission)
wrangler secret put CLOUDFLARE_API_TOKEN

# Deploy
pnpm run deploy
```

### Step 7: Verify

```bash
# Health check
curl https://bifrost.yourdomain.com/health

# Create your first route (writes name their domain in ?domain= or X-Domain)
curl -X POST 'https://bifrost.yourdomain.com/api/routes?domain=yourdomain.com' \
  -H "X-Admin-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "path": "/github",
    "type": "redirect",
    "target": "https://github.com/YOUR-USERNAME",
    "statusCode": 302
  }'
```

### Optional: Admin Dashboard

The admin dashboard is a React SPA that connects to your Bifrost API.

Its home page is an operational overview rather than a raw event dump. It shows
canonical source URLs (domain plus path), **Top Routes - Redirect**,
**Top Routes - Proxy**, **Top Website Pages** for service-bound HTML, recent activity, period
comparisons, leading domains/countries/referrers, and actionable signals such as
proxy 5xx rates, low R2 cache-hit rates, scanner-like paths, and material traffic
changes. Cloudflare Health Checks are excluded by default and can be restored
with the labelled toggle. Dashboard analytics inherit the same admin API-key
middleware as route management.

```bash
# Development: the Vite dev server proxies /api to your Worker and adds the key
cat > admin/.env.local << 'EOF'
DASHBOARD_DEV_API_URL=https://bifrost.yourdomain.com
DASHBOARD_DEV_ADMIN_API_KEY=your-admin-api-key
EOF
pnpm --filter admin dev    # Runs on port 3001

# Production (Docker): build from the repository root (no build arguments)
docker build -f admin/Dockerfile -t bifrost-dashboard:latest .

docker run -p 127.0.0.1:3001:3001 \
  -e API_PROXY_ORIGIN=https://bifrost.yourdomain.com \
  -e ADMIN_API_KEY=your-api-key \
  -e R2_PREVIEW_ORIGINS="https://files.yourdomain.com" \
  bifrost-dashboard:latest
```

**The dashboard never holds the admin key (v1.39.0).** The browser calls only
the dashboard's own origin. The container's nginx proxies `/api/` to your Worker
and adds `X-Admin-Key` from the container's `ADMIN_API_KEY`, which it keeps in
a root-only file: the key is not in the image, the bundle, any file the browser
can load, or a log. Under `pnpm dev` the Vite dev server does the same from
`admin/.env.local` (`DASHBOARD_DEV_*`, never `VITE_*`, which Vite hands to the
browser).

| Container input | | |
|---|---|---|
| `API_PROXY_ORIGIN` | **required** | The Worker the `/api` proxy reaches: an https origin with no port or path, such as `https://bifrost.yourdomain.com` (your `ADMIN_API_DOMAIN`). The container must be able to reach it (outbound HTTPS and DNS); its certificate is verified. |
| `ADMIN_API_KEY` | **required** | The Worker's admin key, read at start. The container refuses to start without it, or with whitespace, `"`, `\` or `$` in it. |
| `DASHBOARD_HOSTNAMES` | optional | The host names the browser opens the dashboard by, besides `localhost` and `127.0.0.1` (space-separated, such as `dashboard.yourdomain.com`; a single-label LAN, Docker or Kubernetes service name is accepted; never the Worker's own host). Any other `Host` gets no answer (`/health` aside, answered for any `Host`, so a load balancer or Kubernetes probe by address works), so set it whenever the dashboard sits behind a front door with its own name, and have that front door **pass the browser's `Host` header through unchanged**: the proxy compares a request's `Origin` with it. Not needed by the `:tailscale` image. |
| `DASHBOARD_LISTEN_ADDRESS` | optional | The IPv4 address nginx listens on, port 3001 (default `0.0.0.0`, which Docker port publishing needs). Both plain compose files pass it from `.env` (v1.40.0), and their healthcheck reads the same value. Leave it unset with the `:tailscale` image. |
| `DASHBOARD_TAILSCALE_SERVE` | optional | `off` (default) or `on`, which the `:tailscale` image sets: Tailscale Serve, in the same container, is the one way in, so nginx listens only on a root-only Unix socket and trusts the `Tailscale-User-*` identity and `X-Forwarded-Host` Serve sets. Never set it where anything else can reach nginx: off, a client's `Tailscale-User-*` headers are ignored, never forwarded. |
| `CSP_MODE` | optional | `enforce` (default) or `report-only` for the page policy. `/api` answers always carry an enforced `default-src 'none'; sandbox` policy. |
| `CSP_REPORT_ORIGIN` | optional | The dashboard's own https origin. Set, browsers report policy violations to `<origin>/csp-report` (a bounded, rate-limited receiver that logs metadata only); unset, no reporting. |
| `R2_PREVIEW_ORIGINS` | optional | The R2 custom-domain origins the dashboard previews PDFs from (the hosts in `R2_BUCKET_CUSTOM_DOMAINS` in `admin/src/lib/constants.ts`), space-separated bare `https://host[:port]` origins, added to `object-src` and `frame-src`. |
| `API_PROXY_RESOLVER` | optional | IPv4 DNS resolvers nginx resolves the Worker with (default `1.1.1.1 1.0.0.1`). |

The container validates every value and refuses to start on a bad or missing
one. With Docker Compose, `admin/docker-compose.yml` builds the image and passes
these through from your shell or a `.env` file:
`API_PROXY_ORIGIN=https://bifrost.yourdomain.com ADMIN_API_KEY=your-api-key docker compose -f admin/docker-compose.yml up --build`.

> **⚠️ The dashboard's security boundary is whoever can reach it.** It has no
> login of its own, and its `/api` proxy authenticates every call with the admin
> key, so anyone who can open the dashboard can use the full admin API through
> it. Publish it only on a private network or behind an authenticating front
> door: Tailscale Serve (as the `:tailscale` image does), Cloudflare Access or
> similar, never directly on the internet. The compose files and the `docker
> run` example above bind it to `127.0.0.1`. A page on another site cannot use
> it through a visitor's browser: the proxy forwards only the dashboard's own
> requests (its `X-Bifrost-Dashboard` header, same-origin fetch metadata and
> `Origin`), and only for the host names above.

**Audit rows and logs.** The Worker's audit rows name the actor from the
`Tailscale-User-Login` header: behind the `:tailscale` image that is the
viewer's Tailscale identity, set by Serve; anywhere else the proxy sends none,
so the actor is `api-key`. The row's IP address is the dashboard container's
egress address, not the viewer's. nginx logs request metadata only (method, a
fixed scope, status, sizes, timings), never the URL, query, Referer or a
forwarded header; its error log names the request line, the client address and
the Referer of a call that fails at the proxy. The `/api` proxy never forwards
the browser's `Cookie`, `Authorization`, `Proxy-Authorization`,
`Cf-Access-Jwt-Assertion` or `X-Forwarded-Access-Token` header (a front door's
session, credentials or token); a front door that adds another header should
drop it itself. `DASHBOARD_HOSTNAMES` takes DNS names (letters, digits, hyphens
and dots; no underscore).

**Upgrading from v1.38 or earlier:** the image no longer takes the
`VITE_API_URL` build argument and no longer serves `/env-config.js`. Set
`API_PROXY_ORIGIN` (the URL you used for `VITE_API_URL`) and keep
`ADMIN_API_KEY` in the container's environment. Behind your own front door,
add `DASHBOARD_HOSTNAMES` for the name the browser uses and pass its `Host`
through unchanged. Every dashboard API call now reaches the Worker from the
container's egress IP: a per-IP rate limit on the admin host's `/api/` counts
all operators as one client (size it for all of them, or exempt that IP), and
any Cloudflare Access policy or IP rule there must let that IP through
([Cloudflare WAF](docs/cloudflare-waf.md#rule-2-rate-limit-the-admin-api)).
The `:tailscale` image now serves nginx on a Unix socket
that Tailscale Serve proxies to (no TCP port: tailscaled's userspace
networking would hand tailnet connections to a loopback port around Serve):
take the new `admin/docker-compose.tailscale.yml`, whose healthcheck uses the
socket and still passes on an older image, so a rollback stays healthy; it
needs no `DASHBOARD_HOSTNAMES`. Rename `VITE_API_URL` and
`VITE_ADMIN_API_KEY` in `admin/.env.local` to `DASHBOARD_DEV_API_URL` and
`DASHBOARD_DEV_ADMIN_API_KEY`. The admin API now allows no CORS origin: the
dashboard calls the Worker server-side.

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
        "EDGE_ROUTER_URL": "https://bifrost.yourdomain.com"
      }
    }
  }
}
```

There is no default-domain variable: since v1.35.0 every route, QR and slug-stats call names its own domain, and only the three analytics tools take an optional domain (omit it for all domains).

For Claude Desktop, add the same entry (with full executable paths) to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart the app. Or open this repo in Claude Code and ask it to **"install mcp"** — it will configure both surfaces for you.

See [`mcp/README.md`](./mcp/README.md) for full setup and the 29-tool reference.

### Optional: CI/CD

A GitHub Actions template is provided at `.github/workflows/ci-cd.yml.example`.

1. Rename to `ci-cd.yml`
2. Add repository secrets:
   - `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Workers Edit scope
   - `CLOUDFLARE_ACCOUNT_ID` — Your Cloudflare account ID
   - The dashboard image takes no build argument: set `API_PROXY_ORIGIN` and `ADMIN_API_KEY` in the container's environment on the server (for the Tailscale image, in `admin/auth.env`)

The active CI pipeline (`.github/workflows/ci.yml`) runs secret and public-sanitisation
scans, lint/format/type checks, tests with locked coverage floors, the dashboard
build, analytics/routing/dormant-path performance gates, and production plus
development Wrangler dry-runs on branch pushes and PRs to main; version-tag
pushes (v1.2.3) are skipped, and other tags still run it. It does not deploy.

### Optional: External R2 operations audit capture (v1.28.0)

By default, the audit log only records operations made *through* Bifrost. This optional feature also captures R2 changes made **outside** it — Cloudflare dashboard uploads, Wrangler commands, direct S3/REST API keys — into the same audit page, labelled by source. It ships **dormant** (both flags `"off"`); enabling it is a two-layer opt-in:

**Layer 1 — object-level capture (requires the Workers Paid plan).** Cloudflare Queues are paid-plan-only. On the free plan, `wrangler queues create` fails with a payment-required error — that is the expected gate, not breakage; skip to Layer 2, which works on any plan.

```bash
# 1. Create the queues (60s delivery delay is load-bearing — do not omit it)
wrangler queues create bifrost-r2-events --delivery-delay-secs 60
wrangler queues create bifrost-r2-events-dlq

# 2. Attach notification rules to each bucket you want monitored
wrangler r2 bucket notification create <bucket> \
  --event-types object-create object-delete --queue bifrost-r2-events

# 3. Uncomment the [[queues.consumers]] block in wrangler.toml

# 4. Apply the migration (once per environment)
wrangler d1 execute bifrost-analytics --remote --file=./drizzle/0010_external_audit_capture.sql

# 5. Set R2_EVENT_AUDIT = "on" in wrangler.toml [vars] and deploy
```

External writes then appear on the audit page within ~2 minutes as **External (unattributed)** — Cloudflare's event payloads carry no actor identity on any plan, so *what/when/where* is captured but *who* is not (that's what Layer 2 adds for config changes).

**Layer 2 — config-change capture with real actor attribution (works on the free plan).** A `*/30` cron polls your account's audit logs for R2/queue-scoped changes (bucket settings, notification rules, token changes) and records them **with the actor's email/IP** — it also tamper-protects Layer 1, since deleting the notification rules is itself a captured change.

1. Create a Cloudflare API token — **two non-obvious traps here**:
   - It must be a **user-level token** (My Profile → API Tokens → Create Custom Token). Account-owned tokens (created from the account-level API Tokens page, `cfat_` prefix) are *rejected* by the audit-logs endpoint even when valid.
   - There is **no dedicated "audit logs" permission**. The permission you need is **Account → Account Settings → Read** ("Access: Audit Logs Read" is the Zero Trust product's login logs — the wrong one).
2. `wrangler secret put CF_AUDIT_API_TOKEN` (paste the token), set `CF_ACCOUNT_ID` in `[vars]`.
3. Apply the migration (step 4 above, if you haven't), set `CF_AUDIT_POLL = "on"`, deploy.

Rollback for either layer: flip its flag to `"off"` and redeploy (~90s). Notification rules and queues can stay.

## Usage

### Add a Redirect

```bash
curl -X POST 'https://bifrost.yourdomain.com/api/routes?domain=yourdomain.com' \
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
curl -X POST 'https://bifrost.yourdomain.com/api/routes?domain=yourdomain.com' \
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

To change other fields in the same move, send them as the body (an update
body); the route is written once, at the new path:

```bash
curl -X POST "https://bifrost.yourdomain.com/api/routes/migrate?domain=yourdomain.com&oldPath=/old&newPath=/new" \
  -H "X-Admin-Key: your-api-key" -H "Content-Type: application/json" \
  -d '{"statusCode": 301}'
```

### Delete an unreadable route record

A route listed as `{ "path": …, "invalid": true }` is stored in a shape that
cannot be read. Delete exactly that key (the path as listed, never
normalised; a readable route there is refused), then create it again:

```bash
curl -X DELETE "https://bifrost.yourdomain.com/api/routes?domain=yourdomain.com&path=%2FPromo&recover=invalid" \
  -H "X-Admin-Key: your-api-key"
```

## API Reference

All admin endpoints require `X-Admin-Key` header or `Authorization: Bearer <key>`.

Route and QR writes (create, update, delete, seed, migrate) must name their
domain in `?domain=` or the `X-Domain` header; without one, or with the two
disagreeing, the API answers 400 and writes nothing. There is no default
domain for writes.

On POST, PUT, PATCH and DELETE a body must be sent with `Content-Type:
application/json` (any parameters, such as `; charset=utf-8`), or not at all,
and an upload (`POST /api/storage/:bucket/upload`, `POST /api/feedback`) as
`multipart/form-data`; any other type answers 415 `UNSUPPORTED_MEDIA_TYPE`
before anything is read or written (v1.39.0). An edit (`PUT /api/routes`)
answers 409 `ROUTE_SOURCE_CHANGED` when the route changed after the request
read it, and 404 when it was deleted, and saves nothing. A route path, object
key or slug in a URL goes segment by segment, each percent-encoded, slashes
kept (`pathSegments` and `objectKeySegments` in `@bifrost/shared`; a key with
a leading slash, an empty segment or a `.` or `..` segment is refused rather
than sent). The admin API allows no CORS origin.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/routes` | List routes, newest first (`?search=` ranked by relevance, at most 2,048 characters; `?type=`, `?enabled=`, `?limit=`, `?offset=`, `?domain=`; an invalid value answers 400) |
| `GET` | `/api/routes?path=` | Get single route |
| `POST` | `/api/routes` | Create route |
| `PUT` | `/api/routes?path=` | Update route |
| `DELETE` | `/api/routes?path=` | Delete route (`&recover=invalid`: delete an unreadable record by its exact key) |
| `POST` | `/api/routes/migrate` | Migrate route to new path (optional update body, written in the same write) |
| `POST` | `/api/routes/transfer` | Transfer route between domains |
| `POST` | `/api/routes/normalize-case` | One-time migration: convert all route paths to lowercase (run after upgrading to v1.22.0+ if you have pre-existing uppercase routes). A route deleted or changed while it runs is reported in `errors` (`ROUTE_NOT_FOUND`, `ROUTE_SOURCE_CHANGED`) and left alone |
| `GET` | `/api/routes/by-target` | Find routes serving an R2 object (`?bucket=&target=`) |
| `GET` | `/api/changelog` | The engineering changelog as Markdown (`text/markdown`, `private, max-age=300`) |
| `POST` | `/api/routes/seed` | Bulk import routes |
| `GET` | `/api/analytics/summary` | Domain-aware operational overview (`?domain=&days=&country=&search=&includeMonitoring=`) |
| `GET` | `/api/analytics/clicks` | Click records (paginated) |
| `GET` | `/api/analytics/views` | View records (paginated) |
| `GET` | `/api/analytics/clicks/:slug` | Stats for specific link (the slug without its leading `/`, as path segments; the root slug is `/api/analytics/clicks/`) |
| `GET` | `/api/storage/buckets` | List all R2 buckets |
| `GET` | `/api/storage/:bucket/objects` | List objects (`?prefix=`, `?cursor=`, `?limit=`, `?delimiter=`) |
| `GET` | `/api/storage/:bucket/meta/:key` | Get object metadata |
| `GET` | `/api/storage/:bucket/objects/:key` | Download object |
| `POST` | `/api/storage/:bucket/upload` | Upload object (multipart, 100MB max) |
| `DELETE` | `/api/storage/:bucket/objects/:key` | Delete object |
| `POST` | `/api/storage/:bucket/rename` | Rename object within bucket |
| `POST` | `/api/storage/:bucket/move` | Move object to different bucket |
| `PUT` | `/api/storage/:bucket/metadata/:key` | Update object HTTP metadata |
| `POST` | `/api/storage/:bucket/purge-cache/:key` | Purge CDN cache for R2 object |

### Analytics credential redaction (v1.36.0)

The four per-feature recorders — `link_clicks`, `page_views`, `file_downloads`
and `proxy_requests` — never store a credential-named parameter's VALUE. Both
`query_string` and `referrer` are sanitised, and every non-sensitive parameter
is stored byte-identically, because these tables are your campaign-attribution
source.

Legacy and unified analytics share one bounded, name-based credential policy.
Credential-named fields, including `code`, `state`, `session`, and `ticket`, are
masked regardless of value shape. Use `utm_campaign`, `promo`, or `tier` for
campaign attribution. Nested content is inspected in raw form and at most two
percent-decoded levels; suspicious outer fields are masked wholesale. Harmless
fields retain their original bytes. Inputs beyond the inspection budget are
conservatively masked. Stored destination copies are sanitised without changing
live redirects or proxy requests. See [credential policy](docs/credential-redaction.md)
for limits and trade-offs. Existing records are not rewritten.

### Route-target credential guard (v1.36.0)

A route TARGET is not request data: it is stored in KV, copied into the click
and proxy analytics, and exercised by everyone who opens the short link. A write that would leave such a target ENABLED is refused:

```json
{
  "success": false,
  "error": "ROUTE_TARGET_CREDENTIAL",
  "message": "This route target carries credential-named parameter (token); ...",
  "details": { "parameters": ["token"] }
}
```

Re-send the same write with `"acknowledgeCredentialTarget": true` to store it
anyway. The flag is request-only and never persisted. Parameter NAMES are
returned; values never are.

Disabling a route is never refused, `r2` targets are object keys rather than
URLs and are not examined, and a transfer needs its own acknowledgement because
it re-publishes the target to a different audience. The guard is write-time
only — targets stored before v1.36.0 were never examined.

**Upgrading from before v1.36.0:** review the stored targets, scrub the older
analytics rows and repair any legacy `?`/`#` route key by its exact key, as
[After upgrading to v1.36.0 or later](docs/upgrade-operations.md) describes.

### Optional: unified request analytics (v1.32.0)

Migration `0011` adds a privacy-bounded request stream that can measure public
traffic beyond the four legacy event tables. It ships dormant and does not alter
headline totals. To evaluate it safely, apply the migration, set an RFC3339 UTC
`UNIFIED_TRAFFIC_CUTOVER_AT`, then set `UNIFIED_TRAFFIC_MODE = "shadow"`. The
stream stores domain, normalised path, response classification, coarse country,
cache status, and bounded latency; it does not store query strings, IP addresses,
referrers, User-Agent strings, or target URLs. Set the mode back to `"off"` to
stop capture. On an environment with the daily `0 20 * * *` cron, retention
pruning continues after a valid cutover even while capture is off. The example
development environment has no cron triggers; add that schedule if you keep a
development shadow stream enabled beyond short-lived testing.

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
pnpm run check        # Full quality, test, build, performance, and dry-run gate
pnpm run typecheck    # TypeScript check
pnpm run lint         # Lint all packages
pnpm run deploy:dev   # Deploy to dev environment
```

## Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| **Language** | TypeScript | 6.0.3 |
| **Framework** | [Hono](https://hono.dev/) | 4.13.12 |
| **Runtime** | Cloudflare Workers | — |
| **CLI** | Wrangler | 4.146.0 |
| **Validation** | Zod | 4.6.5 |
| **ORM** | Drizzle ORM | 0.45.3 |
| **Storage** | Cloudflare KV | — |
| **Database** | Cloudflare D1 (analytics) | — |
| **Object Storage** | Cloudflare R2 | — |
| **Testing** | Vitest + @cloudflare/vitest-pool-workers | 4.1.11 / 0.18.8 |
| **Linting** | Oxlint + Biome (formatter) | — |
| **Package Manager** | pnpm (workspaces) | 10.33.0 |
| **Admin Dashboard** | React 19 + Vite 8 + Tailwind CSS 4 + shadcn/ui | — |

## License

MIT

---

*Built with Cloudflare Workers and Hono*

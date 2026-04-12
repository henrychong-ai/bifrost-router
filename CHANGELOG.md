# Changelog

All notable changes to Bifrost are documented in this file.

For deployment instructions and project context, see [CLAUDE.md](./CLAUDE.md).

---

## v1.21.2

### Fixed
- Add `sharp` to `pnpm.onlyBuiltDependencies` — resolves "Ignored build scripts" warning during install

---

## v1.21.1

**Security patches — dependabot advisories resolved**

### Security
- **hono 4.12.9 → 4.12.12** — Patches cookie prefix bypass (GHSA-r5rp-j6wh-rvv4), cookie name validation in `setCookie()`, IPv4-mapped IPv6 `ipRestriction()` bypass, `serveStatic` repeated-slash middleware bypass, and `toSSG()` path traversal
- **@hono/node-server 1.19.11 → 1.19.13** (transitive via `@modelcontextprotocol/sdk`) — `serveStatic` middleware bypass
- **vite 7.3.1 → 7.3.2** — Patches WebSocket arbitrary file read, `server.fs.deny` query bypass, and optimized deps `.map` path traversal
- **path-to-regexp 8.3.0 → 8.4.2** (transitive via `express`) — DoS via sequential optional groups and multiple wildcards
- **brace-expansion 5.0.2 → 5.0.5** (transitive via `minimatch`) — Zero-step sequence process hang / memory exhaustion

### Dependencies
- Added pnpm overrides for `hono`, `@hono/node-server`, `path-to-regexp`, `brace-expansion`, and `vite` to force patched versions across all workspace packages

---

## v1.21.0

### Added
- **Copy target URL** — Copy icon next to destination URL in route edit dialog (redirect/proxy targets and R2 file URLs)
- **Path case conflict blocking** — Red error + disabled submit when a case-insensitive path duplicate exists (e.g., creating `/TEST1` when `/test1` exists)

### Fixed
- **Duplicate target self-match** — Route no longer flags itself as a duplicate when editing
- **Case-insensitive target detection** — Duplicate target check now uses case-insensitive matching
- **Server-side path enforcement** — API returns 409 for case-insensitive path conflicts on create, migrate, and transfer

---

## v1.20.0

**Duplicate target detection — real-time cross-domain route conflict awareness**

### Added
- **Duplicate target warning** — When creating or editing a route, an inline callout appears below the Target field if another route (same domain or any accessible domain) already points to the same URL. Non-blocking — routes can still be created intentionally.
- **Cross-domain prefetch** — Routes for all accessible domains are prefetched on dialog open for instant cross-domain duplicate detection.

---

## v1.19.0

**Copy Link — one-click URL sharing for routes and files**

### Added
- **Copy Link (Routes)** — "Copy Link" in route three-dot menu copies the public URL to clipboard. Route URL with copy icon shown in edit dialog header.
- **Copy Link (Storage)** — "Copy Link" in file three-dot menu copies the R2 custom domain URL to clipboard. Copy icon added next to file URL in edit dialog.
- **`copyToClipboard` utility** — Shared clipboard helper with toast feedback

### Tests
- 3 new `copyToClipboard` unit tests

---

## v1.18.3

### Dependencies
- wrangler 4.73.0 → 4.77.0, hono 4.12.7 → 4.12.9, @biomejs/biome 2.4.6 → 2.4.9
- @cloudflare/workers-types → 20260317.1, lint-staged → 16.4.0, oxlint 1.55.0 → 1.57.0
- pnpm 10.32.1 → 10.33.0

---

## v1.18.2

### Fixed
- **Docker build** — Add `CHANGELOG.md` to Dockerfile COPY step and `.dockerignore` whitelist so the changelog dashboard page can resolve `?raw` import during container build

---

## v1.18.0

### Added
- **Changelog dashboard** — New `/changelog` page with searchable version history, section badges, current version highlighting, and inline code rendering. Synced from Fusang bifrost v1.25.0.
- **Sidebar changelog link** — Changelog nav item pinned at bottom of sidebar, clickable version in footer

### Changed
- **Vitest config** — Root vitest now excludes workspace packages (admin, shared, mcp, slackbot) to prevent Workers pool from picking up Node.js-only tests

---

## v1.17.2

### Fixed
- **Security** — Patch 6 Dependabot alerts (all dev-only): picomatch ReDoS + method injection (→2.3.2/4.0.4), yaml stack overflow (→2.8.3), flatted prototype pollution (→3.4.2)

---

## v1.17.1

### Fixed
- **Audit logging** — Fix typecheck errors in transfer route and cache purge handlers using non-existent `actor` property instead of `actorLogin`/`actorName`

---

## v1.17.0

### Changed
- **Backup system** — Removed D1 analytics backup; D1 is now covered by Cloudflare Time Travel (automatic 30-day PITR). Backup system now backs up KV routes only (~8KB/day).
- **Backup retention** — Changed from 30-day daily / 90-day weekly to indefinite retention (negligible storage cost)
- **Manifest version** — Bumped to 2.0.0 (removed `d1` and `retention` fields)
- **Dashboard** — Removed D1 analytics row count from backup health widget

### Removed
- `src/backup/d1.ts` — D1 table export (redundant with Time Travel)
- `src/backup/retention.ts` — Backup cleanup (no longer needed with indefinite retention)

---

## v1.16.4

### Fixed
- **Storage cross-nav** — Fix race condition where auto-open fired against cached data from wrong bucket before bucket selection completed

---

## v1.16.3

### Added
- **Storage dialog** — "View in Routes" clickable rows for associated routes, navigates to routes tab and auto-opens route's edit dialog
- **Cross-navigation** — Branded Blocktree pill buttons for "View in Storage" and "View in Routes" actions (blue-50/blue-700 pill style)

---

## v1.16.2

### Added
- **Routes dialog** — "View in Storage" button for R2 routes, navigates to storage tab and auto-opens the file's edit dialog

---

## v1.16.1

### Fixed
- **Storage dialog** — Aligned popup width to match routes dialog (`sm:max-w-xl lg:max-w-2xl`)

---

## v1.16.0

**Sync Fusang v1.24.1–v1.24.3: Route preview + standalone target links**

### Added
- **Route dialog** — R2 file preview (image thumbnail, PDF inline) at top of form
- **Route dialog** — Standalone "open target" link for all route types (redirect, proxy, R2)

### Changed
- **Route dialog** — Moved LinkPreview from inline in Target field to top of form
- **Storage dialog** — Fixed PDF preview (`<iframe>` → `<object>` with fallback)
- **Storage dialog** — Moved "open in browser" link from Object Info section to directly below preview
- **LinkPreview component** — Removed embedded link (replaced by standalone target link)

---

## v1.15.2 (2026-03-13)
**Fix storage file preview: include httpMetadata in R2 list responses**

### Fixed
- **R2 list endpoint missing `include` option**: `bucket.list()` in `src/routes/storage.ts` was not passing `include: ['httpMetadata', 'customMetadata']`, so `httpMetadata.contentType` was always undefined in list responses — causing image and PDF previews in the storage edit dialog to never render

### Added
- **Regression test**: `includes httpMetadata and customMetadata in list response` test in `test/storage.test.ts` verifies contentType is returned when listing objects

### Changed
- Total test count: 1039 → 1040

---

## v1.15.1 (2026-03-13)
**Add test infrastructure for admin dashboard**

### Added
- **Admin test suite**: Set up Vitest 4.1 with `vitest.config.ts`, test scripts, and `@/` path alias resolution
- **constants.test.ts**: 20 tests covering `getR2ObjectUrl()` (URL encoding, bucket mapping, null cases), `getPersistedPageSize()` / `persistPageSize()` (localStorage mocking, fallbacks), `R2_BUCKET_CUSTOM_DOMAINS` completeness
- **utils.test.ts**: 14 tests covering `formatBytes()` (edge cases, unit boundaries) and `cn()` (Tailwind conflict resolution, falsy values)

### Changed
- Total test count: 971 → 1039 (34 new admin tests + organic growth across packages)

---

## v1.15.0 (2026-03-13)
**Storage dashboard: file preview and "Open in Browser"**

### Added
- **File preview in storage edit dialog**: Image files (`image/*`) show inline thumbnail preview at top of dialog; PDF files (`application/pdf`) show scrollable iframe preview using browser's built-in PDF renderer
- **"Open in Browser" link**: Below Object Info section, shows the public R2 custom domain URL (e.g., `files.example.com/photo.jpg`) with ExternalLink icon — clickable to open in new tab
- **"Open in Browser" context menu item**: Added as first item in file row dropdown menu, mirroring Routes tab's "Open Target" pattern
- **R2 bucket domain mapping in frontend**: `R2_BUCKET_CUSTOM_DOMAINS` and `getR2ObjectUrl()` in `admin/src/lib/constants.ts` — maps all 8 buckets to their Cloudflare custom domains

---

## v1.14.1 (2026-03-13)
**Fix cache purge, improve toast feedback, update dependencies**

### Fixed
- **Cache purge**: Set `CLOUDFLARE_API_TOKEN` Worker secret — cache purge was returning "No cache entries to purge" because the secret was never configured after v1.14.0 deploy
- **Purge cache toast**: Distinguish "API token not configured" from "no URLs found" — shows actionable message when URLs are found but token is missing

### Changed
- **Dependencies**: wrangler 4.72.0 → 4.73.0, pnpm 10.28.2 → 10.32.1

### Documentation
- Added R2 Cache Purge setup instructions to CLAUDE.md (Worker secret + token permissions)
- Added `.dev.vars` config reference for local development

---

## v1.14.0 (2026-03-13)
**Sync Fusang Bifrost v1.22.0–v1.23.3: Cache Purge, Route Transfer, Storage Dialog, D1 Pagination**

Sync 6 changes from Fusang bifrost into bifrost-hc. Adds global CDN cache purge, route domain transfer, unified storage edit dialog, paginated D1 backups with error isolation, and dependency updates.

### Added
- **Zone Cache Purge**: `POST /api/storage/:bucket/purge-cache/:key` — purge Cloudflare CDN cache globally via Zone Cache Purge API. Collects URLs from KV routes + R2 custom domains, groups by zone, batches of 30. New `src/utils/cache.ts` module
- **Route Domain Transfer**: `POST /api/routes/transfer` — move routes between domains preserving config and createdAt. New `transferRoute()` in `src/kv/routes.ts`
- **Routes by R2 Target**: `GET /api/routes/by-target?bucket=&target=` — find all routes serving a specific R2 object. New `findRoutesByR2Target()` function
- **Storage Edit Dialog**: Click file rows to open unified edit popup with rename, metadata editing, file replacement, associated routes view, and purge cache button
- **Route Transfer UI**: Domain dropdown in routes edit dialog to transfer routes between domains with confirmation
- **Zone IDs & R2 Custom Domains**: `CLOUDFLARE_ZONE_IDS` (8 zones) and `R2_BUCKET_CUSTOM_DOMAINS` (8 buckets) in `src/types.ts`
- **MCP tools**: `purge_cache` (storage) and `transfer_route` (route) — 20 → 22 tools (8 route + 4 analytics + 10 storage)
- **Audit actions**: `transfer` and `r2_cache_purge` added to audit action enum

### Changed
- **D1 Backup Pagination**: Paginated queries (5,000 rows/page) via ReadableStream + native CompressionStream('gzip'). Replaces loading all rows into memory
- **D1 Error Isolation**: Per-table try/catch — single table failure no longer crashes entire backup. `failedTables` tracked in manifest
- **OpenAPI schema**: 3 new endpoints, 2 new audit actions, 2 new schema definitions

### Dependencies
- oxlint 1.48 → 1.55, wrangler 4.66 → 4.72, biome 2.4.2 → 2.4.6
- @cloudflare/vitest-pool-workers 0.12.13 → 0.12.21, workers-types to latest
- eslint-plugin-oxlint 1.48 → 1.55
- admin/vite.config.ts: `__dirname` → `import.meta.dirname` (ESM compat)

### Tests
- Test count: 969 → 971 (root: 719, shared: 68, MCP: 80, slackbot: 104)

---

## v1.13.1 (2026-03-08)
**MCP: Add file_path parameter to upload_object tool**

Add direct file upload from disk to the `upload_object` MCP tool, bypassing base64 encoding through the context window.

### Added
- **file_path upload mode**: `upload_object` accepts `file_path` to read files directly from disk — faster and avoids ~33% base64 size overhead
- **MIME auto-detection**: Content type auto-detected from file extension (25 common types) when using `file_path` mode; `content_type` optional override
- **Pre-read size guard**: File size checked via `stat` before reading into memory, preventing unnecessary I/O for oversized files
- **Zod schema update**: `R2UploadInputSchema` updated with `file_path`, optional fields, and `.refine()` validators for mutual exclusivity

### Changed
- **upload_object schema**: `required` reduced from `['bucket', 'key', 'content_base64', 'content_type']` to `['bucket', 'key']` — validation moved to runtime
- **Success output**: Shows `Source: {file_path}` line when uploading from disk

### Tests
- 10 new upload test cases (file_path success, auto-detect, explicit override, pre-read size guard, file not found, directory path, unknown extension, both params, neither params, missing content_type)
- Added `vi.clearAllMocks()` in `beforeEach` for proper mock isolation
- Test count: 959 → 969 (shared: 68, MCP: 69 → 79, slackbot: 104, root: 718)

---

## v1.13.0 (2026-02-25)
**R2 Cross-Bucket Move, Audit Enhancements & Dialog UX Fixes**

Port and adapt R2 cross-bucket move, expanded audit action filtering, and dialog UX improvements from Fusang Bifrost v1.20.0. Extends test count from 935 to 949.

### Added
- **R2 cross-bucket move**: `POST /api/storage/:bucket/move` endpoint — move objects between writable buckets with size guard (100 MB limit) and conflict detection
- **R2 move MCP tool**: `move_object` tool in MCP server (19 → 20 tools, 8 → 9 storage tools)
- **R2 move dashboard**: Move to Bucket action in storage dropdown, MoveDialog with writable bucket selector
- **R2 replace audit**: Upload handler distinguishes `r2_replace` (overwrite existing) from `r2_upload` (new file) in audit log
- **Expanded audit filters**: All 12 audit actions filterable in dashboard — added r2_upload, r2_delete, r2_rename, r2_move, r2_replace, r2_metadata_update
- **Audit action schema expansion**: `AuditListQuerySchema.action` enum expanded from 5 to 12 values for full server-side filtering
- **Audit detail parsing**: Enhanced `parseDetails()` for migrate, r2_move, r2_replace, r2_rename, and generic bucket/key actions
- **OpenAPI schema**: Added `POST /api/storage/{bucket}/move` and `r2_move`/`r2_replace` to ActionQuery enum

### Changed
- **Dialog overflow fix**: `DialogContent` now has `max-h-[calc(100vh-4rem)]`, `overflow-y-auto`, and `[&>*]:min-w-0` to prevent content overflow and fix CSS Grid min-width issue
- **Responsive route dialogs**: Create Route and Edit Route dialogs use `sm:max-w-xl lg:max-w-2xl` for better form layout on larger screens
- **Clickable link preview**: LinkPreview URL row changed from `<div>` to `<a>` with hover feedback and external link
- **Rename endpoint clarified**: Rename endpoint description updated from "Rename/move" to "Rename within bucket" (move is now separate)

### Tests
- `test/storage.test.ts`: 8 integration tests for R2 move (success, custom key, 404, 409 conflict, read-only source/dest, same bucket, size limit)
- `mcp/src/tools/storage.test.ts`: 3 unit tests for moveObject handler
- `shared/src/tools.test.ts`: Updated storage tools count and added move_object to expected tools

---

## v1.12.3 (2026-02-20)
**Tests: Comprehensive test coverage port from Fusang Bifrost**

Port and adapt 11 new test files from Fusang Bifrost v1.19.9, extending total test count from 487 to 935. Covers KV layer, D1 analytics, backup system, slackbot permissions, MCP storage tools, and R2 copy size guard. Fixes CI gap where root workspace tests were not run in pipeline.

### Added
- `test/kv/schema.test.ts` — KV schema version, key parsing, metadata structure
- `test/kv/routes.test.ts` — Route CRUD with path normalisation, domain isolation, migration
- `test/db/recording.test.ts` — Analytics recording (clicks, views, audit logging)
- `test/db/queries.test.ts` — Analytics query layer (summary, clicks, views, slug stats)
- `test/backup/kv.test.ts` — KV backup creation, serialisation, NDJSON+Gzip format
- `test/backup/d1.test.ts` — D1 backup export with 30-day window
- `test/backup/retention.test.ts` — Retention policy (30-day daily, 90-day weekly)
- `test/backup/manifest.test.ts` — Backup manifest read/write
- `test/backup/scheduled.test.ts` — Scheduled backup orchestration (cron handler)
- `slackbot/test/permissions-kv.test.ts` — Slackbot KV permission CRUD
- `mcp/src/tools/storage.test.ts` — MCP storage handler tests (26 tests across 8 tools)
- R2 copy size guard tests in `test/storage.test.ts` — 7 tests covering rename/metadata 413 guard, boundary conditions, and source integrity

### Fixed
- **CI gap**: Root workspace tests (`pnpm run test`) were excluded from `pnpm run -r test` despite `.` in `pnpm-workspace.yaml`. Added explicit root test step to CI workflow and `check` script.
- `test/kv/routes.test.ts` adapted to HC implementation: `getRoute`/`getRouteSafe`/`deleteRoute` don't call `normalizePath` (unlike Fusang); `getAllRoutesAllDomains` filters to `SUPPORTED_DOMAINS`

### Infrastructure
- `vitest.config.ts`: `R2_COPY_SIZE_LIMIT_MB: '0.001'` for size guard tests (avoids 100 MB buffers)
- `src/routes/storage.ts`: Export `getR2CopySizeLimit` for test imports
- `.github/workflows/ci-cd.yml`: Split `Test` step into `Test (root)` + `Test (packages)`

---

## v1.12.2 (2026-02-19)
**Security: Runtime env injection for admin API key**

Move `ADMIN_API_KEY` out of the Docker build process entirely. Previously baked into the Vite JS bundle as a build arg (visible in `docker history` and the GHA build cache). Now injected at container startup via `env-config.js`, keeping the key out of the image layers completely.

### Security
- **Changed**: `ADMIN_API_KEY` is no longer a Docker build arg — removed from `Dockerfile.tailscale`, `Dockerfile`, and CI `build-args`
- **Added**: `env-config.js` generated at container startup from `$ADMIN_API_KEY` env var, served by nginx with `no-store` cache headers
- **Changed**: `admin/src/env.ts` reads `window.__ENV__.ADMIN_API_KEY` at runtime, falling back to `VITE_ADMIN_API_KEY` for local dev

### Changed
- `admin/scripts/start-with-tailscale.sh` — generates `/usr/share/nginx/html/env-config.js` before nginx starts
- `admin/scripts/start.sh` (new) — equivalent startup for plain `Dockerfile`
- `admin/nginx.conf` — `location = /env-config.js` with `Cache-Control: no-store` (prevents browser caching stale keys)
- `admin/index.html` — loads `/env-config.js` before the main bundle
- `admin/docker-compose.yml` — `ADMIN_API_KEY` passed as runtime `environment` var (not build arg)
- `admin/src/env.ts` — field renamed from `VITE_ADMIN_API_KEY` to `ADMIN_API_KEY`; runtime injection takes precedence
- CI: `VITE_ADMIN_API_KEY` secret removed from `build-args` — no longer needed in the build

### Fixed
- `mcp/vitest.config.ts` (new) — prevents mcp package from inheriting root cloudflare workers pool config (fixes CI pipeline failure with vitest 4.x)

---

## v1.12.1 (2026-02-19)
**Security: Dependency upgrades and vulnerability fixes**

Bumped all safe non-breaking dependencies. Fixed 3 open Dependabot alerts via pnpm overrides for transitive vulnerabilities.

### Security
- **Fixed**: `qs` >= 6.14.2 (pnpm override) — closes DoS via arrayLimit bypass in comma parsing (CVE-2026-24612 / low)
- **Fixed**: `minimatch` >= 10.0.0 (pnpm override) — closes ReDoS via repeated wildcards (high)

### Changed
- `hono`: 4.11.8 → 4.12.0 (root + slackbot)
- `wrangler`: 4.63.0 → 4.66.0 (root + slackbot)
- `@cloudflare/workers-types`: 4.20260207.0 → 4.20260219.0
- `@cloudflare/vitest-pool-workers`: 0.8.x → 0.12.13
- `@biomejs/biome`: 2.3.15 → 2.4.2
- `oxlint`: 1.47.0 → 1.48.0
- `eslint`: 9.x → 10.0.0 (admin; compatible with eslint-plugin-react-refresh 0.5.0 + typescript-eslint 8.56.0)
- `vitest`: 3.1.0 → 3.2.4 (root + slackbot; pinned to 3.x — @cloudflare/vitest-pool-workers 0.12.x requires vitest ≤ 3.2.x)
- `tailwindcss` + `@tailwindcss/vite`: 4.1.18 → 4.2.0
- `@tanstack/react-query`: 5.90.20 → 5.90.21
- `@types/node`: 24.x → 25.3.0 (mcp, shared, admin; vitest pool workers packages stay on 3.x)
- `lucide-react`: 0.562.0 → 0.575.0
- `drizzle-kit`: 0.31.8 → 0.31.9
- `typescript-eslint`: 8.54.0 → 8.56.0
- `tailwind-merge`: 3.4.0 → 3.5.0
- Added `pnpm.onlyBuiltDependencies` for `esbuild` and `workerd`

---

## v1.12.0 (2026-02-19)
**R2 Storage Management, Route Search & Pagination**

Major feature release porting genericised features from Fusang Bifrost. Adds full R2 storage management across API, MCP, and dashboard, plus route search and pagination.

### Added
- **Route search**: Full-text search across route fields (`?search=` on GET /api/routes) — matches path, target, type, status code, bucket, and host header (case-insensitive)
- **Route pagination**: Server-side limit/offset pagination for route listing with `total`, `hasMore`, `offset` metadata
- **R2 Storage API**: 8 endpoints for bucket/object management (`/api/storage/*`) — list buckets, list/get/upload/download/delete/rename objects, update metadata
- **R2 path validation**: Strict reject approach — rejects keys with path traversal, null bytes, hidden components, Windows illegal chars (never silently sanitizes)
- **R2 copy size guard**: Rejects rename/metadata operations on objects > 100MB (configurable via `R2_COPY_SIZE_LIMIT_MB` env var)
- **R2 Storage MCP tools**: 8 new tools for AI-driven R2 management (11 → 19 total): `list_buckets`, `list_objects`, `get_object_meta`, `get_object`, `upload_object`, `delete_object`, `rename_object`, `update_object_metadata`
- **R2 Storage dashboard**: New Storage page for browsing and managing R2 files — bucket selector, folder navigation, upload/download/delete/rename, metadata editing, read-only mode for bifrost-backups
- **PaginationControls component**: Shared pagination component with localStorage page size persistence
- **Command Palette route search**: Dynamic route search results in Cmd+K with server-side search, type badges, and navigation

### Fixed
- Biome: Added `.pnpm-store` exclusion for CI compatibility
- R2 handler: Path traversal test updated for strict reject validation

---

## v1.11.9 (2026-02-18)
**CI/CD: Separate CI and CD into parallel jobs, tooling improvements**

Restructured GitHub Actions pipeline to cleanly separate CI (quality gates) from CD (deployment). Deploy now only triggers on version tags, matching the fusang bifrost pattern.

### Pipeline Restructure
- **Changed**: Split single job into 4 jobs: `ci`, `deploy-worker`, `build-and-push-container`, `deploy-to-vps`
- **Changed**: Deploy Worker and container build run in **parallel** after CI passes
- **Changed**: Deploy only triggers on version tags (`v*`) or manual dispatch (push to main = CI only)
- **Changed**: Docker metadata always tags `latest` (deploy only runs for releases)

### Tooling
- **Added**: Biome VCS integration (`useIgnoreFile: true`) for CI defense-in-depth
- **Added**: `scripts/upload-api-shield.mjs` for automated API Shield schema uploads
- **Added**: `scripts/**` to oxlint `ignorePatterns`
- **Changed**: Biome `lineWidth` standardised to 100 across all bifrost repos
- **Fixed**: lint-staged `*.{json,md}` glob — removed `md` (biome doesn't format markdown)

### Documentation
- **Updated**: CLAUDE.md — CI/CD trigger table, versioning instructions, test count (653), Hono version
- **Updated**: README.md — tech stack versions (Hono 4.11.8, Wrangler 4.63.0, Zod 4.3.6, pnpm 10.28.2), linting stack (Oxlint + Biome), test count (653)

---

## v1.11.8 (2026-02-13)
**Tooling: Migrate to Oxlint+Biome, fix typecheck errors**

Replaced ESLint+globals with Oxlint (primary linter) and Biome (formatter). Fixed two pre-existing typecheck errors.

### Linting Migration
- **Added**: `oxlint.json` — Oxlint config with native plugins (import, promise, node, vitest, react, jsx-a11y)
- **Added**: `biome.json` — Biome 2.3.15 formatter (linter disabled, Tailwind CSS parser enabled)
- **Removed**: Root `eslint.config.js`, replaced by `oxlint.json`
- **Changed**: `admin/eslint.config.js` — rewritten as residual-only (eslint-plugin-react-refresh + eslint-plugin-oxlint)
- **Changed**: Root devDeps — removed @eslint/js, eslint, globals, typescript-eslint; added oxlint, @biomejs/biome
- **Changed**: Admin devDeps — removed @eslint/js, eslint-plugin-react-hooks, globals; added eslint-plugin-oxlint
- **Changed**: Slackbot — removed lint deps and scripts (covered by root oxlint)
- **Changed**: CI/CD — added `pnpm run format:check` step

### Typecheck Fixes
- **Fixed**: `Cannot find module '@bifrost/shared'` — added missing `@bifrost/shared: workspace:*` dependency to root package.json
- **Fixed**: `Property 'error' does not exist` in migrate route handler — aligned domain validation types with fusang bifrost's centralised `error` pattern (renamed `providedValue` → `error` in types + validation function + all 7 call sites)

---

## v1.11.7 (2026-02-12)
**Security: Remove includeSubDomains from HSTS**

Remove `includeSubDomains` directive from Hono `secureHeaders()` HSTS configuration. The directive was causing SSL failures on non-proxied subdomains (e.g., `drive.example.com` CNAME to Google) because browsers enforced HTTPS on all subdomains, but Google's `ghs.googlehosted.com` doesn't have a valid cert for custom subdomains.

All bifrost-served domains are explicitly configured as Cloudflare Custom Domains with individual SSL certs, so `includeSubDomains` provides no additional security benefit.

- **Changed**: `secureHeaders()` → `secureHeaders({ strictTransportSecurity: 'max-age=15552000' })`
- **Added**: `test/middleware/secure-headers.test.ts` - test coverage for security headers

---

## v1.11.6 (2026-02-07)
**Security: Dependency upgrades**

Bump all safe non-breaking dependencies to resolve Dependabot alerts and stay current.

| Package | From | To | Scope |
|---------|------|----|-------|
| hono | 4.11.4/4.11.7 | 4.11.8 | root, slackbot |
| wrangler | 4.59.1 | 4.63.0 | root, slackbot |
| zod | 4.3.5 | 4.3.6 | all |
| @cloudflare/workers-types | 4.20260114.0 | 4.20260207.0 | root, slackbot |
| typescript-eslint | 8.53.0 | 8.54.0 | root, slackbot, admin |
| globals | 17.0.0 | 17.3.0 | root, admin |
| react | 19.2.3 | 19.2.4 | admin |
| react-dom | 19.2.3 | 19.2.4 | admin |
| @tanstack/react-query | 5.90.16 | 5.90.20 | admin |
| react-router-dom | 7.12.0 | 7.13.0 | admin |
| recharts | 3.6.0 | 3.7.0 | admin |
| lucide-react | 0.562.0 | 0.563.0 | admin |
| @vitejs/plugin-react | 5.1.2 | 5.1.3 | admin |
| @types/react | 19.2.8 | 19.2.13 | admin |

Closes CVE-2026-24771, CVE-2026-24473, CVE-2026-24472, CVE-2026-24398 (hono), CVE-2026-0933 (wrangler).

---

## v1.11.5 (2026-02-06)
**Refactor: Switch to Individual Radix UI Packages**

Replaced umbrella `radix-ui` package with individual `@radix-ui/*` packages for consistency with fusang bifrost.

**Changes:**
- Added `@radix-ui/react-alert-dialog@^1.1.15`
- Removed umbrella `radix-ui@^1.4.3` package (26 packages removed from dependency tree)
- Updated `alert-dialog.tsx` import to use individual package

---

## v1.11.4 (2026-02-05)
**Security: Dependabot Alert Fixes**

| Package | From | To | Severity |
|---------|------|-----|----------|
| hono | 4.11.4 | 4.11.7 | MEDIUM |
| @modelcontextprotocol/sdk | 1.25.2 | 1.26.0 | HIGH |

Closes security vulnerabilities in MCP server (cross-client data leak) and Hono (XSS, cache bypass, IP validation bypass).

---

## v1.11.3 (2026-02-05)
**Fix Duplicate Audit Log on Route Migration**

Fixed duplicate audit entries when migrating routes via Edit dialog. Only "migrate" entry is now recorded.

---

## v1.11.2 (2026-02-05)
**AuditAction Schema Single Source of Truth**

Moved `AuditActionSchema` and `AuditLogSchema` to `@bifrost/shared` package to prevent schema drift between backend and frontend.

---

## v1.11.1 (2026-02-05)
**Path Editing in Edit Dialog**

UX improvement: Path field now editable directly in Edit Route dialog with migration confirmation AlertDialog.

---

## v1.11.0 (2026-02-05)
**Route Migration Feature**

Migrate routes to new paths while preserving configuration, creation date, and audit trail.

**New Features:**
- Admin API endpoint (`POST /api/routes/migrate`)
- Admin dashboard UI with migration confirmation
- MCP tool (`migrate_route`)
- New 'migrate' audit action type

---

## v1.10.1 (2026-02-05)
**Command Palette with Cmd+K**

Global Cmd+K (Mac) / Ctrl+K (Windows) command palette for quick navigation and actions.

---

## v1.10.0 (2026-02-05)
**Link Preview & OG Parser**

**New Features:**
- Open Graph Parser API (`GET /api/metadata/og?url=`) with SSRF protection
- Link Preview Component for redirect/proxy targets
- Keyboard Shortcuts Hook and Kbd Component
- CORS centralization

---

## v1.9.7 (2026-02-04)
**Code Quality Backports & Bug Fixes**

- R2 streaming: `body.tee()` instead of `arrayBuffer()`
- Proxy URL construction: `URL` constructor instead of string concatenation
- Path normalization on KV write
- Backup health endpoint always returns HTTP 200
- CI/CD recursive coverage across monorepo

---

## v1.9.6 (2026-02-04)
**Node 24 & ES2024 Upgrade**

Upgraded TypeScript target from ES2022 to ES2024 across all sub-packages.

---

## v1.9.5 (2026-02-03)
**CI/CD Pipeline Enhancement**

Unified CI/CD pipeline with Worker auto-deployment and Dashboard container auto-deployment via Tailscale.

---

## v1.9.4 (2026-02-02)
**Health Endpoint Version from Environment**

Health endpoint returns version from `VERSION` environment variable in wrangler.toml.

---

## v1.9.0 (2026-01-29)
**Multi-R2 Bucket Support**

R2 routes can serve from 8 buckets: files (default), assets, and 6 family-specific buckets.

---

## v1.8.0 (2026-01-26)
**Host Header Override for Proxy Routes**

New `hostHeader` option for proxy routes to override HTTP Host header sent to origin.

---

## v1.7.0 (2026-01-23)
**API Shield Schema Validation**

OpenAPI 3.0.3 schema validation at the Cloudflare edge. Block mode active.

---

## v1.6.0 (2026-01-23)
**R2 Backup Health Check System**

New `/api/backups/health` endpoint and dashboard widget for backup monitoring.

---

## v1.5.0 (2026-01-23)
**Force Download Option for R2 Routes**

New `forceDownload` toggle for explicit Content-Disposition control.

---

## v1.4.0 (2026-01-23)
**Preserve Path Feature for Wildcard Redirects**

New `preservePath` toggle for redirect routes to preserve URL path when redirecting.

---

## v1.3.0 (2026-01-16)
**R2 Backup System**

Daily automated backups to R2 with KV routes and D1 analytics (NDJSON + gzip). 30-day retention.

---

## v1.2.0 (2026-01-15)
**Unified KV Architecture**

Migrated from 8 per-domain KV namespaces to single unified `bifrost-routes` namespace with domain-prefixed keys.

---

## v1.0.0 (2026-01-14)
**Bifrost: Complete Rename & Stable Release**

Project renamed from `cloudflare-edge-router` to `bifrost`. All packages, workers, and databases renamed.

---

## v0.9.0 (2026-01-14)
**MCP Server, Slackbot & Monorepo Structure**

- MCP Server for AI-powered route management
- Slackbot for Slack-based route management
- Monorepo migration with pnpm workspaces

---

## v0.8.0 (2026-01-13)
**D1 Analytics & Admin API Security**

D1 analytics database for link clicks and page views. Admin API domain restriction.

---

## v0.7.0 (2026-01-11)
**Security Hardening & KV Key Format Migration**

Security fixes for CORS, auth ordering, and rate limiting. KV key format migration.

---

## v0.6.0 (2026-01-10)
**Multi-Domain Support**

Added `example.com` (151 routes) and `secondary.example.net` (4 routes) domain support.

---

## v0.5.0 (2026-01-09)
**Initial Multi-Domain Routing**

Initial multi-domain routing infrastructure with `links.example.com` as primary domain.

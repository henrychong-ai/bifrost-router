# Changelog

All notable changes to this project are documented in this file.

## v1.16.1

### Fixed
- **Storage dialog** — Aligned popup width to match routes dialog (`sm:max-w-xl lg:max-w-2xl`)

---

## v1.16.0

**Route preview + standalone target links**

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
- **Regression test**: `includes httpMetadata and customMetadata in list response` test verifies contentType is returned when listing objects

---

## v1.15.1 (2026-03-13)
**Add test infrastructure for admin dashboard**

### Added
- **Admin test suite**: Set up Vitest 4.1 with `vitest.config.ts`, test scripts, and `@/` path alias resolution
- **constants.test.ts**: Tests covering `getR2ObjectUrl()` (URL encoding, null cases), `getPersistedPageSize()` / `persistPageSize()` (localStorage mocking, fallbacks), `R2_BUCKET_CUSTOM_DOMAINS` structure
- **utils.test.ts**: Tests covering `formatBytes()` (edge cases, unit boundaries) and `cn()` (Tailwind conflict resolution, falsy values)

---

## v1.15.0 (2026-03-13)
**Storage dashboard: file preview and "Open in Browser"**

### Added
- **File preview in storage edit dialog**: Image files (`image/*`) show inline thumbnail preview at top of dialog; PDF files (`application/pdf`) show scrollable iframe preview using browser's built-in PDF renderer
- **"Open in Browser" link**: Below Object Info section, shows the public R2 custom domain URL with ExternalLink icon — clickable to open in new tab
- **"Open in Browser" context menu item**: Added as first item in file row dropdown menu
- **R2 bucket domain mapping in frontend**: `R2_BUCKET_CUSTOM_DOMAINS` and `getR2ObjectUrl()` in `admin/src/lib/constants.ts` — configure with your R2 custom domain URLs to enable previews

### Notes
- Previews require configuring `R2_BUCKET_CUSTOM_DOMAINS` in `admin/src/lib/constants.ts` with your R2 custom domain URLs
- Without configured domains, the preview and link features gracefully degrade (not shown)

---

## v1.14.0 (2026-03-13)
**CDN Cache Purge, Route Transfer, Storage Edit Dialog, D1 Backup Pagination**

### Added
- **Zone Cache Purge**: `POST /api/storage/:bucket/purge-cache/:key` — purge Cloudflare CDN cache globally via Zone Cache Purge API. Collects URLs from KV routes + R2 custom domains, groups by zone, batches of 30. New `src/utils/cache.ts` module. Requires optional `CLOUDFLARE_API_TOKEN` secret with Cache Purge permission
- **Route Domain Transfer**: `POST /api/routes/transfer` — move routes between domains preserving config and createdAt timestamp. New `transferRoute()` in `src/kv/routes.ts`
- **Routes by R2 Target**: `GET /api/routes/by-target?bucket=&target=` — find all routes serving a specific R2 object. New `findRoutesByR2Target()` function
- **Storage Edit Dialog**: Click file rows to open unified edit popup with rename, metadata editing, file replacement, associated routes view, and purge cache button
- **Route Transfer UI**: Domain dropdown in routes edit dialog to transfer routes between domains with confirmation
- **Configurable Zone IDs**: `CLOUDFLARE_ZONE_IDS` and `R2_BUCKET_CUSTOM_DOMAINS` in `src/types.ts` for self-hosted cache purge configuration
- **MCP tools**: `purge_cache` (storage) and `transfer_route` (route) — 20 → 22 tools (8 route + 4 analytics + 10 storage)
- **Audit actions**: `transfer` and `r2_cache_purge` added to audit action enum and dashboard audit page

### Changed
- **D1 Backup Pagination**: Paginated queries (5,000 rows/page) via ReadableStream + native CompressionStream('gzip'). Replaces loading all rows into memory
- **D1 Error Isolation**: Per-table try/catch — single table failure no longer crashes entire backup. `failedTables` tracked in backup manifest
- **OpenAPI schema**: 3 new endpoints, 2 new audit actions, 2 new schema definitions

### Dependencies
- oxlint 1.0 → 1.55, wrangler 4.63 → 4.73, biome 2.3.15 → 2.4.6
- @cloudflare/vitest-pool-workers 0.8 → 0.12.21, workers-types to latest
- eslint-plugin-oxlint 1.0 → 1.55
- admin/vite.config.ts: `__dirname` → `import.meta.dirname` (ESM compat)

### Tests
- 753 → 754 tests (root: 504, shared: 68, MCP: 80, slackbot: 104)

---

## v1.13.2 (2026-03-08)

### Added
- **MCP file_path upload**: `upload_object` tool accepts `file_path` to read files directly from disk, bypassing base64 encoding (~33% size reduction, faster uploads)
- **MIME auto-detection**: Content type auto-detected from file extension (25 common types) when using `file_path` mode; `content_type` optional override
- **Pre-read size guard**: File size checked via `stat` before reading into memory, preventing unnecessary I/O for oversized files
- **Zod schema update**: `R2UploadInputSchema` updated with `file_path`, optional fields, and `.refine()` validators for mutual exclusivity

### Changed
- `upload_object` schema `required` reduced from `['bucket', 'key', 'content_base64', 'content_type']` to `['bucket', 'key']` — validation moved to runtime
- Success output shows `Source: {file_path}` line when uploading from disk

### Tests
- 743 → 753 tests (+10): 10 new MCP upload tests (file_path success, auto-detect, explicit override, pre-read size guard, file not found, directory, unknown extension, both params, neither, missing content_type)
- Added `vi.clearAllMocks()` in test `beforeEach` for proper mock isolation

---

## v1.13.0 (2026-02-25)

### Added
- **R2 cross-bucket move**: New `POST /api/storage/:bucket/move` endpoint for moving objects between R2 buckets with full validation (size guard, conflict detection, key validation)
- **R2 move MCP tool**: `move_object` tool (20th tool, 9th storage) for AI-driven cross-bucket moves
- **R2 move dashboard**: "Move to Bucket" action in storage page dropdown with destination bucket selector
- **Upload audit distinction**: `r2_replace` audit action when overwriting existing objects (vs `r2_upload` for new)

### Changed
- **Audit page R2 support**: Added colours, icons, filter items, and detail parsing for all R2 audit actions (`r2_upload`, `r2_delete`, `r2_rename`, `r2_move`, `r2_replace`, `r2_metadata_update`)
- **Audit query**: Expanded `AuditListQuerySchema.action` from 5 to 12 values (added `migrate` + 6 R2 actions)
- **Dialog UX**: Added viewport height constraint, scroll overflow, and CSS Grid `min-width` fix to `DialogContent`
- **Route dialogs**: Responsive sizing (`sm:max-w-xl lg:max-w-2xl`) for Create/Edit Route dialogs
- **Link preview**: URL row now clickable (changed from `<div>` to `<a>` with hover styling)

### Security
- Patched ajv ReDoS vulnerability (CVE-2025-69873) via scoped pnpm override `"ajv@^6": "^6.14.0"`
- Bumped hono to ^4.12.0 for timing comparison hardening in basicAuth/bearerAuth

### Tests
- 728 → 743 tests (+15): 8 R2 move integration, 3 MCP moveObject handler, 4 shared tools updates

---

## v1.12.0 (2026-02-20)

### Added
- **Route search**: Full-text search across path, target, type, statusCode, bucket, hostHeader (`?search=` on GET /api/routes)
- **Route pagination**: Server-side limit/offset pagination for route listing with `meta` envelope (`total`, `count`, `offset`, `hasMore`)
- **R2 Storage API**: 8 endpoints for bucket/object management at `/api/storage/*`
- **R2 path validation**: Strict reject approach blocking path traversal, null bytes, hidden components, Windows illegal chars
- **R2 copy size guard**: Rejects rename/metadata ops on objects exceeding `R2_COPY_SIZE_LIMIT_MB` (default 100MB) with 413
- **R2 Storage MCP tools**: 8 new tools for AI-driven R2 management (11 → 19 total): `list_buckets`, `list_objects`, `get_object_meta`, `get_object`, `upload_object`, `delete_object`, `rename_object`, `update_object_metadata`
- **R2 Storage dashboard**: New Storage page for browsing buckets, navigating prefixes, uploading, renaming, and deleting objects
- **PaginationControls**: Shared pagination component with localStorage page size persistence
- **Page size constants**: `DEFAULT_PAGE_SIZE`, `PAGE_SIZE_OPTIONS`, `getPersistedPageSize`, `persistPageSize` in `admin/src/lib/constants.ts`
- **`RoutesListQuerySchema`**: Zod schema for route listing query params in `@bifrost/shared`
- **`formatBytes()`**: Utility for human-readable file sizes in admin dashboard

### Changed
- `GET /api/routes` (list mode): response now returns `{ success, data: { routes, meta } }` envelope with pagination metadata
- `EdgeRouterClient.listRoutes()`: return type changed to `Promise<{ routes: Route[]; total: number }>` (breaking change for direct SDK users)
- MCP `list_routes` tool: now accepts `search`, `limit`, `offset` parameters
- Admin sidebar: Storage nav item added (HardDrive icon)
- Command Palette: Storage navigation command added

### Tests
- 623 → 728 tests (+105 new tests across 2 new test files)
- New: `test/routes/admin.search-pagination.test.ts` (16 tests: search by path/target, type/enabled filters, pagination, combined filters, multi-domain)
- New: `test/routes/storage.test.ts` (27 tests: auth, bucket listing, object CRUD, copy size guard, path validation, read-only enforcement)
- New: `test/utils/path-validation.test.ts` (62 tests)

---

## v1.11.9 (2026-02-20)
- Comprehensive test coverage expansion: 455 → 623 tests (+168 new tests across 9 new test files)
- New tests: KV schema validation (36), KV route CRUD (27), DB recording functions (16), DB analytics queries (60), backup KV (5), backup D1 (5), backup retention (7), backup manifest (5), backup scheduled handler (7)
- Infrastructure: Added `.pnpm-store` exclusion to Biome, `BACKUP_BUCKET` to vitest R2 pool, `test` step in `check` script
- Fixed: merge conflict in shared schemas test

## v1.11.8 (2026-02-13)
- Tooling: Migrate from ESLint to Oxlint (primary linter) + Biome (formatter)
- Added `oxlint.json` with native plugins (import, promise, node, vitest, react, jsx-a11y)
- Added `biome.json` (Biome 2.3.15, formatter only, Tailwind CSS parser enabled)
- Admin: residual ESLint for `eslint-plugin-react-refresh` only (via `eslint-plugin-oxlint`)
- Removed root `eslint.config.js`, replaced by `oxlint.json`
- Fixed: missing `@bifrost/shared` workspace dependency in root package.json
- Fixed: domain validation type error — aligned `providedValue` → `error` pattern

## v1.11.7 (2026-02-12)
- Security: Remove `includeSubDomains` from HSTS header to avoid forcing HTTPS on non-proxied subdomains (e.g., CNAME records to external services)
- Added secure headers middleware tests

## v1.11.6 (2026-02-07)
- Version bump to match upstream (v1.11.4-v1.11.6 were dependency bumps and documentation updates)

## v1.11.3 (2026-02-07)
- Fix: removed duplicate audit log entry on route migration (only 'migrate' recorded, not both 'update' and 'migrate')

## v1.11.2 (2026-02-07)
- Moved AuditAction schema to @bifrost/shared as single source of truth
- Added 'migrate' action to audit log UI (colour, icon, filter dropdown)
- Admin schemas now import AuditActionSchema/AuditLogSchema from shared

## v1.11.1 (2026-02-07)
- Inline path editing in admin dashboard edit dialog with migration confirmation
- AlertDialog component (shadcn/ui + @radix-ui/react-alert-dialog)
- Path changes in edit mode trigger migration workflow with warning dialog
- Dynamic tool count tests across all repos (no more hardcoded assertions)

## v1.11.0 (2026-02-07)
- Route migration feature: atomically move routes between paths preserving config and timestamps
- New API endpoint: `POST /api/routes/migrate?oldPath=...&newPath=...`
- MCP `migrate_route` tool (11 tools total)
- Admin dashboard: `useMigrateRoute` hook and API client method
- Shared client: `migrateRoute()` method on EdgeRouterClient
- AuditAction type extended with 'migrate'
- 9 new tests for migration (450 total)

## v1.10.3 (2026-02-07)
- Replace active CI/CD workflow with PR-only CI pipeline (lint + test + build)
- Rename ci-cd.yml to ci-cd.yml.example (template for forkers)

## v1.10.2 (2026-02-07)
- Non-breaking dependency upgrades (hono 4.11.8, zod 4.3.6, wrangler 4.63.0, typescript-eslint 8.54.0, @modelcontextprotocol/sdk 1.26.0, and admin UI deps)

## v1.10.1 (2026-02-05)
- Command Palette with Cmd+K for quick navigation

## v1.10.0 (2026-02-05)
- Open Graph Parser API with SSRF protection
- Link Preview component for redirect/proxy targets
- Keyboard shortcuts and Kbd UI component

## v1.9.x
- R2 streaming for large files
- Node 24 & ES2024 upgrade
- CI/CD pipeline enhancement

## v1.8.0
- Proxy Host Header Override (`hostHeader` option)

## v1.7.0
- API Shield Schema Validation

## v1.6.0
- R2 Backup Health Check System

## v1.5.0
- Force Download Option for R2 Routes

## v1.4.0
- Preserve Path Feature for Wildcard Redirects

## v1.3.0
- R2 Backup System

## v1.2.0
- Unified KV Architecture (single namespace)

## v1.0.0
- Initial public release
- Project renamed to Bifrost

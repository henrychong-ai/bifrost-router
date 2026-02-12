# Changelog

All notable changes to this project are documented in this file.

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

# TODO

Open work for this repository, grouped by priority, one item per line. Update
this file in the same change that opens or closes an item; the
[CHANGELOG](./CHANGELOG.md) records what shipped (AGENTS.md → Public
repository). Items moved here from the CHANGELOG "Follow-ups" lists in
v1.39.0.

## P1 — correctness and operations

- **Backup health: an R2 read error is reported critical, like corruption.** `src/backup/health.ts` gives it its own message (`BackupReadError`, v1.37.1) but the same severity; report a storage fault as a warning and only a content failure as critical.
- **The 16 MiB backup cap is all-or-nothing across every domain.** One oversized record (about 120 QR codes with the largest logo, or a route target of several MiB) stops every nightly backup until `MAX_BACKUP_BYTES` is raised; health warns from 8 MiB. Skip and report oversized records, or stream the gzip so the cap can be higher.
- **Operations, per deployment (not recorded as run for any deployment):** sweep the route store for targets that predate the v1.36.0 write-time credential guard (`scripts/scan-route-credentials.mjs` takes a read-only inventory); scrub analytics rows written before v1.36.0, which may hold credential values in `query_string` or `referrer`; repair any legacy route key holding `?` or `#` by its EXACT KV key, never through the API (`DELETE /api/routes` normalises and would delete a different, live route; CHANGELOG v1.36.0 → Follow-ups); decide whether Cloudflare's request logs (`[observability]` invocation logs and traces, on in `wrangler.toml`), which record each request's URL and query, should stay on or be restricted (AGENTS.md → Worker logs).

## P2 — robustness and performance

- **Link previews: one deadline across redirect hops.** `GET /api/metadata/og` gives each hop its own 5 s timeout, so a preview that follows five redirects can take about 30 s.
- **Backup health verifies the archive on every call, and reads each object twice** (a HEAD for the file check, then a GET for the manifest and the content scan). Record a verified archive's SHA-256 or ETag and skip the scan while the stored object still matches; take sizes from the GET.
- **A new QR code can be missing from MCP `list_qrs`, the REST API and other browser tabs** until KV listing catches up (about 60 s): only the dashboard that created it merges it. A server-side recent-writes key would give every client the same list.
- **A pending QR code can show on page 1 after the server lists it on page 2,** for up to the five-minute TTL of the dashboard's pending store (`admin/src/lib/qr-pending.ts`).
- **Route edits: a client precondition (optional).** `PUT /api/routes` refuses a route that changed between the handler's two reads (409 `ROUTE_SOURCE_CHANGED`, v1.39.0) and answers 404 for one deleted in between, best effort only: KV has no compare-and-set and both reads usually come from one edge cache. The dashboard could send the `updatedAt` it loaded and the Worker refuse a mismatch, which would also catch an edit made before the dialog was opened.
- **nginx's error log names the request line, the client address and the Referer of an `/api` call that fails at the proxy** (a refused upstream certificate, a timeout, a body over the limit), query included; the access log is metadata only (v1.39.0). Decide between a quieter error log in the `/api` location (losing the reason for a 502) and leaving it, documented as now.
- **Some stored object keys cannot be reached through the dashboard.** A key with a backslash: `objectKeySegments` sends it as `%5C`, which the dashboard proxy refuses (400 `BAD_API_PATH`). A key with a leading slash, an empty segment (`/report.pdf`, `a//b`, a trailing `/`) or a `.` or `..` segment: `objectKeySegments` throws rather than send it, because a URL would address another key, and the dashboard reports the key as not addressable. The Worker's `validateR2Key` refuses all of these too, so none is reachable or creatable through the API or MCP; they can only predate it or come from another R2 client. Reaching them would need a key carried outside the URL path (a query or body field).
- **Release the collected `lines` array after the join** in `backupKV` (`src/backup/kv.ts`). At the cap the job peaks at about 48–70 MiB (the lines, the joined NDJSON and its gzip).

## P3 — tidy-ups

- **Add a shared `nextCursor` helper** for the R2 and KV listings, which each check a truncated page's cursor themselves.
- **`getDomainFromRequest` reads each selector twice** (`src/routes/request-context.ts`): once for the conflict check, again to validate it.
- **The backup's byte counter is one byte stricter than the verifier:** it counts a newline after the last record, which the joined NDJSON does not have.
- **One internal-header rule for the Worker, the dev proxy and nginx.** `admin/dev-api-proxy.ts` repeats `INTERNAL_HEADER_PREFIXES` / `isInternalHeader` (`src/utils/internal-headers.ts`) and the nginx maps repeat it by hand; export the rule from `@bifrost/shared`, use it in the dev proxy and have `check-dashboard-security` assert the template matches.
- **`og-own-host.ts` filters its fixed request headers twice** (`withoutInternalHeaders` on a constant with no internal header, then `safeServiceFetch` again); pass the constant directly.
- **Run the dashboard container check in CI.** `pnpm run check:dashboard-container` (Docker) is not part of `pnpm run check`; run it after any change to the dashboard image, the nginx template or its renderer.
- **Confirm code-scanning alerts #5, #6 and #7 close** on the first scan after v1.39.0 (`scripts/check-public-sanitization.mjs`, `shared/src/link-naming.ts`, `shared/src/r2-key.ts`), and that no new polynomial-regex alert opens for `shared/src/r2-key.ts` or `shared/src/qr.ts`; if #5 stays open, dismiss it with the reason in that function's comment (it tests whole host labels, not a URL).

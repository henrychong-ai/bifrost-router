# TODO

Open work for this repository, grouped by priority, one item per line. Update
this file in the same change that opens or closes an item; the
[CHANGELOG](./CHANGELOG.md) records what shipped (AGENTS.md → Public
repository). Items moved here from the CHANGELOG "Follow-ups" lists in
v1.39.0.

## P1 — correctness and operations

None open.

## P2 — robustness and performance

- **MCP refusals are recognised by their text.** `mcp/src/server.ts` sets `isError: true` when a tool's answer matches `/^Error[: ]/` (v1.40.0), so a new handler that words a refusal differently, or a successful answer that starts with `Error`, is misclassified. Move the handlers to typed results (`{ text, isError }`) so each says what it is.
- **Recent QR writes share one key per domain.** Each QR create reads and rewrites `qr-recent:{domain}` after its answer (`recordRecentQRWrite` in `src/kv/qr-recent.ts`, run through `waitUntil` by the create handler, v1.40.0): concurrent creates contend for KV's one write a second per key and can drop an id (logged, never a failed write; the code then shows when KV's listing catches up). Consider per-id keys or another design that does not depend on KV list consistency.
- **The audit actor is a client-supplied header for API-key callers.** After API-key authentication the actor is `Tailscale-User-Login` as the request carries it (`src/routes/request-context.ts`, `src/routes/storage.ts` and `src/routes/feedback.ts`, each falling back to `api-key`), so any key holder can name another actor in the audit trail. The dashboard's nginx sets the header itself; other clients are not checked. Decide whether API-key callers may set it (pre-existing).

## P3 — tidy-ups

- **Drop the healthcheck's TCP branch from v1.41.0.** The `:tailscale` compose healthcheck falls back to `http://127.0.0.1:3001/health` when the socket is missing, so a rollback to an image from before v1.39.0 stays healthy, and v1.38.x (released 2026-10-07) is still a reasonable rollback target. Once v1.38.x and earlier no longer are (two minor releases after v1.39.0, so from v1.41.0), drop that branch and its README and AGENTS.md mentions, and have the container check assert port 3001 does not answer the healthcheck.
- **Turn on `noUncheckedIndexedAccess` in the root (Worker) `tsconfig.json`.** With it, `pnpm exec tsc --noEmit -p . --noUncheckedIndexedAccess` reports 122 errors across 31 files under `src/` (most in `src/audit/cf-audit-poll.ts`, `src/routes/admin.ts`, `src/queue/r2-events.ts` and `src/routes/storage.ts`). One is in `src/utils/credential-redaction.ts`, a vendored file pinned by hash in `credential-redaction.json`: a vendored, hash-pinned file must change upstream first, then be re-vendored with its new digest, before the flag can be enabled.
- **The routing benchmark's baselines are all 1.0 with a 1.15 limit**, while measured medians reach about 1.07–1.09 under load (`scripts/check-routing-benchmark.mjs`), so headroom is small. Consider per-benchmark baselines measured on an idle machine, or the median of five runs.
- **An operator can meet a 409 on their own edit.** The edit dialog sends the opened record's `updatedAt` (v1.40.0); reopening a route before the refetch after a save or toggle lands sends the old stamp, so the save answers 409 `ROUTE_SOURCE_CHANGED` (the dialog closes and reopening works). A detail cache keyed by domain and path, updated with `setQueryData` from each write's answer, would remove it.
- **nginx clears only the named internal headers.** The `/api` proxy clears `X-Bifrost-Dashboard` and sets the key and identity headers by name; another `X-Bifrost-*` header a client sends still reaches the Worker, which never trusts them. Clearing every one would need an nginx module or an allowlist map of forwarded headers.
- **The dashboard script check covers `<script>` elements only.** `scripts/check-dashboard-security.test.mjs` does not reject inline event-handler attributes (`on*`) or `javascript:` URLs on other elements, and it reads the source `admin/index.html`, not the built `admin/dist/index.html`. The CSP (`script-src 'self'`, no `'unsafe-inline'`) blocks both at runtime; sweeping every element's attributes and checking the build output would make the test match its name.
- **The dashboard names a fixed external font host.** `admin/index.html` preloads its font from one host and the nginx CSP `font-src` allows it. Make the host configurable alongside the other deployment settings, or self-host the font, so the template carries no deployment-specific host.
- **The dashboard build strips HTML comments with a regular expression.** `admin/src/lib/strip-html-comments.ts` matches `<!--…-->`, which misses comments that end with `--!>` and the `<!-->` form, the same class as the v1.40.1 CodeQL alert. Strip comments with `parse5` (already a root devDependency) as the file's own limitation note suggests. Also have `scripts/check-dashboard-security.test.mjs` parse each input once (it parses twice per call today).

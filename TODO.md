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
- **The audit actor is a client-supplied header for API-key callers.** After API-key authentication the actor is `Tailscale-User-Login` as the request carries it (`src/routes/request-context.ts`, `src/routes/storage.ts` and `src/routes/feedback.ts`, each falling back to `api-key`), so any key holder can name another actor in the audit trail. The dashboard's nginx sets the header itself; other clients are not checked. Decide whether API-key callers may set it (pre-existing).

## P3 — tidy-ups

- **Turn on `noUncheckedIndexedAccess` in the root (Worker) `tsconfig.json`.** With it, `pnpm exec tsc --noEmit -p . --noUncheckedIndexedAccess` reports 122 errors across 31 files under `src/` (most in `src/audit/cf-audit-poll.ts`, `src/routes/admin.ts`, `src/queue/r2-events.ts` and `src/routes/storage.ts`). One is in `src/utils/credential-redaction.ts`, a vendored file pinned by hash in `credential-redaction.json`: a vendored, hash-pinned file must change upstream first, then be re-vendored with its new digest, before the flag can be enabled.
- **The routing benchmark's baselines are all 1.0 with a 1.15 limit**, while measured medians reach about 1.07–1.09 under load (`scripts/check-routing-benchmark.mjs`), so headroom is small. Consider per-benchmark baselines measured on an idle machine, or the median of five runs.
- **nginx clears only the named internal headers.** The `/api` proxy clears `X-Bifrost-Dashboard` and sets the key and identity headers by name; another `X-Bifrost-*` header a client sends still reaches the Worker, which never trusts them. Clearing every one would need an nginx module or an allowlist map of forwarded headers.
- **The dashboard script check covers `<script>` elements only.** `scripts/check-dashboard-security.test.mjs` does not reject inline event-handler attributes (`on*`) or `javascript:` URLs on other elements, and it reads the source `admin/index.html`, not the built `admin/dist/index.html`. The CSP (`script-src 'self'`, no `'unsafe-inline'`) blocks both at runtime; sweeping every element's attributes and checking the build output would make the test match its name.
- **The dashboard names a fixed external font host.** `admin/index.html` preloads its font from one host and the nginx CSP `font-src` allows it. Make the host configurable alongside the other deployment settings, or self-host the font, so the template carries no deployment-specific host.
- **The dashboard build strips HTML comments with a regular expression.** `admin/src/lib/strip-html-comments.ts` matches `<!--…-->`, which misses comments that end with `--!>` and the `<!-->` form, the same class as the v1.40.1 CodeQL alert. Strip comments with `parse5` (already a root devDependency) as the file's own limitation note suggests. Also have `scripts/check-dashboard-security.test.mjs` parse each input once (it parses twice per call today).
- **One shared after-answer helper for every audit site.** The route, storage and feedback handlers (`src/routes/admin.ts`, `src/routes/storage.ts`, `src/routes/feedback.ts`, and the Worker's own `waitUntil` sites in `src/index.ts`) each call `c.executionCtx.waitUntil(…)` inside `try`/`catch` and skip the work when there is no execution context (a test calling the app without one), while the QR handlers run theirs inline through a QR-local `afterAnswer` (`src/routes/qr.ts`, v1.41.0). Move a waitUntil-or-inline helper to a shared module and use it at every site, so every audit behaves the same; production always has a context, so only tests see the difference.
- **The QR listing reads recent codes even when its filters will drop them.** `listQRs` (`src/kv/qr.ts`) runs the D1 recent read and one KV `get` per recent id it lacks on every listing, also when the type, tag or search filter will then drop every merged code. Cheap at QR volumes (at most 100 rows, usually none); filtering on the row before the KV read is not possible (a row holds only the id and incarnation), but a search that cannot match a recent id, or a type or tag filter, could skip the reads whose records it would drop.
- **The public sanitisation check crashes on an unstaged deletion.** `scripts/check-public-sanitization.mjs` reads every tracked file, so a file deleted in the working tree but not yet staged makes it fail with `ENOENT` instead of being skipped. Skip tracked paths that no longer exist (the commit will drop them).

### v1.41.0 review residuals

- **Replace the route-listing cache patching with an awaited invalidation.** `applyRouteSaved`, `applyRouteMigrated`, `applyRouteRemoved` and `applyRouteTransferred` (`admin/src/hooks/use-routes.ts`) patch every cached listing by version identity and leave anything ambiguous to the refetch. Awaiting the invalidation (or refetching the edited route) before the dialog closes or the row is acted on again would remove the patching and its rules altogether.
- **Share `afterAnswer` beyond the QR handlers.** See "One shared after-answer helper for every audit site" above: move `src/routes/qr.ts`'s `afterAnswer` to a shared module and use it in `src/routes/admin.ts`, `src/routes/feedback.ts` and `src/index.ts`.
- **Drop the synthetic by-target `RouteList`.** `cachedListings` (`admin/src/hooks/use-routes.ts`) wraps a by-target answer (a bare `Route[]`) in a fake `RouteList` so the listing edits can treat it like one, and unwraps it on store. Give the edits a row-level shape both kinds share instead.

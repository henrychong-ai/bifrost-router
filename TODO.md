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

- **Drop the healthcheck's TCP branch after the next release.** The `:tailscale` compose healthcheck falls back to `http://127.0.0.1:3001/health` when the socket is missing, so a rollback to an image from before v1.39.0 stays healthy. Once no rollback target predates v1.39.0, drop that branch and have the container check assert port 3001 does not answer.
- **The routing benchmark's baselines are all 1.0 with a 1.15 limit**, while measured medians reach about 1.07–1.09 under load (`scripts/check-routing-benchmark.mjs`), so headroom is small. Consider per-benchmark baselines measured on an idle machine, or the median of five runs.
- **An operator can meet a 409 on their own edit.** The edit dialog sends the opened record's `updatedAt` (v1.40.0); reopening a route before the refetch after a save or toggle lands sends the old stamp, so the save answers 409 `ROUTE_SOURCE_CHANGED` (the dialog closes and reopening works). A detail cache keyed by domain and path, updated with `setQueryData` from each write's answer, would remove it.
- **nginx clears only the named internal headers.** The `/api` proxy clears `X-Bifrost-Dashboard` and sets the key and identity headers by name; another `X-Bifrost-*` header a client sends still reaches the Worker, which never trusts them. Clearing every one would need an nginx module or an allowlist map of forwarded headers.

# Changelog

All notable changes to Bifrost are documented in this file.

For deployment instructions and project context, see [CLAUDE.md](./CLAUDE.md).

---

## v1.36.0 (2026-09-17) — Credential redaction in the analytics recorders, a route-target guard, and an authenticated changelog

**Why:** ported from upstream Bifrost. A short link is routinely used as the
landing URL of a magic-link, verification or OAuth flow, so a request arriving
at one can carry a live credential in its query string — and the page that
redirected through it can carry another in its `Referer`. The four per-feature
analytics recorders stored both verbatim, and nothing stopped an operator
configuring a route whose TARGET carried one, which is worse: a target is
stored in KV, copied into the click analytics, written to the request log, and
exercised by every visitor. Separately, the dashboard compiled this changelog
into its JavaScript bundle, which is served with no credential check.

### Security and analytics

- **`link_clicks`, `page_views`, `file_downloads` and `proxy_requests` store
  `[redacted]` for credential-named query values.** One wrapper,
  `legacyQueryString(url)` in `src/utils/unified-traffic.ts`, used at all four
  recorder sites in `src/index.ts`. Every non-sensitive parameter — `utm_*`
  included — stays byte-identical, because these tables are the
  campaign-attribution source.
- **The same rows no longer keep a raw `Referer`.** `legacyReferrer()` redacts
  the referrer's query with the same predicate — a plain string scan, no URL
  parsing, no clamp, no scheme filter — so everything else in the referrer is
  byte-identical. A referrer whose only `?` sits inside its fragment is a hash
  route, not a query, and is returned untouched.
- **Sanitised fields sit AFTER the `...analyticsData` spread** at all four
  sites, so a future `getAnalyticsData` field can never overwrite a redaction.
- **The four ambiguous names keep SHORT values.** `code`, `state`, `session`
  and `ticket` read equally as campaign data and as bearer material, so they are
  redacted only when the value is credential-SHAPED: 20+ characters, OR all-hex
  at 12+, OR upper-plus-lower-plus-digit at 10+. `?code=SUMMER25`, `?state=CA`,
  `?session=morning` and `?ticket=vip` are stored as sent; an OAuth
  authorisation code or a CSRF state is not. ⚠️ The third test has a cost: a
  mixed-case campaign value carrying a digit, such as `Summer2026Sale`, is
  redacted too — name those parameters `promo=` or `tier=`, which are never
  matched, or keep the value single-case. A documented residual: an all-numeric
  OTP-shaped code stays raw.
- **Only the BARE names are ambiguous.** `cas_ticket`, `ticket_id` and
  `code_verifier` are always redacted, and `key` is unchanged because it is the
  conventional API-key parameter.
- **A credential nested inside a non-sensitive value is caught.** Before a
  segment whose own name is innocuous is stored, one bounded second look checks
  a `;` sub-pair (`?utm_source=x;token=…`), a nested query inside the decoded
  value (`?next=https%3A%2F%2Fapp%3Ftoken%3D…`, and the duplicated-`?` form
  `?a=1?token=…`), a nested FRAGMENT, and a packed `k=v&k=v` body
  (`?rt=uid%3D1%26access_token%3D…`). Both readings are COMBINED rather than
  alternatives, so neither discards the other's redactions. Depth is exactly
  one — no recursion, no decode loop — so double-encoded nesting is out of
  scope by design. An encoded tab, LF or CR is stripped from the decoded value
  first, because the URL parser strips it and a browser would then send
  `token=…` from a value that scanned clean.
- **Stored fidelity is explicit:** a value in which nothing was redacted is
  stored byte-identically; a value in which something was redacted is
  re-encoded. The legacy wrappers apply no length clamp.

### Route targets

- **A route TARGET can no longer carry a credential unnoticed.** `POST /api/routes`,
  `PUT /api/routes` (update and re-enable), `POST /api/routes/seed` and
  `POST /api/routes/transfer` refuse a target whose query or fragment carries a
  credential-named parameter, answering `400` with `ROUTE_TARGET_CREDENTIAL` and
  the parameter NAMES — never the values. The write proceeds only when the
  request sets `acknowledgeCredentialTarget: true`, a request-only flag stripped
  before anything reaches KV. Disabling a route is never refused, and `r2`
  object keys are not URLs so they are not examined.
- **The guard errs wide on purpose.** It uses the name-only predicate, not the
  narrowed rule above, so `?code=SUMMER25` in a TARGET is flagged. A human is
  being asked and can acknowledge in one click; the narrowed rule exists for
  stored rows that nobody reviews. ⚠️ It is write-time only — targets already in
  KV were never examined; see **Follow-ups**.
- **The guard also scans the target's FRAGMENT.** A referrer's fragment is left
  alone because browsers strip it before sending one, but a route target travels
  the other way: the Worker puts it in `Location:` and the browser keeps it. So
  `https://app/#/reset?token=…` and an implicit-flow `#access_token=…` are
  caught, in both the hash-routed-query and the bare `k=v` shapes.
- **Control characters can no longer hide a parameter name.** The URL parser
  strips tab, LF and CR from anywhere in a URL, so a target reading
  `to<TAB>ken=LIVE` scanned clean and then served `?token=LIVE`. Targets now
  refuse control characters at the schema, and the guard scans both the
  control-stripped target and the parsed URL, so a route stored before this
  release is examined properly too.
- **A TRANSFER needs its own acknowledgement.** It cannot change a target, but
  it re-publishes it on another host: a link acknowledged for one brand's domain
  was never acknowledged for another's audience. A migrate, which only moves the
  slug within one domain, is unchanged.
- **The dashboard asks, rather than failing.** A refused create, save, enable or
  transfer raises a confirmation naming the parameters, and confirming re-sends
  the same write with the acknowledgement. An acknowledged write records the
  parameter names in the audit row.
- **`create_route`, `update_route`, `toggle_route` and `transfer_route` expose
  the same optional flag**, described so an agent asks the human before setting
  it. The flag is parsed through the shared MCP boolean coercion, so a client
  that stringifies its arguments is understood rather than refused for ever.

### Fixed

- **Route reads and writes now use ONE key.** Path normalisation strips `?` and
  `#` before decoding, so it was not idempotent — `/p%3Fx` collapsed to `/p` on
  a second pass. Update, delete, migrate and transfer normalised once and then
  read through a function that normalised again, so the read could resolve a
  different record from the write. A general correctness fix, and it closes a
  route by which an update could publish a second, unexamined copy of a route.
  `deleteRoute()` also now normalises its path exactly once, like every other
  mutation.
- **Route paths refuse `?`, `#` and a double-encoded `%`.** A path such as
  `/p%3Fx` was accepted, stored under a key containing `?`, and listed back in a
  form that normalised to a DIFFERENT route — so an edit or delete aimed at the
  listed value hit the wrong record. `/p%253Fx` orphaned the route entirely. The
  same check now runs on `POST /api/routes/migrate`, which previously validated
  only the leading slash.
- **The stdio `toggle_route` refuses an unrecognised `enabled` value.** `"false"`
  now disables (it used to be truthy and ENABLE), and anything the shared schema
  does not recognise — `"off"`, `"disabled"`, `"n"` — is answered with an error
  and the route is left untouched, rather than guessed at. A toggle is often the
  response to an abused link, so it fails closed.
- **The API client carries a refusal's sentence as well as its code.** A handler
  that sends both `error` and `message` is using `error` as a machine code, and
  the sentence is the part a human or an MCP caller needs. Bodies without
  `message` are byte-identical to before.

### Changed

- **The changelog is served from an authenticated route.** The dashboard used to
  compile `CHANGELOG.md` into its JavaScript bundle, and the built assets are
  served with no credential check. The page now fetches `GET /api/changelog`,
  which is mounted on the admin chain and so inherits the same `ADMIN_API_KEY`
  middleware as route management, returning `text/markdown` with
  `private, max-age=300`. A build gate (`pnpm run check:changelog-bundle`) fails
  the release if a release heading reappears anywhere under `admin/dist`, so the
  import cannot return silently.
- **`CHANGELOG.md` now has a generated companion the Worker serves.** Run
  `pnpm run changelog:generate` after ANY changelog edit; `pnpm run check` fails
  while `src/generated/changelog-text.ts` is stale. Wrangler can load a Markdown
  text module, but the Workers test pool refuses a `.md` specifier, so the
  document is a checked-in module instead.
- **Recorder test harness lifted.** The execution-context helper, the
  worker-serving helper and the four legacy analytics DDLs live in
  `test/helpers.ts` rather than being copy-pasted per suite. The worker is
  imported lazily there, so suites that never serve a request do not pull the
  generated changelog module into their bundle.
- **`ApiError` moved to `admin/src/lib/api-error.ts`**, so a caller that needs
  only the error shape does not import the API client, which validates the
  runtime environment at module load.
- **Tooling:** the root lint, format, Workers-pool test and benchmark sweeps now
  ignore `.claude/worktrees/**`, where a coding harness places isolated
  worktrees, and the test sweep excludes nested `node_modules` explicitly (its
  exclude list replaces vitest's defaults). `vitest bench <file>` filters by
  substring, so a sibling copy would double the routing gate's measurements.

### Behaviour to know about

Neither the recorders nor the guard rewrites anything already stored. Rows
written before this release keep whatever they captured, and route targets
already in KV were never examined.

### Follow-ups

- Sweep the route store for targets that predate the write-time guard, and
  re-examine them. The guard only fires on a write.
- Scrub historic analytics rows written before this release, which may hold
  credential values in `query_string` or `referrer`.

### Tests

Unit matrix for the redaction rules (ambiguous-name shape, `;` sub-pairs,
nested query and fragment, packed pair lists, control stripping, byte fidelity,
`findCredentialParams`); worker-driven tests that read the persisted D1 row back
for all four recorders across both columns; guard tests for create, update,
re-enable, seed, transfer and migrate, including that the acknowledgement never
reaches KV; single-key regression tests for update, delete and migrate; an
authenticated-changelog route test; catalog and schema tests for the
acknowledgement flag; and a node-native gate test for the bundle scanner.

---

## v1.35.1 (2026-09-13) — MCP: route timestamps render correctly

**Why:** `get_route` — and every other MCP reply that prints a route's details —
dated every route to the year 58000. The formatter treated the stored
timestamps as Unix seconds when they are epoch milliseconds, so each displayed
date was the real one multiplied by a thousand. No stored route data changed —
the defect was confined to the MCP text rendering — but it made the details
block useless for telling a fresh route from an old one.

### Fixed

- **Route `Created:` / `Updated:` lines show the real dates again.** Routes are
  stamped with `Date.now()` in `src/kv/routes.ts`, i.e. epoch MILLISECONDS, but
  `formatRouteDetails` in `mcp/src/tools/routes.ts` passed
  `route.createdAt * 1000` (and the same for `updatedAt`) to `new Date()` — a
  thousandfold overshoot that put every route roughly 56,000 years into the
  future. Both lines now go through one `formatRouteTimestamp()` helper that
  hands the stored value to `new Date()` unchanged, so the unit is stated once
  instead of being re-derived at each call site. Every handler that renders the
  details block is fixed with it: `get_route`, `create_route`, `update_route`,
  `toggle_route`, `migrate_route` and `transfer_route`. `mcp/src/tools/analytics.ts`
  is deliberately untouched — its `Math.floor(Date.now() / 1000)` is the
  analytics API's own seconds contract, not a route timestamp. The route
  fixtures in `mcp/src/tools/*.test.ts` now hold milliseconds, exactly as the KV
  layer writes them, and the `get_route` details test pins the rendered output
  at `Created: 2024-01-01T00:00:00.000Z` and `Updated: 2024-01-01T00:00:00.000Z`
  — a seconds-versus-milliseconds regression cannot pass it. A second `get_route`
  test stamps a route from the live clock and asserts both rendered lines carry
  the current year, so the fixture and the expected literal cannot be reverted
  as a pair and stay green.

---

## v1.35.0 (2026-09-13) — MCP: `EDGE_ROUTER_DOMAIN` removed; every domain-scoped call names its domain

**Why:** v1.34.1 made the seven route tools refuse a missing domain, but left
two halves of the same contract disagreeing — the stdio server still defaulted
the domain from `EDGE_ROUTER_DOMAIN`, and the QR tools defaulted from it too,
falling through server-side to the API's `ADMIN_API_DOMAIN` when unset. That is
the silent wrong-domain hazard v1.34.1 removed from the route tools, still open
on every QR read and write: a QR meant for one domain landed on whatever host
the API happened to default to. This release deletes the default plumbing
outright. It is the port of the upstream change made in the private edge-router
deployment this repo is derived from.

### Breaking

- **`EDGE_ROUTER_DOMAIN` is removed.** Nothing reads it: not
  `createClientFromEnv` (`shared/src/client.ts`), not the stdio server
  (`mcp/src/index.ts`). `EdgeRouterClient` has no `defaultDomain` config field
  and no `getDomain()` helper, so no client method fills in a missing domain.
- **`domain` is REQUIRED and enumerated on 14 tools** — the seven route tools
  (`list_routes`, `get_route`, `create_route`, `update_route`, `delete_route`,
  `toggle_route`, `migrate_route`), the six QR tools (`list_qrs`, `get_qr`,
  `create_qr`, `update_qr`, `delete_qr`, `get_route_qr`) and `get_slug_stats`.
  `transfer_route` keeps both `from_domain` and `to_domain` required, as
  before; its error text just no longer names the environment variable. The
  requiredness lives in the SHARED schemas (`RequiredDomainSchema` in
  `shared/src/schemas.ts`, the QR field in `shared/src/qr.ts`) and in the
  catalog's `required` arrays (`shared/src/tools.ts`). Before this release
  `transfer_route` was the ONLY tool in the catalog listing a domain field
  under `required`, and it is not one of the 14 — so all 14 `domain` entries
  are new. `list_routes` and `list_qrs` had no `required` array at all, so one
  was created rather than extended.
- **The three analytics tools keep an OPTIONAL but ENUMERATED domain**
  (`get_analytics_summary`, `get_clicks`, `get_views`) — `OptionalDomainSchema`
  in `shared/src/schemas.ts`, so the catalog and the schemas advertise the same
  choices and a client picks one without guessing. Omitting it means all
  domains: the query layer adds `WHERE domain = ?` only when a value is
  present, so it is a scope, never a default. The stdio server no longer
  injects a hidden environment filter there. `get_slug_stats` is the exception
  in that family and is now required: the same slug can exist on several
  domains, and an unscoped read silently merged their clicks into one total.
- **QR tools can no longer reach the API's admin-host fallback from MCP.** With
  `domain` required at the schema level and guarded in the stdio handlers, an
  omitted domain is refused before any request is built.
- **Analytics results widen for anyone who used `EDGE_ROUTER_DOMAIN` as a
  scope.** The stdio server used to inject the variable as a hidden filter on
  `get_analytics_summary`, `get_clicks` and `get_views`, so an operator who set
  it saw one domain's numbers by default. Those three calls now report ALL
  domains when `domain` is omitted. Pass it explicitly to narrow — the value is
  enumerated, so a client can pick one without guessing.
- **Stdio boot warning.** A stale `EDGE_ROUTER_DOMAIN` never fails startup: the
  server logs one stderr line — `EDGE_ROUTER_DOMAIN is set but ignored since
  v1.35.0 — pass domain on every route, QR and slug-stats call.` — and serves
  normally.

### Changed

- **`shared/src/client.ts`** lost `EdgeRouterClientConfig.defaultDomain`, the
  private field, the constructor assignment, and `getDomain()`. The seven route
  methods, the seven QR methods and `getSlugStats` take a required `domain`;
  `getAnalyticsSummary` / `getClicks` / `getViews` keep `domain?`. The request
  builder still skips `undefined` params, so an omitted analytics domain sends
  no query parameter at all.
- **Handlers** (`mcp/src/tools/{routes,qr,analytics}.ts`): all 17 lost their
  third `defaultDomain` parameter, and the 17 dispatch cases in
  `mcp/src/index.ts` lost the trailing argument. `routes.ts` exports
  `NO_DOMAIN_ERROR` and a `requireDomain()` helper that the QR and slug-stats
  handlers share. The low-level stdio `Server` validates nothing, so these
  guards are the enforcement on that transport.
- **Catalog descriptions** (`shared/src/tools.ts`): no description mentions an
  environment variable or the admin-host fallback any more, and
  `get_slug_stats` gets its own wording (the same slug can exist on several
  domains).
- **Tests.** `mcp/src/tools/routes.no-domain.test.ts` is parameterised over all
  14 required tools (error text, every supported domain listed, no client call,
  empty string refused too). `shared/src/tools.test.ts` gains a catalog
  contract block pinning the 14 required and the 3 optional, the enum on every
  `domain` property, and the absence of any environment-variable wording.
  `shared/src/schemas.test.ts` pins the required and optional enums.
  `mcp/src/tools/analytics.test.ts` adds real-client cases proving an omitted
  analytics domain sends no `domain` query param and a supplied one scopes the
  request to exactly it. `shared/src/client.test.ts` proves a stale
  `EDGE_ROUTER_DOMAIN` is ignored end to end.
- **Docs.** `CLAUDE.md`, `README.md`, `mcp/README.md` and the dashboard's MCP
  install snippets drop the variable; `mcp/PLAN.md` carries a historical
  banner. The "install mcp" trigger no longer asks the user for a default
  domain.

**Follow-ups** (this repo has no `TODO.md`, so they are recorded here):
1. **REST API: require an explicit domain on mutating endpoints instead of the
   `ADMIN_API_DOMAIN` fallback.** `getRequiredDomainFromRequest`
   (`src/routes/request-context.ts`) still resolves `X-Domain` > `?domain` >
   `ADMIN_API_DOMAIN` > a hardcoded literal. It is no longer reachable from
   MCP, but it still backs every QR endpoint (`src/routes/qr.ts` — list, get,
   create, update, delete, `/:id/image`, `/from-route`) and the mutating route
   endpoints in `src/routes/admin.ts` (`POST`/`PUT`/`DELETE /api/routes`,
   `/api/routes/seed`, `/api/routes/migrate`, and the single-route
   `GET /api/routes?path=`). Decide whether the dashboard relies on it before
   removing it.
2. **stdio MCP server: validate arguments through the shared Zod schemas at
   dispatch.** `mcp/src/index.ts` uses the low-level SDK `Server`, which
   validates nothing: handlers receive raw JSON-RPC `arguments` cast with `as`.
   That is why the domain contract is enforced by hand-written handler guards.
   Parsing each tool's arguments through the matching shared `*InputSchema`
   would cover every other field too and keep the catalog, the schemas and the
   wire from drifting apart. It also closes `requireDomain()` accepting any
   non-empty string without checking it against `SUPPORTED_DOMAINS` (the API
   refuses an unsupported one, so it is a worse error rather than a wrong
   write); it is the moment to move `requireDomain` / `NO_DOMAIN_ERROR` out of
   `mcp/src/tools/routes.ts` into a neutral `mcp/src/tools/domain.ts` under an
   honest name, now that the QR and analytics handlers import them from a file
   named after route tools; to enumerate `linkedRoute.domain` in the QR schemas
   (`shared/src/qr.ts` still types it as a bare `z.string()`); and to export one
   required/optional tool-list constant from `shared` so the 14/3 split stops
   being hand-maintained in `shared/src/tools.ts`, `shared/src/tools.test.ts`
   and `mcp/src/tools/routes.no-domain.test.ts` independently. It is also what
   enforces enum membership for the three optional-domain analytics tools: the
   catalog and the shared schemas both enumerate `domain`, but nothing on the
   stdio path parses them, so a misspelled domain is passed to the API as a
   filter and comes back as an empty result rather than an error. Deliberately
   not patched piecemeal here — one guard per tool would be the third
   hand-maintained copy of the same list.
3. **stdio refusals are returned as success-shaped results.** `mcp/src/index.ts`
   returns each handler's error string as ordinary `content` with no
   `isError: true`, so a client cannot tell a refusal from an answer without
   reading the prose. Fix with structured handler errors plus stdio wire
   assertions on `isError`.
4. **The stdio `Server` metadata version is a static `'1.0.0'`**
   (`mcp/src/index.ts`), so `initialize` reports a version unrelated to the
   release. Source it from the root package version at build time.
5. **Slack bot: never default the domain — require or confirm it, especially for
   delete/toggle.** `slackbot/src/slack/events.ts:219` resolves
   `command.domain || accessibleDomains[0] || '<placeholder>'` before `create`,
   `delete` and `toggle`, so a message that names no domain acts on whichever
   domain happens to sort first in the user's permissions. This is the same
   hazard the MCP layer just closed, still open on the Slack surface.
6. **Test files are not typechecked by any tsconfig; include them.** `*.test.ts`
   sits outside every project's `include`, so a type error in a test surfaces
   only as a runtime failure — or not at all, in a branch the test never takes.
7. **Derive the 14-tool handler-guard list from the catalog.** The guarded tools
   and the catalog's `required` arrays are maintained by hand in separate files,
   so a new domain-bearing tool can ship with a catalog `required` entry and no
   handler guard — advertised as required, unenforced on the only transport this
   repo has.
8. **`formatRouteTimestamp()` throws on a missing or non-finite value.** Added
   in v1.35.1, `mcp/src/tools/routes.ts` hands the stored number straight to
   `new Date()` and calls `.toISOString()`, which raises a `RangeError` on
   `undefined`, `null` or `NaN`. It is unreachable from a real record — every KV
   route write stamps both fields — and all six call sites sit inside a handler
   `try`/`catch`, so it would surface as an error string rather than a crash.
   Guard it, and validate client responses against `RouteSchema`, when the
   shared-client validation work in item 2 lands.

---

## v1.34.1 (2026-09-11) — MCP: the domain parameter says when it is required

**[fix] The no-domain error from the seven route tools now lists
`SUPPORTED_DOMAINS`** and says `EDGE_ROUTER_DOMAIN` is set in the MCP server's
environment — it is read by the server process, never sent by the client. The
previous text told the caller to set an environment variable without naming a
single valid domain.

**[fix] `transfer_route` gains the guard the other seven route tools had.** It
was the only route handler with no missing-domain check and no
`EDGE_ROUTER_DOMAIN` fallback, so an omitted domain reached the API and came
back as its raw 400. Both domains are required and never defaulted — a transfer deletes the
  route from the source, so guessing it from `EDGE_ROUTER_DOMAIN` would delete
  from a domain the caller never named — and a missing one returns an error
  naming which, with the supported domains. Every route handler's guard is pinned in
`mcp/src/tools/routes.no-domain.test.ts`.

**[docs] The `domain` description no longer reads as if a default always
exists.** The shared tool catalog stops reusing one description for three
different behaviours: the seven route tools say the field is optional only when
the server process sets `EDGE_ROUTER_DOMAIN`, and otherwise required; the
analytics tools call it an optional scope (the env default first, else every
domain the caller may see); the QR tools say it selects the QR's domain
namespace (the env default first, else the API's `ADMIN_API_DOMAIN`). The `list_routes` Zod schema and the `mcp/README.md`
environment table match.

---

## v1.34.0 (2026-09-11) — Feedback priority P0-P3, severity removed

**[feature] The feedback queue now has one urgency axis: a four-level P0-P3
priority.** `0` is **P0 - Mission-critical**, `1` **P1 - Urgent**, `2`
**P2 - Important**, `3` **P3 - Routine**, replacing the Linear-style
0-none / 1-urgent / 2-high / 3-medium / 4-low integer. Because **0 is the TOP
level**, a new item starts at the BOTTOM of the scale and triage raises it:
`FEEDBACK_PRIORITY_DEFAULT` is `3`, the create path writes it explicitly rather
than relying on a column default, and the submit dialog lets the reporter pick a
level. The levels and their labels are spelled exactly once, in
`shared/src/feedback.ts` — `FEEDBACK_PRIORITIES`, `formatFeedbackPriority()`,
and a `FEEDBACK_PRIORITY_SCALE_DESCRIPTION` derived from them by value lookup,
never by array index.

**[feature] The queue table gains a Logged column, and priority reads as a
label everywhere.** Each row shows the submission date with an age hint
(`48d ago`) from `formatFeedbackAge()` — computed once per render into a Map
keyed by row id, so every row is measured against the same instant. The table
cell, the detail dialog, the markdown export, and the `feedback_triage` audit
extras (`priorityLabel`) all print `P2 - Important` rather than a bare `2`; the
number alone stops meaning anything once the scale changes, and an audit row
outlives the release that wrote it.

**[fix] Priority validation never coerces.** `FeedbackPriorityInputSchema` is a
`z.preprocess` over digit-only strings, deliberately **not**
`z.coerce.number()`: coercion turns `null`, `''`, `false`, and `[]` into `0`,
which on this scale is P0 - Mission-critical. A malformed `priority` part on
`POST /api/feedback` is rejected with a 400 instead of silently filing the item
at the top of the queue. An out-of-range `?priority=` list filter is ignored
rather than 400-ed, matching the lenient per-field coercion the other filters
use.

### Breaking changes

- **`priority` is now bounded 0..3, and stored values are rescaled.** Migration
  `drizzle/0012_feedback_priority_scale.sql` maps old `0` (none) and `4` (low)
  to `3` and leaves old `1`, `2`, and `3` on their existing numbers — so a `1`
  now reads P1 - Urgent, a `2` reads P2 - Important, and a `3` reads
  P3 - Routine. It then moves the column to `NOT NULL DEFAULT 3`. Every old `0`
  becomes `3` even on a triaged row: on the old scale `0` was both "none" and
  the column default, so a stored `0` is not evidence anyone chose it, and
  carrying it across would promote those rows to P0 and drown the real ones.
  Re-triage by hand afterwards. A `priority` of `4` is now rejected by the API, the triage patch,
  and the OpenAPI schema.
- **`severity` is removed from the feedback feature entirely** — the column, the
  `FEEDBACK_SEVERITIES` enum and `FeedbackSeverity` type, the submit and triage
  schemas, the `FeedbackItem` shape, the OpenAPI blocks, and both dashboard
  dialogs. **Migration 0012 drops the column, so any stored severity values are
  lost**; export the table first (`GET /api/feedback/export?format=json`) if you
  want to keep them. Non-feedback severities (backup health, analytics insights,
  error display) are untouched.
- **Deploy the v1.34.0 Worker to an environment FIRST, then apply `0012` to
  that environment in the same window, once per environment, never twice.** The
  migration drops `severity`, and the old Worker names that column on every
  feedback insert and — through drizzle's expanded select — every feedback read,
  so applying first breaks submit, list, detail, and export with a 500
  (`no such column: severity`) until the deploy lands. Deploying first costs
  nothing: the new Worker never names `severity`, and it writes priority `3`
  explicitly on create, which the rescale maps to `3`. Do not triage between the
  two steps — a priority set to `0` before the rescale runs is mapped down to
  `3` along with the legacy zeroes. And never replay the file: this template
  applies migrations file by file and keeps no `d1_migrations` ledger, so
  nothing mechanical stops a second run, which maps every deliberate P0 back
  down to P3 (the final `DROP COLUMN` then fails, but only after the damage).
  Read the default back first — a `dflt_value` of `3` means it is already
  applied. README Step 5 carries the full upgrade note.

**[test] `scripts/check-migration-0012.test.mjs` replays the migration on an
in-memory SQLite in `pnpm run test:gates`.** It builds the pre-migration table
from the repo's own `0009_feedback.sql` so the fixture cannot drift, executes
every statement (a malformed one throws), and pins the column shape, the
recreated index, the full value mapping, the absence of any index/trigger/view
referencing `severity`, and the one-shot property. It also proves it is not
vacuous: a header line stripped of its `-- ` prefix must fail, because
`wrangler d1 execute --file` reports success and exits 0 on a file it could not
parse.

---

## v1.33.1 (2026-09-11) — Dependency security sweep

**[security] All known advisories cleared — `pnpm audit` reports no known
vulnerabilities.** Fourteen advisories (nine moderate, five high) were resolved
by raising the `pnpm.overrides` floors rather than pinning inside a vulnerable
range:

| Package | Advisories | Floor |
|---------|-----------|-------|
| `hono` | GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx | `>=4.13.5` (resolves 4.13.7) |
| `fast-uri` | GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp, GHSA-5jgf-p345-68v8 | `>=4.1.3` |
| `qs` | GHSA-4mjr-xmp4-gh2g, GHSA-x5fp-wj9c-mxmx | `>=6.16.0` |
| `sharp` | GHSA-rgj7-g3m4-5g8c | `>=0.35.4` |
| `vitest`, `@vitest/mocker` | GHSA-82fw-gwwq-j7x9 | 4.1.11 via the in-range sweep |

The `nanoid` override moved from `<3.3.17 -> 3.3.17` to `<3.3.18 -> 3.3.18`, so
the floor no longer sits on a version that later advisories reach.

**[chore] In-range minor/patch sweep across all five workspaces.** `zod` 4.6.2,
`hono` 4.13.7, `vitest` and `@vitest/coverage-*` 4.1.11, `@biomejs/biome`
2.5.13, `vite` 8.3.0, `@modelcontextprotocol/sdk` 1.30.x, `react`/`react-dom`
19.3 with matching `@types`, `react-hook-form`, `@tanstack/react-query`, the
`@radix-ui/*` set, `recharts`, `sonner`, `react-router`, `happy-dom`,
`lint-staged`, `tsx`, `eslint`, `typescript-eslint`, `@vitejs/plugin-react`,
and `eslint-plugin-react-refresh`. Held back deliberately:
`@cloudflare/vitest-pool-workers` 0.18.x, TypeScript 5.9.x, Vitest 4.x,
`@tanstack/react-table` 8.x, `@types/node` on its current major, and
`lucide-react` 0.575.x — each is a major-version move that needs its own
migration pass.

**[chore] Wrangler 4.114.0 -> 4.131.0.** Pinned exactly in the root and
`slackbot` packages, with both `worker-configuration.d.ts` runtime-type files
regenerated.

**[chore] Oxlint and `eslint-plugin-oxlint` 1.75.0 -> 1.82.0.** Root and
dashboard lint both stay green at `--max-warnings=0`; no new rules fired, so no
rule disables were added.

**[fix] Pre-commit hook no longer fails when only Biome-ignored files are
staged.** `worker-configuration.d.ts` is excluded in `biome.json`, so a commit
touching nothing else handed Biome an empty file set and it exited 1 with "No
files were processed". The lint-staged Biome tasks now pass
`--no-errors-on-unmatched`; every file Biome does format is still formatted.

---

## v1.33.0 (2026-08-26) — Range and conditional R2 serving

**[feature] R2 routes now honour `Range` and the HTTP precondition headers.**
`handleR2` hands the request's own headers to `bucket.get()` as `onlyIf` and
`range`, so R2 evaluates them, and the handler maps the result onto real HTTP:
**206** with a `Content-Range` carrying absolute offsets (all three `R2Range`
shapes, including suffix `bytes=-N`, resolved against the full object size, with
the slice length clamped to the bytes that remain), **304** for a failed
`If-None-Match`/`If-Modified-Since`, and **412** for a failed
`If-Match`/`If-Unmodified-Since`. `Accept-Ranges: bytes` and `Last-Modified` are
emitted on every shape. Entity-tag comparison follows RFC 9110 §13.1 — weak for
`If-None-Match`, strong for `If-Match`, `*` always matching. Byte-range resume,
media seeking, and cache revalidation all work for the first time; previously
the handler ignored both headers and streamed the whole object with a 200.

**[fix] `ETag` is the quoted `httpEtag` everywhere, never R2's raw `etag`.** The
raw value is a bare hash, which is not a valid HTTP entity-tag. A conforming
client echoes it back unquoted in `If-None-Match` and R2 rejects the request
outright. Because every object stored by an earlier release was served with the
raw form, returning clients WILL send it back: the handler degrades stepwise
when R2 refuses the request options — drop the range, then the precondition,
then read unconditionally — and warns instead of returning a 500. RFC 9110
§13.1/§14.2 explicitly permit ignoring a validator or `Range` that cannot be
used. A malformed or unsatisfiable `Range` recovers the same way, as a full 200.
A plain unconditional read that fails is still rethrown: degradation is scoped
to unusable request options, never to an R2 outage. The admin storage-download
and feedback-attachment endpoints emit `httpEtag` too.

**[fix] `If-Range` is evaluated by the handler (RFC 9110 §13.1.5).** R2's
`Headers`-shaped `range` option parses only `Range`, so `If-Range` is outside
its conditional model. A stale validator means the client's cached copy no
longer matches and its byte offsets are meaningless, so the `Range` is discarded
and the object re-read in full. Entity-tag form uses strong comparison; date
form is an exact match at second granularity. An `If-Range` value that is
neither form is IGNORED and the range proceeds, per the specification's MUST.

**[fix] The edge cache key is the URL alone, and range/conditional requests
bypass the cache in both directions.** The key previously carried the request
headers. Cloudflare's Cache API keys on URL, so those headers were **inert** —
they never fragmented the cache, and removing them is hazard removal rather than
a hit-rate fix. The corollary of a URL-only key is that a range or conditional
request must skip both the lookup and the write: a URL-keyed entry holds the
full 200 body, so serving it would ignore `Range` and never produce a 304. 206
and 304 responses are never written to `caches.default` — one client's byte
range replayed to the next requester as a whole object is a correctness bug.

**[fix] Route and object mutations purge the edge cache instead of waiting out
`max-age`.** New `purgeRouteUrl()` is the route-side complement of
`purgeR2CacheForObject()`: the object is unchanged but the route→object mapping
is, so the route's own URL holds the stale body. Route create, update, toggle,
delete, migrate, and transfer purge the route's URL for **r2 routes only**;
migrate and transfer purge both URLs, and an update purges when either the
before- or after-type is r2. Object delete, rename, move, metadata update, and
overwrite-upload purge the affected object URLs. Purge URLs are percent-encoded
per segment, since the cache entry lives under the encoded request URL. Every
purge now runs outside the audit-logging try block and carries its own rejection
handler, so cache invalidation is never skipped because an audit write threw and
a Cloudflare API failure cannot abort the invocation. Wildcard routes are
skipped with a warning: purge-by-URL does not expand `*` and purge-by-prefix is
an Enterprise feature, so issuing the call would delete nothing while reporting
success. Zone purge only — never `caches.default.delete()`, which evicts a
single colo while reading as a global purge.

**[fix] `file_downloads` records GET 200s only.** The gate was `response.ok`,
which also matched a 206 (one row per byte-range slice, `file_size` set to the
slice, cache status permanently MISS) and a HEAD probe (headers only, no bytes).
A 304 transfers nothing. The served R2 key is now resolved before the cache
lookup and recorded in preference to the route target, so a cache HIT is
attributed to the object actually served. In the unified traffic stream, 304
maps to the `success` outcome rather than `redirect`.

**[security] Unhandled-error diagnostics are credential-redacted.** A thrown
Error's message and stack are attacker-influenceable and routinely carry the
credential the failing call was holding. Both the structured log line and the
development-only diagnostic echoed in the response body now pass through the
shared `redactSensitive()` redactor.

**[feature] Leaderboard cards expand, and Recent Activity rows navigate.** The
two Top Routes cards gained accessible expand/minimise controls, so long source
and destination URLs get the full grid width without changing the underlying
analytics result. Recent Activity's Type cell was inert text; each row now links
to the matching Analytics page with the event's period, domain, country, path,
and monitoring state already applied, while the canonical source URL continues
to open the public route. Leaderboard metadata rows moved to the accessible
`charcoal-500` contrast token.

**[test] Drift guards for R2 bindings and supported domains.** Wrangler does not
inherit bindings into `[env.*]`, so a bucket added to the catalogue, the binding
map, and the top-level `[[r2_buckets]]` but not to `[[env.dev.r2_buckets]]` was
invisible to CI and would surface only on a deployed development Worker as a
handled 404. A new suite asserts every catalogue bucket has a development
binding, that production logical names equal their physical `bucket_name`, that
the out-of-catalogue `BACKUP_BUCKET` and `FEEDBACK_BUCKET` are declared in both
environments, and that `FEEDBACK_BUCKET` never joins the generic storage
resolver. `SUPPORTED_DOMAINS` parity is now asserted on runtime VALUES in exact
order — source-text parsing cannot see what a module actually exports — with the
dashboard copy covered by its own runtime suite. The dashboard coverage scope
now also includes `src/context/filter-types.ts`, which previously carried no
coverage mapping at all.

**[security] The built SPA shell no longer ships HTML comments.** A
`stripHtmlComments()` Vite plugin removes them from the build artefact while the
maintainer rationale stays in `admin/index.html` source; conditional and
hydration-marker forms are preserved.

### Deliberate strictness

Conditional-request handling has seven places where a naive implementation could
fail open, so this one is deliberately strict at each: strong preconditions are
re-evaluated after any degraded read that dropped `onlyIf` (412 rather than a
silent 200); `If-Unmodified-Since` is withheld from `onlyIf` when `If-Match` is
present, since §13.2.2 makes the date validator subordinate and R2's precedence
between the two is undocumented; the `If-Range` full re-read keeps `onlyIf` and
fails closed to 404 if the object was overwritten in the race window; an
unusable `If-Range` value is ignored rather than treated as a mismatch (§13.1.5
MUST); non-GET/HEAD methods receive 412 never 304 (§15.4.5) and never receive
the `range` option (§14.2); `If-Match` against a missing object returns 412 not
404 (§13.1.1); and a zero-length resolved range returns 416 rather than an
invalid `Content-Range`. Each is easy to lose in a refactor that only chases the
happy path, so the suite pins all seven.

### Known considerations

- **Download counts will step DOWN.** From this release a download delivered as
  a 206 is not recorded, and that includes a full-object `Range: bytes=0-`,
  which is what many media players and download managers send once they see
  `Accept-Ranges`. HEAD probes are no longer counted either. This is an
  instrumentation change, not a traffic change; the unified `traffic_events`
  stream still records every request, 206s included.
- **An unsatisfiable or malformed `Range` degrades to a full 200**, not a 416.
  RFC 9110 §14.2 permits ignoring a Range that cannot be used, and it is the
  same recovery path that stops a legacy unquoted validator returning a 500.
- **Query-string and mixed-case URL variants are separate cache entries** and
  expire via TTL only. A purge covers the canonical route URL; purge-by-prefix
  is an Enterprise feature.
- **Range and conditional requests bypass the edge cache by design**, and that
  cuts both ways for anyone watching the numbers. An unauthenticated client can
  force every request to origin by sending `Range: bytes=0-` — each one a full
  R2 read, with cache-hit rate driven towards zero. A **malformed conditional
  header** is worse: it cannot be satisfied, so the request degrades to a full
  200, which is cache-bypassed AND **recorded** as a download. Repeat it and the
  download count climbs while the cache-hit rate falls, with no corresponding
  traffic. Self-hosters serving large public objects should put a WAF
  rate-limit rule in front of their R2-serving paths, scoped to those paths and
  keyed on client IP — never on a caller-controlled header, which an attacker
  simply rotates.
- **Purge results are not surfaced.** `purgeRouteUrl()` and
  `purgeR2CacheForObject()` both return a `PurgeCacheResult`, and the automatic
  callers discard it inside `waitUntil`. A failed purge is logged but invisible
  to the operator who made the mutation; a future release may return it in the
  mutation response.
- **The admin OG-metadata endpoint echoes upstream fetch-error text.** It sits
  behind admin authentication, so this is a defence-in-depth note rather than an
  exposure: an authenticated operator can learn details of an upstream failure
  from the error string.
## v1.32.0 (2026-08-12) — domain-aware analytics and public release hardening

**[feature] The Dashboard is now a domain-aware operational overview.** Leaderboards
show canonical full source URLs and use explicit labels: **Top Routes - Redirect**,
**Top Routes - Proxy**, and **Top Website Pages** for service-bound HTML. Filters,
recent activity, period deltas, formula-safe CSV export, and bounded actionable
signals make route errors, cache performance, scanner noise, and traffic changes
visible without obscuring the underlying evidence.

**[analytics] Cloudflare Health Checks are excluded by default.** The exact,
case-sensitive `Cloudflare-Healthchecks/1.0` token is the only monitoring classifier;
unrelated bots and scanners remain visible. A labelled toggle restores matching rows.
Legacy headline totals are explicitly marked partial rather than presented as all
traffic.

**[analytics] Optional unified request shadow stream.** Migration `0011` and
`UNIFIED_TRAFFIC_*` controls add dormant-by-default, privacy-bounded public-request
capture. It records response outcomes without query strings, IP addresses, referrers,
User-Agent strings, or target URLs, remains separate from legacy headline totals,
and has bounded retention pruning after cutover.

**[security/ci] Public-distribution gates are permanent.** CI now fails on forbidden
private paths/content, non-placeholder Wrangler resource IDs, leaked secrets, stale
runtime bindings, dashboard security-header drift, or regression tests. The
Docker/nginx dashboard has a strict static-bundle CSP (`script-src 'self'`) plus
HSTS and baseline browser hardening; request logs drop query strings and configured
route targets.

**[docs/test]** API contracts, OpenAPI, migration/setup instructions, the in-dashboard
guide, version surfaces, and analytics/security tests were updated together.

**Verification:** see [PERFORMANCE.md](./PERFORMANCE.md) for the final v1.32.0
quality, coverage, bundle, routing, and Wrangler dry-run evidence.

## v1.31.0 (2026-08-10) — performance: concurrent wildcard lookup and route-level chunks

**[performance] Wildcard route lookup now parallelises fallback KV reads.** The
exact key remains first, while wildcard results are inspected in deterministic
most-specific-first order after concurrent loading. With the repository's 2 ms
KV latency model, an eight-segment root-wildcard hit improved from 19.9804 ms to
4.6129 ms (4.33x), and a full miss from 20.0000 ms to 4.6129 ms (4.34x).

**[performance] Every dashboard page is now a static route-level dynamic import.**
The shared shell stays eager and a common Suspense fallback covers navigation.
The production build's initial JavaScript fell from 959.61 kB to 241.45 kB raw
and from 280.85 kB to 75.53 kB gzip (73.11% smaller). A source-level regression
test protects all 13 page boundaries.

**[security] The dependency audit baseline is clear.** Updated Hono and exact
transitive resolutions for `undici`, `fast-uri`, `ip-address`, `brace-expansion`,
`nanoid`, and `postcss`; `pnpm audit` moved from 16 advisories (5 high) to zero.

**[security] The distributed tree received a fresh public-sanitisation pass.**
Private-origin comments, personal example data, and a machine-local Miniflare
UUID were replaced with generic examples or runtime discovery. Gitleaks now has
an exact allowlist for four documented public placeholders/test fixtures without
excluding any paths or weakening the default rules.

**[docs/test]** Added `PERFORMANCE.md`, a reproducible routing benchmark,
wildcard concurrency/precedence coverage, route-splitting coverage, and Istanbul
coverage for the Workers pool. Deployment docs now match the repository's active
CI-only workflow; the CI/CD file remains an opt-in example.

**Verification:** `pnpm run check`, `pnpm run test:coverage`,
`pnpm -C admin run build`, `pnpm install --frozen-lockfile`, `pnpm audit`,
Gitleaks, and Wrangler dry-run.

## v1.30.5 (2026-07-29) — security: react-router v8 migration (CSRF advisory); Dependabot groups

**[security] admin: react-router-dom 7.18.1 -> react-router 8.3.0.** Clears HIGH advisory
GHSA-qwww-vcr4-c8h2 (RSC Mode CSRF bypass). No 7.x patch exists and react-router-dom has
no v8 line — in v8 you import from `react-router` directly, so this is a package swap +
import rewrite (all 8 APIs used are unchanged declarative-mode exports). The advisory was
not exploitable here (the dashboard is a Vite SPA; RSC Mode is unused) but the migration
clears the alert.

**[ci] `.github/dependabot.yml` added**: weekly npm updates grouped into dev/prod bucket
PRs (majors stay individual). No github-actions ecosystem — the only workflow file is
`ci-cd.yml.example`, which Dependabot does not scan.

## v1.30.4 (2026-07-27) — security: sensitive-path hardening, security.txt, WAF guidance

**[security] New `denySensitivePaths` middleware** (`src/middleware/sensitive-paths.ts`). Returns **404** for build-system and source-tree paths (`/wrangler.toml`, `/package.json`, `/src/*`, `/.git/*`, `/node_modules/*`, …, case-insensitively) and for **query-string path traversal** on the admin host, across up to three URL-decode passes so single-, double- and triple-encoded probes (`?file=../../etc`, `..%2f`, `%2e%2e%2f`, …) are all caught. Mounted before the KV catch-all. 29 tests.

Deliberately **not** denied: `/docs`, `/admin`, `/backup`, `/swagger`, `/openapi.json` — these are plausible KV short-link names an operator may legitimately register, and since an unmatched path returns the same response as any random string they disclose nothing. Denying them would break a real feature to satisfy a scanner.

**[security] RFC 9116 `security.txt`** served at `/.well-known/security.txt` on every supported domain. Set `SECURITY_CONTACT_EMAIL` in `wrangler.toml` `[vars]` to your own address — the default is a placeholder, which is worse than useless. `Expires` is 365 days from **request** time, not build time, so it cannot silently age out between deploys.

**[docs] New `docs/cloudflare-waf.md`** — the WAF Custom Rules a self-hoster should deploy, with expressions, plan constraints (all rules use `contains`/`eq` only, so they work on Free and Pro — `matches`/regex needs Business+), false-positive analysis, and smoke tests including a must-NOT-block case. A Worker cannot configure its own zone, so this layer was previously undocumented and every deployment shipped without it.

**Verification:** `pnpm run check` green — 582 root tests (up from 553), 206 shared / 202 admin / 104 slackbot / 92 mcp, typechecks, both runtime-types gates.

---

## v1.30.3 (2026-07-27) — security: sharp advisory; runtime-types migration; Vite 8; vitest 4

**[security] Closed an open Dependabot HIGH alert.** Added `pnpm` override `"sharp": ">=0.35.0"` — GHSA-f88m-g3jw-g9cj (sharp inherited libvips vulnerabilities, vulnerable `<0.35.0`). `pnpm audit` 2 high -> 1 high.

**[security] Residual advisory documented, not fixable by a bump.** `react-router` GHSA-qwww-vcr4-c8h2 is patched only in `>=8.3.0`, but `react-router-dom` has no 8.x line. The advisory is **RSC-mode-specific** and states classic client-side SPAs are unaffected; this dashboard is declarative `<BrowserRouter>` with no data router, loaders, actions, or RSC. Accepted with justification.

**[refactor] Runtime types now generated by `wrangler types`.** This repo pins `compatibility_date = "2025-01-01"` while the previous ambient types were dated `2026-07-02` — a **~19-month gap**, meaning types advertised runtime APIs the Worker may not have had enabled. Both Workers (root + `slackbot/`) now commit a `worker-configuration.d.ts` generated from their own `wrangler.toml`, carrying `workerd@1.20260722.1 2025-01-01`. Generated with `--include-env=false` so the hand-authored `Bindings` type is preserved. `@cloudflare/workers-types` removed from both manifests (optional peer of wrangler). Typecheck passed with no source change beyond removing one direct import. `compatibility_date` deliberately unchanged.

**[ci] Runtime-types freshness gate** — `types:check` added to `pnpm run check` **and** to `.github/workflows/ci.yml`, since the CI job enumerates commands inline and never invokes `check`.

**[refactor] `vitest` 3.2.7 -> 4.1.10 with `@cloudflare/vitest-pool-workers` 0.12.21 -> 0.18.8** — coupled migration to the `cloudflareTest()` plugin API. The pool now isolates per test **FILE** rather than per test, surfacing **10 genuine test failures** (KV left dirty between tests; stacked `console.log` spies). Fixed with `beforeEach(clearAllRoutes)`, `afterEach(mockRestore)`, and a new `test/setup.ts`. No assertion weakened or skipped.

**[chore] Vite 7.3.5 -> 8.1.5 + `@vitejs/plugin-react` 5 -> 6** (admin), bumped together (plugin-react 6 requires vite ^8). Vite 8 moves to Rolldown; no `rollupOptions` present so no config migration. Main bundle slightly smaller: `index.js` 958.55 -> 956.13 kB (gzip 284.05 -> 279.11 kB); build 1.78s -> 248ms.

**[chore] Toolchain catch-up:** `lint-staged` 16 -> 17, `wrangler` 4.110.0 -> 4.114.0, `hono` 4.12.31 -> 4.12.32.

**Verification:** `pnpm run check` green after each unit and at release — lint, format, typecheck, **1157 tests** (553 root / 206 shared / 202 admin / 92 mcp / 104 slackbot), both runtime-types gates, plus `pnpm install --frozen-lockfile` at every step.

---

## v1.30.2 (2026-07-24) — fix: Reference field eats typed hyphens (controlled-input trailing-trim)

**[fix] Hyphens are now typeable in the QR "Reference" field.** The controlled input re-based on the fully-normalised value on EVERY keystroke, and `normalizeQrId()`'s final step strips trailing hyphens — but the end of the string is exactly where kebab-case hyphens are typed, so each one vanished the moment it was entered (`office` → type `-` → field snapped back to `office` → next char produced `officew`). Pasted values and interior separators survived, which made the loss look intermittent. Fix: new `normalizeQrIdInput()` (identical chain WITHOUT the trailing trim) runs on keystrokes; the full `normalizeQrId()` now applies on blur AND at submit (the submit previously sent the raw value, so a trailing hyphen would also have 400'd against `QR_ID_REGEX`). Regression tests cover the keystroke sequence, separator-run collapse, and the exact input-variant+trim equivalence.

## v1.30.0 (2026-07-24) — QR codes, in-dashboard User Guide, and file-comment MCP writes

The largest feature port to date, carried over from hardened upstream releases and shipped generic for self-hosters.

### QR codes

- **Unified QR resource** with optional route linking: URL / text / Wi-Fi / vCard payloads, KV-persisted under `qr:{domain}:{id}` in the existing ROUTES namespace (full-namespace scanners skip the prefix), CRUD at `/api/qr` + ephemeral `GET /api/qr/from-route`, authed-only SVG serving (`Cache-Control: private, no-store` — Wi-Fi payloads can carry credentials). Route-linked codes encode the SHORT URL: re-point the route, never reprint.
- **Neutral by default, preset-ready**: the template ships no branded presets — every code defaults to black-on-white with full custom colour/logo fields. Add your own presets to `shared/src/qr-brand-presets.ts`; a drift-guard test forces every SUPPORTED_DOMAIN to be either branded or deliberately neutral, so new domains can never ship with an undecided design.
- **Editor**: live preview with contrast warnings, Wi-Fi security categories (WPA universal / Enterprise 802.1X / Open / WEP) with credential redaction in audit rows, SVG + PNG downloads (canvas raster, wide-logo support), a Reference field with kebab normalisation + payload-derived prefill, field tooltips, and a Routes-page quick-QR action.
- **API + audit**: plain-Hono routes under the admin chain (byte-budget payload cap, same-domain link guard, type immutability); new audit actions `qr_create` / `qr_update` / `qr_delete` (dashboard filters/icons derive automatically); OpenAPI spec gains the four QR path templates (seven operations) + enum values.
- **MCP**: 6 new tools (`list_qrs`, `get_qr`, `create_qr`, `update_qr`, `delete_qr`, `get_route_qr`) — catalog 22 → 29 tools.

### `update_object_comment` MCP tool

File comments (readable via object list/meta responses) are now writable via MCP: input `{bucket, key, comment}` with comment REQUIRED — `null`/`''` clears, absence is a 400 (never a silent clear) — riding the existing `PUT /api/storage/:bucket/comment/:key` endpoint. Storage tools 10 → 11. Nullable-boundary regression tests included.

### User Guide + Resources group

- **In-dashboard User Guide** (`/guide`, lazy-loaded): 11 task-first sections covering the whole platform for a self-hosted single-operator deployment, with a coverage parity test (every sidebar page must be documented or CI fails) and a first-visit **welcome dialog** (localStorage once-per-browser, never re-prompts).
- **MCP tab** (`/integrations/mcp`): tool catalog derived live from the shared definitions + stdio install instructions for Claude Code / Claude Desktop.
- **Sidebar Resources group** (User Guide → MCP → Changelog, order pinned by test) via a new `layout/nav-items.ts` module; Cmd+K palette gains QR Codes / User Guide / MCP entries; contextual `?` help icons deep-link into guide sections.
- **Changelog release dates**: version headers now carry dates rendered on the Changelog page; all undated historical headers were backfilled from git history (80/80 dated).

**Review round (codex GPT-5.6 + code review + security review, converged in 1 iteration):** security CLEAN (auth-chain inheritance, SVG injection surfaces, KV keying, audit redaction all verified). Applied in-loop: `backupKV` now includes `qr:{domain}:` keys (QR records were silently absent from daily backups) + regression test; MCP tab snippets corrected to `EDGE_ROUTER_API_KEY` (the variable the stdio server actually reads); the Routes-row "QR Code" action (preview/downloads + Save-as-QR route linking with dedup guard) added so the dynamic-QR workflow is reachable from the dashboard; `@vitest/coverage-v8` realigned to the vitest-3 root graph (admin carries its own v4 pin); mcp/README tool tables completed + catalog count pins in tests; guide prose corrected; deep sanitisation pass on fixtures/comments (generic names, example-family domains); 9 QR route integration tests added. **Known considerations (deferred):** admin API errors are plain-text `HTTPException` responses repo-wide (the dashboard shows a generic message rather than the server detail); stored-QR dashboard previews always encode the short URL (the Worker's image endpoint additionally falls back to the stored payload if a linked route was deleted); MCP `clearLinkedRoute` expects a real boolean.

### Internals & chores

- `src/routes/request-context.ts` extracted from admin.ts (shared domain/actor helpers for the admin sub-routers); dialog `feedbackTrigger` prop (in-dialog feedback button); `qrcode-svg` dependency (shared).
- Dependency refresh: within-range `pnpm update -r` + `@vitest/coverage-v8` 3.x → 4.1.10 (vitest 4 peer), audit clean. Includes the 2026-07-10 security-advisory patches.

## v1.29.0 (2026-06-24) — Storage-tab pagination + proxy preserveQuery fix

- **[feature] Storage-tab offset pagination.** The Storage tab can now page through a folder beyond 100 items — prev/next + page-size selector + total count. `GET /api/storage/:bucket/objects` gains an **offset mode** (triggered by an explicit `offset` query param): one capped `bucket.list` (`LIST_MATERIALISE_CAP = 1000`, a single call), a synthesised `total`, and a combined folders-first slice, returning `meta:{total,count,offset,limit,hasMore}` + `capped`. **Cursor/legacy mode (no `offset`) is preserved** so the MCP server's forward-cursor pagination is unaffected. Files: `src/routes/storage.ts`, `shared/src/{types,client}.ts`, `admin/src/lib/api-client.ts`, `admin/src/pages/storage.tsx`, `openapi/bifrost-api.yaml`, `test/storage.test.ts`.
- **[fix] Proxy routes honour `preserveQuery`.** `handleProxy` now drops the query string upstream when a route sets `preserveQuery=false` (was unconditional; redirect routes already honoured it). `src/handlers/proxy.ts`.
- **[test] Deterministic audit-poller test.** Froze the clock in `test/audit/cf-audit-poll.test.ts` to remove a wall-clock dependency in the watermark assertion (assertion unchanged).

## v1.28.0 (2026-06-10) — External R2 operations audit capture (optional, ships dormant)

Closes the audit blind spot for self-hosters who want it: R2 operations made **outside Bifrost** (Cloudflare dashboard, Wrangler, direct S3/REST API keys) can now land in the same `audit_logs` table and dashboard audit page, labelled by a new `source` column (`bifrost` | `r2_event` | `cf_audit`). Ported from hardened upstream releases (multi-reviewer synthesis + live verification upstream).

- **[feature] Layer 1 — R2 event consumer** (`src/queue/r2-events.ts`, `queue()` export): R2 event notifications → Cloudflare Queue (60s delivery delay) → consumer with exact structured correlation dedup (events explained by Bifrost's own audit rows are dropped — never substring matching; one create + one delete slot per row via `r2_event_correlations`), at-least-once idempotency via `r2_event_seen` fingerprints written in the same atomic D1 batch, and STRICT inserts (failure → retry → DLQ, never ack-and-lose). Backup-cron writes system-attributed; feedback-bucket writes always recorded with pipeline attribution. **Requires Workers Paid (Queues).**
- **[feature] Layer 2 — CF account audit-log poller** (`src/audit/cf-audit-poll.ts`, new `*/30 * * * *` cron): records R2/queue-scoped control-plane changes **with the real Cloudflare actor** — and tamper-protects Layer 1 (rule deletion is itself captured). Watermark cursor with 60s overlap re-query + exact `json_extract` idempotency. **Works on the free plan.**
- **[feature] Surface**: migration `drizzle/0010_external_audit_capture.sql` (`source` column + 3 tables + indexes), 3 new audit actions (18→21), `?source=` API filter, admin UI Source filter + per-row source badges + detail-dialog Source field, API Shield schema updated (new enum values + `source` param).
- **[config] Dormant by default / free-plan graceful degradation**: both flags ship `"off"`, the queue consumer block ships commented out (an active block would break `wrangler deploy` for free-plan upgraders), the poller no-ops loudly-logged when unconfigured, and the new `*/30` cron is free-plan-safe. Full setup + the two Cloudflare API-token traps (account-owned `cfat_` tokens rejected; no dedicated audit-logs permission — use Account Settings: Read): README → "External R2 operations audit capture". Plan-gating contract: CLAUDE.md.
- **[fix] Audit action filter** now derives from the canonical shared `AuditActionSchema` (was an inline copy) — the three new actions are filterable and the list can never drift again. `computeNavTargets` skips `cf_config_change` rows (their `path` is `resource.type/resource.id`, not a real bucket/key — previously produced a dead-end "View file in storage" link; regression-tested).

Rollback: flip `R2_EVENT_AUDIT` / `CF_AUDIT_POLL` to `"off"` + redeploy. The migration is additive (`source` defaults `'bifrost'`).

## v1.27.1 (2026-06-04) — dependency maintenance (minor/patch)

Routine in-major dependency refresh across the workspace. No source changes; all checks green (lint + format + typecheck + test, 515 + 117 + 80 + 158 + 104 tests passing).

### Bumps

- **Root:** `@cloudflare/workers-types` 4.20260601.1 → 4.20260604.1, `oxlint` 1.67.0 → 1.68.0, `wrangler` 4.95.0 → 4.98.0
- **admin:** `@tanstack/react-query` 5.100.14 → 5.101.0, `react` + `react-dom` 19.2.6 → 19.2.7, `react-router-dom` 7.16.0 → 7.17.0, `@types/react` 19.2.15 → 19.2.16, `eslint-plugin-oxlint` 1.67.0 → 1.68.0, `typescript-eslint` 8.60.0 → 8.60.1, `vitest` 4.1.7 → 4.1.8
- **mcp / shared:** `vitest` 4.1.7 → 4.1.8
- **slackbot:** `@cloudflare/workers-types` 4.20260601.1 → 4.20260604.1, `wrangler` 4.95.0 → 4.98.0

### Security

- **Resolved moderate `esbuild` advisory (GHSA-67mh-4wv8-2f99)** — the deprecated `@esbuild-kit/core-utils` loader nested in `drizzle-kit` pinned `esbuild@0.18.20` (`<=0.24.2`). Added scoped pnpm override `"@esbuild-kit/core-utils>esbuild": ">=0.25.0"`; `drizzle-kit` still runs (`db:generate`). Dev-only / transitive.
- **Critical `vitest` advisory (GHSA-5xrq-8626-4rwp, `<4.1.0`) NOT resolved on root + slackbot** — patched range is `>=4.1.0`, a major bump blocked by the `@cloudflare/vitest-pool-workers` 2.0.x–3.2.x peer constraint (see Deferred). admin/mcp/shared are already on `vitest` 4.1.8 (patched). The advisory only applies when the Vitest **UI server** is listening (`--ui`); this repo runs `vitest run` with no UI in dev or CI, so exposure is nil.

### Deferred (major — not applied)

- **Dependabot PR #18** — `vitest` 3.2.4 → 4.1.0 (root + slackbot): major bump, deferred. Root/slackbot stay on `vitest` 3.2.4 and `@vitest/coverage-v8` 3.2.4 because `@cloudflare/vitest-pool-workers` requires the `vitest` 2.0.x–3.2.x peer range; moving to vitest 4 needs a coordinated pool-workers major bump.
- Other majors held: `@vitejs/plugin-react` 6.x, `lint-staged` 17.x, `typescript` 6.x, `vite` 8.x, `@cloudflare/vitest-pool-workers` 0.16.x, `lucide-react` 1.x.

---

## v1.27.0 (2026-06-04) — R2 key normalization + storage rename UX + typography DRY

### R2 object-key normalization (lowercase + kebab-case)

NEW R2 keys are normalized to lowercase-kebab, fixing the R2 case-sensitivity footgun (`Report.pdf` ≠ `report.pdf` → a route target with the wrong case 404s) and `%20` URL noise. **Write-time-only — existing objects + their live URLs are untouched** (no forced migration).

- **Shared normalizer:** `normalizeR2Key()` (`shared/src/r2-key.ts`) — per-segment slugify (lowercase; NFKD-transliterate accents → `cafe`; whitespace + URL-noisy specials → `-`; collapse/trim) preserving `/` (subdir) and the extension dot. Idempotent. Single source shared by the worker + dashboard.
- **Server (flag-gated `R2_KEY_NORMALIZE`):** `validateR2Key(key, { normalize })` applies it at the NEW-key sites only — upload, rename-target, move-dest (`src/routes/storage.ts`). Read/delete/metadata/comment/purge reference EXISTING keys and are never normalized. The dangerous-pattern REJECT still runs first (security pre-gate). Replace-keeps-existing-key guard on overwrite; collision → existing 409.
- **Default `R2_KEY_NORMALIZE = "sanitize"`** in `wrangler.toml [vars]` (both envs). The dashboard normalizes its own keys client-side regardless; the flag governs programmatic callers (API/MCP). 90s rollback: flip to `"off"`.
- **Dashboard:** the upload + rename dialogs clean the OS-filename auto-fill, show a live **"Saved as: …"** preview, and submit the normalized key (kebab placeholder + helper). Route path inputs carry the same kebab hint.

### Storage rename modal: surface key normalization

The **Edit Object → Rename** flow now always explains the Rename button's state instead of going silently dead when uppercase/spaces normalize back to the current key. Always-on preview (red error → grey "Normalizes to the current name — nothing to rename" no-op → "Saved as `<normalized>`" → amber "Key will change") + a disabled-reason tooltip. Frontend-only; the empty-input guard mirrors the submit guard (button-enabled ⟺ the rename fires).

### Typography DRY (`--mono-features`)

Behaviour-preserving cleanup of `admin/src/index.css`: the duplicated Maple Mono `font-feature-settings` (cv01 + cv32–cv37) are hoisted into a single `--mono-features` `@theme` custom property, referenced via `var()` on both mono surfaces (`code,pre,kbd,samp` + `.font-mono`). Zero visual change. Test guardrail added in `typography.test.ts`.

- **Dependency posture:** `pnpm.overrides` reviewed — already current; no change.
- **Tests:** +`normalizeR2Key` suite (`shared/src/r2-key.test.ts`); +`validateR2Key({ normalize })` cases; +route-level upload/rename normalization.

## v1.26.2 (2026-06-01) — Feedback attachment input hardening

Defense-in-depth follow-up to v1.26.1 (no functional change to valid flows). `pnpm run check` green.

- `feedback-dialog.tsx`: both attachment paths (auto screenshot + file picker) now route through a `makeAttachment()` helper that validates the blob MIME type against the accepted-image set and asserts the `URL.createObjectURL()` result uses the `blob:` scheme before storing it.
- Belt-and-braces for the CodeQL `js/xss-through-dom` alert, which was dismissed as a false positive after a GPT-5.5 data-flow review (`a.url` is always an opaque local `blob:` URL used only as an `<img src>`, never interpreted as HTML).

## v1.26.1 (2026-06-01) — Dependency maintenance + security patches

Security + routine dependency refresh; no functional changes. `pnpm run check` green.

- **Security (transitive overrides):** `qs` ≥6.15.2 (CVE-2026-8723 DoS), `fast-uri` ≥3.1.2 (CVE-2026-6321/6322 — two HIGH: path-traversal + host-confusion, via the MCP SDK's ajv), `postcss` ≥8.5.10 (dev), `ws` ≥8.20.1, `brace-expansion` ≥5.0.6 (corrected a stale override key range).
- **In-major refresh:** hono 4.12.23, @tanstack/react-query, react-hook-form, react-router-dom, @hookform/resolvers, tailwind-merge, @biomejs/biome 2.4.16, @types/react + @types/node, eslint 10.4.1, oxlint + eslint-plugin-oxlint 1.67.0, typescript-eslint, vitest 4.1.7, @tailwindcss/vite + tailwindcss, @cloudflare/workers-types, wrangler 4.95.0.
- **Accepted (dev-only):** esbuild GHSA-67mh-4wv8-2f99 — drizzle-kit's deprecated @esbuild-kit chain; a dev-server-only advisory, never invoked (drizzle-kit one-shot-transpiles its config), so zero runtime exposure.
- **Deferred (breaking majors):** typescript 6, vitest 4 stack, vite 8 / @vitejs/plugin-react 6, lint-staged 17, lucide-react 1.

## v1.26.0 (2026-05-31) — Audit UX + file comments + feedback work-queue

Three new admin-dashboard features, all gated by the existing `ADMIN_API_KEY`.

**Audit UX** — audit-log rows are clickable, opening a detail dialog with pretty-printed details, copy-raw-JSON, open-live-URL, and jump-to-route / jump-to-storage navigation.

**File comments** — free-text note per R2 object, stored in a new `file_comments` D1 sidecar (PK `bucket`+`key`). Surfaced via a comment field in the storage edit dialog + an indicator in the object list; carried across rename/move; new `PUT /api/storage/:bucket/comment/:key` endpoint. Migration `0008_file_comments.sql`.

**Feedback work-queue** — in-dashboard feedback (bug / feature / question / other) with typed taxonomy, human IDs `F-<n>` (via a `counters` table), screenshots + a redacted diagnostic capture bundle stored in a dedicated `FEEDBACK_BUCKET` R2 bucket, an admin triage queue, and a structured export. Trigger via header pill, global `⌘/`, sidebar, or the feedback page. Migration `0009_feedback.sql`. OpenAPI schema extended for API Shield.

Self-hosters: create an R2 bucket and bind it as `FEEDBACK_BUCKET`, then apply migrations `0008`/`0009` per environment (not auto-applied by CI).

## v1.25.1 (2026-05-27) — Noto Sans R2 path consolidation

Noto Sans SC + TC moved from two separate R2 prefixes (`/fonts/noto-sans-sc/` + `/fonts/noto-sans-tc/`) into a single consolidated `/fonts/noto-sans/` directory. Both `@font-face` declarations updated in `admin/src/index.css`; matching typography test assertions updated in `admin/src/lib/typography.test.ts`.

If you've forked bifrost-router and self-host your own brand fonts, this change does not affect you — your `@font-face` URLs are unaffected.

---

## v1.25.0 (2026-05-27) — Canonical four-font typography stack

Adds three font families to the dashboard's default typography stack — Inter italic (so `<em>` renders true italic instead of synthesised oblique), Maple Mono NL for code surfaces, and Noto Sans SC + TC for Chinese-language content. All four are SIL OFL 1.1 licensed and load from the same CDN as the existing Inter face.

### What changes on the dashboard

| Surface | Before (v1.24.0) | After (v1.25.0) |
|---|---|---|
| Latin body | Inter Variable (roman only) | Inter Variable (roman + italic) — `<em>` now renders true italic |
| `<code>`/`<pre>`/`<kbd>`/`<samp>` | Tailwind 4 default mono (`ui-monospace, monospace`) — system mono per OS | Maple Mono NL Variable with `cv01` + `cv32`–`cv37` feature settings (engineering `@`, continuous-slash `$`, non-cursive italic) |
| Inline mono utility | None | `.font-mono` utility class — applies Maple Mono NL + feature settings to non-semantic spans (e.g. R2 keys in `<span>` elements) |
| Simplified Chinese (`[lang^="zh-Hans"]`, `lang="zh-CN/SG/MY"`) | Inter → system stack | Inter (Latin) → Noto Sans SC (CJK) → PingFang SC → Hiragino Sans GB → Microsoft YaHei |
| Traditional Chinese (`[lang^="zh-Hant"]`, `lang="zh-TW/HK"`) | Inter → system stack | Inter (Latin) → Noto Sans TC (CJK) → PingFang TC → Hiragino Sans CNS → Microsoft JhengHei |

### Implementation

| File | Change |
|---|---|
| `admin/src/index.css` | Six `@font-face` declarations (Inter ×2, Maple ×2, Noto SC, Noto TC). `--font-mono`, `--font-sans-sc`, `--font-sans-tc` tokens added inside `@theme inline`. `code, pre, kbd, samp { font-family: var(--font-mono); font-feature-settings: 'cv01' 1, 'cv32'-'cv37' 1; letter-spacing: 0; }` in `@layer base`. CJK locale scoping via `[lang^="zh-Hans"]` / `[lang^="zh-Hant"]`. `.font-mono` utility class. Top-of-file comment block updated to document all four families and how to swap them for your own brand fonts. |
| `admin/src/lib/typography.test.ts` | New regression suite (21 assertions): every `@font-face` URL, every family token, `font-optical-sizing: auto` on body, mono surfaces bind `--font-mono`, all seven Maple feature settings active, CJK locale scoping present, every face declaration carries `font-display: swap`. |
| `admin/vitest.config.ts` | `test.css.include` enabled for `index.css` so `?raw` imports in tests resolve to real source (Vitest stubs CSS to empty strings by default). |

### Forking note

If you fork bifrost-router to use your own brand fonts, the canonical replacement pattern is:

1. Self-host your font woff2 files (or use a CDN you control)
2. Replace the six `@font-face` declarations at the top of `admin/src/index.css`
3. Update the four `--font-*` tokens in `@theme inline` to reference your families
4. Update or delete `admin/src/lib/typography.test.ts` — the URLs and family names are pinned to the default fonts

### Performance characteristics

- **Inter italic** (~120 KB): Lazy-loaded — only fetched on first `<em>` render.
- **Maple Mono NL** (~120 KB roman + ~141 KB italic): Lazy-loaded — only fetched on first code-surface render.
- **Noto Sans SC** (~7.4 MB) + **Noto Sans TC** (~5.2 MB): Lazy-loaded — only fetched on pages with `lang="zh-*"` scoping. English-only dashboards never trigger these.

All five new face declarations carry `font-display: swap` so non-blocking; FCP is unchanged from v1.24.0.

---

## v1.24.0 (2026-05-27) — Global security headers hardening + CI gate

Tightens `secureHeaders()` and adds a closed-allowlist Permissions-Policy header on every response. Brings the template's security headers in line with a production hardening baseline. Also closes a recursive-typecheck CI gap that hides root Worker type errors from the `check` chain.

### `src/index.ts` — secureHeaders hardening

- **HSTS upgraded** from `max-age=15552000` (180 days) to `max-age=31536000` (1 year — the HSTS-preload-eligible threshold).
- **`xFrameOptions: 'DENY'`** added. Hono's default is `SAMEORIGIN`; `DENY` is strictly stronger (clickjacking defence).
- The remaining Hono defaults (`xContentTypeOptions`, `crossOriginOpenerPolicy`, `crossOriginResourcePolicy`, `referrerPolicy`, `xDnsPrefetchControl`, `xDownloadOptions`, `xPermittedCrossDomainPolicies`) are kept.

### `src/index.ts` — Permissions-Policy global middleware

Hono's `secureHeaders()` API does not support Permissions-Policy, so it's attached via a separate global middleware that runs after `next()` (so it modifies the populated response). The 27-feature deny list:

```
accelerometer, ambient-light-sensor, autoplay, battery, camera,
cross-origin-isolated, display-capture, encrypted-media,
execution-while-not-rendered, execution-while-out-of-viewport,
fullscreen (self only), geolocation, gyroscope, keyboard-map,
magnetometer, microphone, midi, navigation-override, payment,
picture-in-picture, publickey-credentials-get, screen-wake-lock,
sync-xhr, usb, web-share, xr-spatial-tracking,
interest-cohort, attribution-reporting
```

`interest-cohort` (FLoC) and `attribution-reporting` are privacy-adjacent denials. `fullscreen=(self)` allows same-origin fullscreen (admin dashboard may use it) while denying cross-origin embeds. All others are `()` (closed allowlist).

**Forker note:** if your deployment uses any of the denied browser features, edit the `PERMISSIONS_POLICY` array in `src/index.ts` before deploying. The defaults are safe for the reference admin dashboard.

### `package.json` — CI gate

Added `pnpm run typecheck` (root) to the `check` chain. Previously only `pnpm run -r typecheck` ran, which is recursive across workspaces and silently skips the root Worker. The repo currently has 0 root errors, so the gate is preventive — future regressions caught at `check` time.

### `test/middleware/secure-headers.test.ts` — regression coverage

- Updated HSTS assertion from `max-age=15552000` to `max-age=31536000`.
- Updated `x-frame-options` assertion from `SAMEORIGIN` to `DENY`.
- New `Permissions-Policy` describe block: 2 cases asserting the camera/microphone/geolocation/payment/FLoC/attribution-reporting denials are present, no `=none` (must use `=()`), and the header attaches to JSON API responses too.

### Non-goals (explicit skips)

| Item | Reason |
|---|---|
| HSTS `includeSubDomains` + `preload` | Requires per-subdomain HTTPS audit. Forkers should audit their own subdomain inventory before adding these directives. |
| CSP framework | Defer for template; forkers should scope CSP to their dashboard's specific origins. |
| Zaraz/Fathom Analytics | Out of scope for open-source template. |
| Stytch / JWKS | Out of scope (template ships with simple `X-Admin-Key` auth). |

### Rollback

Single-commit revert per file. No data migration, no schema, no state.

---

## v1.23.0 (2026-05-26) — Dashboard typography: Gilroy → Inter Variable (full Inter v4 spec)

Replaces Gilroy with **Inter Variable v4.1** as the dashboard typeface. Single-pass migration consolidating the full Inter v4 design-system stack — font swap, optical sizing, weight standardisation, and the size-tied tracking table — into one Y-bump.

### Why Inter v4

- **Open licence (SIL OFL 1.1)** — Inter is freely usable and redistributable; suitable for forks of this open-source repo.
- **Variable font** — single woff2 file carries all weights (100–900) AND optical sizes (14–32) via the `opsz` axis. Replaces 4 static Gilroy TTF downloads.
- **Industry standard** — Linear / GitHub / Mozilla / Stripe all use Inter for dashboards.

### Font asset

Public CDN default configured in `admin/src/index.css` (matches the previous Gilroy hosting pattern). Forkers self-hosting their own font should update both the `@font-face` declaration in `admin/src/index.css` and the `<link rel="preload">` in `admin/index.html` — see comment block at the top of `index.css` for the substitution pattern.

### Dashboard code changes

#### `admin/src/index.css`

- **Removed:** 4 `@font-face` Gilroy TTF declarations (Regular/Medium/SemiBold/Bold).
- **Added:** 1 `@font-face` Inter Variable woff2 declaration with `font-weight: 100 900` range, `format("woff2-variations")`.
- **Token rename:** `--font-gilroy` → `--font-inter`.
- **Paired-token tracking table** (Tailwind 4) — every `--text-{name}` token now carries `--letter-spacing` per Inter v4 spec (positive <16px for small-text legibility, near-zero at 16px, increasingly negative >16px for display polish). Tailwind built-in classes (`text-xs` through `text-7xl`) also overridden.
- **Optical sizing:** `body { font-optical-sizing: auto; }` engages Inter v4's `opsz` axis.
- **Deleted redundant manual classes:** `.text-display`, `.text-huge`, `.text-xlarge`, `.text-large` removed from `@layer utilities` (Tailwind 4 auto-generates from paired tokens).
- **Utility class rename:** `.font-gilroy` → `.font-inter`.
- **Body + headings:** `var(--font-gilroy)` → `var(--font-inter)`.
- **Header comment block** updated to describe the Inter v4 axis pattern and how forkers can substitute their own brand font.

#### `admin/index.html`

- **Added** `<link rel="preload">` for Inter Variable woff2 — eliminates flash-of-unstyled-text on first paint.

#### `admin/src/components/ui/sidebar.tsx` — Option A weight drop

- Removed `font-medium` (500) on the always-on `sidebar-group-label` (line 388) and `sidebar-menu-badge` (line 563). These elements now use default 400 weight; combined with `opsz auto`, they read with the right visual texture.
- **Kept** `data-[active=true]:font-medium` (line 454) — the active-menu-item emphasis pattern.

#### Component renames (11 files)

All `font-gilroy` Tailwind utility class references renamed to `font-inter` across admin components and pages.

### Inter v4 tracking table (rsms.me/inter spec)

| Token / Tailwind class | Size | Letter-spacing |
|---|---|---|
| `text-mini` | 9px | +0.0089em |
| `text-tiny` / `text-xs` | 12px | +0.005em |
| `text-small` / `text-sm` | 14px | +0.003em |
| `text-base` | 16px | -0.0011em |
| `text-large` / `text-lg` | 18px | -0.0033em |
| `text-xl` | 20px | -0.0067em |
| `text-xlarge` / `text-2xl` | 24px | -0.0125em |
| `text-3xl` | 30px | -0.0175em |
| `text-huge` / `text-4xl` | 32–36px | -0.0192em / -0.0217em |
| `text-display` / `text-5xl` | 48px | -0.0289em |
| `text-6xl` / `text-7xl` | 60–72px | -0.0322em / -0.0344em |

### Design system standard locked

Dashboard now uses ONLY standard 100-step weights (400 default, 500 medium for active emphasis, 600 semibold for wordmark / banners). No arbitrary intermediate weights. Tracking applied automatically per Tailwind size class — no per-component tuning required.

### Forker note: customising the font

The dashboard inherits all Inter v4 behaviour (opsz axis + tracking table + weight stops) from the `@font-face` declaration and the `@theme inline` tokens in `admin/src/index.css`. To swap to a different brand font:

1. Replace the `@font-face` declaration with your own font's URL + format
2. Update `--font-inter` in `@theme inline` to reference your font name
3. If your font ISN'T variable, drop the tracking-table paired tokens (or keep them — they degrade gracefully)
4. Rebuild the dashboard (`pnpm --filter admin build`)

### Testing posture

CSS + className changes only; no logic or component-behaviour changes. Existing test suite must still pass. CI runs lint/format/typecheck/test on every push.

### Rollback

- **L0 (5 min):** revert this commit + retag previous version. Dashboard rebuilds with Gilroy classes; Inter preload becomes harmless 404 on subsequent forks.

---

## v1.22.12 (2026-05-07)

### Changed
- **Bump minor/patch dependencies** — routine refresh + security pickups:
  - `hono` `^4.12.12` → `^4.12.18` (root + slackbot) — picks up GHSA-69xw-7hcm-h432 (JSX tag-name HTML injection) and GHSA-9vqf-7f2p-gf9v (bodyLimit bypass for chunked requests). Supersedes Dependabot PR #6.
  - `wrangler` `4.82.2` → `4.90.0` (root + slackbot)
  - `@cloudflare/workers-types` `^4.20260415.1` → `^4.20260507.1` (root + slackbot)
  - `@biomejs/biome` `^2.4.12` → `^2.4.14` (root)
  - `oxlint` / `eslint-plugin-oxlint` `^1.60.0` → `^1.63.0` (root + admin)
  - `zod` `^4.3.6` → `^4.4.3` (all packages)
  - `@types/node` `^25.6.0` → `^25.6.1` (admin/shared/mcp/slackbot)
  - `react` / `react-dom` `^19.2.5` → `^19.2.6` (admin)
  - `@tanstack/react-query` `^5.99.0` → `^5.100.9` (admin)
  - `react-hook-form` `^7.72.1` → `^7.75.0` (admin)
  - `react-router-dom` `^7.14.1` → `^7.15.0` (admin)
  - `tailwindcss` / `@tailwindcss/vite` `^4.2.2` → `^4.2.4` (admin)
  - `eslint` `^10.2.0` → `^10.3.0` (admin)
  - `typescript-eslint` `^8.58.2` → `^8.59.2` (admin)
  - Added `pnpm.overrides` entry `ip-address@<=10.1.0` → `>=10.1.1` to resolve GHSA-v2v4-37r5-5v8g (XSS in `Address6` HTML-emitting methods, transitive via `mcp > @modelcontextprotocol/sdk > express-rate-limit > ip-address`).
  - `pnpm-lock.yaml` regenerated. Major-version updates (`typescript` 6, `vite` 8, `vitest` 4 root/slackbot, `@vitest/coverage-v8` 4, `@vitejs/plugin-react` 6, `@cloudflare/vitest-pool-workers` 0.16, `lint-staged` 17, `lucide-react` 1.x) were intentionally deferred. CI parity validated locally: lint, admin lint, format check, root + workspace typechecks, and full test suite (root 471 + workspace 100% passing) all green. `pnpm audit --prod` reports no known vulnerabilities.

---

## v1.22.11 (2026-05-07)

### Changed
- Trimmed verbosity introduced by the v1.22.7–v1.22.10 series:
  - `src/utils/safe-service-fetch.ts` — dropped the unused `SafeServiceFetchContext` interface; inlined the param shape on the function signature.
  - `CHANGELOG.md` — collapsed v1.22.7–v1.22.10 narrative blocks; added an umbrella note at the top of the series.
  - `CLAUDE.md` — replaced the multi-paragraph "Service-Binding Fetch Resilience" subsection with a 2-line pointer to the helper JSDoc.

  Pure cleanup. No behaviour change. Mirrors upstream Bifrost v1.22.11.

---

> **v1.22.7–v1.22.10 — scanner-resilience series.** Three releases mirroring
> upstream Bifrost's `scriptThrewException` fix series for
> double-URL-encoded scanner paths. v1.22.7 enables observability,
> v1.22.9 adds a tested `safeServiceFetch` helper around the service-binding
> fallback (skipping v1.22.8 since the inline-wrap → helper-extraction
> happened in lockstep upstream), v1.22.10 corrects the failure status
> code from 404 to 503 per Codex review.

## v1.22.10 (2026-05-07)

### Changed
- `safeServiceFetch` failure path now serves **503 instead of 404** — 404 conflated "URL doesn't exist" with "upstream is unavailable", hiding incidents and confusing CDN cache. One-line change in `src/index.ts`; helper unchanged. Mirrors upstream Bifrost v1.22.10.

---

## v1.22.9 (2026-05-07)

### Added
- `safeServiceFetch` helper for service-binding fetch resilience — `src/utils/safe-service-fetch.ts` exports `safeServiceFetch(service, req, ctx) → Promise<Response | null>` which wraps `service.fetch(new Request(req))` in `try/catch`. URL-parse errors (e.g. `/%252fmaster%252f.env` from scanners) and binding failures return `null` + `warn` log instead of `scriptThrewException`. The service-fallback branch in `src/index.ts` calls the helper. 8 unit tests in `test/utils/safe-service-fetch.test.ts`.

---

## v1.22.7 (2026-05-06)

### Fixed
- Added `enabled = true` to the top-level `[observability]` block in `wrangler.toml`. Without the parent flag, Cloudflare retains no Workers Logs or Traces — child flags alone don't persist.

---

## v1.22.6 (2026-04-15)

### Changed
- **Bump minor/patch dependencies** — routine dev-tooling refresh:
  - `@biomejs/biome` `^2.4.11` → `^2.4.12` (root)
  - `@cloudflare/workers-types` `^4.20260414.1` → `^4.20260415.1` (root + slackbot)
  - `wrangler` `4.81.1` → `4.82.2` (root + slackbot)
  - `pnpm-lock.yaml` regenerated. No dependabot PRs or security alerts were open at the time of this bump. Major-version updates (`typescript` 6, `vite` 8, `vitest` 4 root/slackbot, `@vitest/coverage-v8` 4, `@vitejs/plugin-react` 6, `@cloudflare/vitest-pool-workers` 0.14, `lucide-react` 1.x) were intentionally deferred. CI parity validated locally: lint, admin lint, format check, root + workspace typechecks, full test suite (root 463 + shared 68 + admin 79 + mcp 80 + slackbot 104 = 794 tests), and admin dashboard build all pass.

---

## v1.22.5 (2026-04-15)

### Changed
- **Restore Gilroy `@font-face` declarations (public CDN default)** — v1.22.4 removed the four `@font-face` blocks that loaded Gilroy from a public CDN, thinking it was a leak. The CDN bucket is in fact a public R2 bucket intended to serve the font publicly, so it's an appropriate default for this template. Restored the declarations in `admin/src/index.css` with an updated comment explaining that (a) the default loads from this public CDN, (b) the `font-display: swap` fallback stack handles CDN-unreachable cases gracefully, and (c) self-hosters can replace the blocks with their own font URLs. The rest of the v1.22.4 sanitisation sweep (the `VITE_API_URL` default, server comments, absolute-path examples, JSDoc host examples, and upstream provenance references) remains unchanged.

---

## v1.22.4 (2026-04-15)

### Changed
- **Sanitisation sweep for public distribution** — remove or genericise residual references to personal/team infrastructure that had leaked into the public template:
  - **`VITE_API_URL` default** — `admin/Dockerfile`, `admin/Dockerfile.tailscale`, and `admin/.env.example` defaulted to a personal domain. Now defaults to `https://yourdomain.com` — self-hosters must set `VITE_API_URL` to their own Bifrost admin API origin at build time.
  - **Gilroy font `@font-face` blocks** — `admin/src/index.css` previously loaded the Gilroy typeface from a third-party CDN hard-coded into the template. Removed the four `@font-face` declarations; kept the `--font-gilroy` CSS variable with its `ui-sans-serif, system-ui, sans-serif` fallback stack so existing `font-gilroy` utility classes continue to resolve gracefully. Replaced with an inline comment documenting how self-hosters can supply their own brand font.
  - **Private brand naming in dashboard CSS and JSDoc** — renamed to generic "Brand"/"Color Palette" labels in `admin/src/index.css` and `admin/src/lib/parse-changelog.ts`.
  - **`hostHeader` JSDoc examples** — changed to `"example.com"` in `shared/src/types.ts`, `shared/src/tools.ts`, `src/types.ts` (4 occurrences).
  - **Server-specific comment in `admin/docker-compose.prod.yml`** — changed to generic "your server".
  - **Absolute-path example in `mcp/PLAN.md`** — changed to `/path/to/bifrost-router/mcp/dist/index.js` (two occurrences).
  - **Stale excluded path in `.dockerignore`** — removed (file does not exist in this repo; was a leftover from an upstream multi-zone config).
  - **`CHANGELOG.md` provenance references** — historical entries that credited the upstream repo by internal names rewritten to the generic phrase "upstream Bifrost". No functional history was altered; only the wording that revealed internal repo names.
- **`CONTRIBUTING.md` GitHub Issues link** — kept as-is (`github.com/henrychong-ai/bifrost-router`). This is the canonical public-repo URL that contributors need to file issues against; the `henrychong-ai` GitHub org owns this public template.

---

## v1.22.3 (2026-04-15)

### Changed
- **Docker build cache optimisations — `admin/Dockerfile.tailscale` + `.dockerignore`** — bundle of six changes that move the build-cache hit rate on typical release-tag builds from ~16% (baseline) to ~40–60%, and skip `pnpm install` / vite build entirely on source-only commits:
  - **Defer `CHANGELOG.md` COPY to post-install** — `CHANGELOG.md` is consumed by vite (`admin/src/pages/changelog.tsx` imports it via `?raw`), not by `pnpm install`. Moving it after install stops every CHANGELOG edit from busting the install layer.
  - **pnpm store cache mount** — `RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store/v3 pnpm install ...`. Even when the install layer itself invalidates (e.g. root `package.json` version bump on a release), packages are served from the mounted store instead of re-downloaded. Typical install drops from ~13s to ~3s on invalidation.
  - **Vite pre-bundling cache mount** — `RUN --mount=type=cache,id=vite-deps,target=/app/admin/node_modules/.vite pnpm run build`. Preserves the `optimizeDeps` scan across builds.
  - **apk cache mount in stage-1** — `RUN --mount=type=cache,id=apk-cache,target=/var/cache/apk` with `ln -s /var/cache/apk /etc/apk/cache` (`--no-cache` removed so the mount actually persists).
  - **`COPY --link` on stage-1 cross-stage and static copies** — Tailscale binaries, `dist` from builder, nginx.conf, start script. BuildKit computes layers in parallel instead of sequentially.
  - **`.dockerignore` excludes build-irrelevant `admin/` files** — `admin/Dockerfile*`, `admin/docker-compose*.yml`, `admin/eslint.config.js`, `admin/vitest.config.ts`, `admin/README.md`, `admin/dist`, `shared/dist`. Removed the `!admin/**/*.md` re-inclusion. Editing the Dockerfile itself no longer invalidates the source COPY layer.
- **BuildKit requirement** — these mount/link directives require BuildKit ≥ 0.10. `docker/setup-buildx-action@v3` in CI pipelines (used by `ci-cd.yml.example`) provides this automatically. Self-hosters running `docker build` locally should use a recent Docker Desktop / Docker Engine with BuildKit enabled (the default since Docker 23).

---

## v1.22.2 (2026-04-14)

### Added
- **Drift-detection test for `SUPPORTED_DOMAINS`** — `test/supported-domains-consistency.test.ts` asserts that all three hardcoded copies (`src/types.ts`, `shared/src/types.ts`, `admin/src/context/filter-types.ts`) plus the OpenAPI `DomainQuery` enum contain identical domain lists. Self-hosters adding new domains will get a CI failure if they miss any of the 4 locations.

### Changed
- **"Adding a New Supported Domain" checklist updated from 4 → 6 locations** — `shared/src/types.ts` and `admin/src/context/filter-types.ts` were silently missing from the checklist, which caused drift in upstream repos.

---

## v1.22.1 (2026-04-14)

### Changed
- **Use `routeKey()` helper in normalize-case endpoint** — `POST /api/routes/normalize-case` now uses the existing `routeKey(domain, path)` helper from `src/kv/schema.ts` instead of hand-constructing keys. Refactor-only; no behaviour change.

---

## v1.22.0 (2026-04-14)

**Case-insensitive routing + dependency bumps**

### Changed
- **Case-insensitive paths** — All route paths are normalized to lowercase. Visitors can use any case in the URL (e.g., `/LinkedIn`, `/LINKEDIN`, `/linkedin`) and it will match the stored route. `normalizePath()` now applies `.toLowerCase()` as the final step.
- **Dashboard path input** — Path inputs in create and edit mode automatically convert to lowercase as the user types.
- **Removed case conflict checks** — Case conflict detection in route creation, migration, and transfer is removed (now redundant since all paths are lowercase). The exact-match duplicate check remains.
- **Dependency bumps** — wrangler 4.78.0 → 4.81.1, biome 2.4.9 → 2.4.11, oxlint 1.57.0 → 1.60.0, plus minor/patch updates across the monorepo.

### Added
- **`POST /api/routes/normalize-case`** — One-time migration endpoint to convert existing KV routes with uppercase paths to lowercase. Idempotent and safe to re-run. Self-hosters should run this once after upgrading if they have pre-existing routes with uppercase paths.
- **Oxlint 1.60 rule handling** — Disabled `vitest/require-mock-type-parameters` and `react/hook-use-state` (intentional — see CLAUDE.md rationale). Removed deleted `unicorn/prevent-abbreviations` rule.

---

## v1.21.2 (2026-04-12)

### Fixed
- Add `sharp` to `pnpm.onlyBuiltDependencies` — resolves "Ignored build scripts" warning during install

---

## v1.21.1 (2026-04-11)

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

## v1.21.0 (2026-03-27)

### Added
- **Copy target URL** — Copy icon next to destination URL in route edit dialog (redirect/proxy targets and R2 file URLs)
- **Path case conflict blocking** — Red error + disabled submit when a case-insensitive path duplicate exists (e.g., creating `/TEST1` when `/test1` exists)

### Fixed
- **Duplicate target self-match** — Route no longer flags itself as a duplicate when editing
- **Case-insensitive target detection** — Duplicate target check now uses case-insensitive matching
- **Server-side path enforcement** — API returns 409 for case-insensitive path conflicts on create, migrate, and transfer

---

## v1.20.0 (2026-03-27)

**Duplicate target detection — real-time cross-domain route conflict awareness**

### Added
- **Duplicate target warning** — When creating or editing a route, an inline callout appears below the Target field if another route (same domain or any accessible domain) already points to the same URL. Non-blocking — routes can still be created intentionally.
- **Cross-domain prefetch** — Routes for all accessible domains are prefetched on dialog open for instant cross-domain duplicate detection.

---

## v1.19.0 (2026-03-26)

**Copy Link — one-click URL sharing for routes and files**

### Added
- **Copy Link (Routes)** — "Copy Link" in route three-dot menu copies the public URL to clipboard. Route URL with copy icon shown in edit dialog header.
- **Copy Link (Storage)** — "Copy Link" in file three-dot menu copies the R2 custom domain URL to clipboard. Copy icon added next to file URL in edit dialog.
- **`copyToClipboard` utility** — Shared clipboard helper with toast feedback

### Tests
- 3 new `copyToClipboard` unit tests

---

## v1.18.3 (2026-03-26)

### Dependencies
- wrangler 4.73.0 → 4.77.0, hono 4.12.7 → 4.12.9, @biomejs/biome 2.4.6 → 2.4.9
- @cloudflare/workers-types → 20260317.1, lint-staged → 16.4.0, oxlint 1.55.0 → 1.57.0
- pnpm 10.32.1 → 10.33.0

---

## v1.18.2 (2026-04-12)

### Fixed
- **Docker build** — Add `CHANGELOG.md` to Dockerfile COPY step and `.dockerignore` whitelist so the changelog dashboard page can resolve `?raw` import during container build

---

## v1.18.0 (2026-03-26)

### Added
- **Changelog dashboard** — New `/changelog` page with searchable version history, section badges, current version highlighting, and inline code rendering. Synced from upstream Bifrost v1.25.0.
- **Sidebar changelog link** — Changelog nav item pinned at bottom of sidebar, clickable version in footer

### Changed
- **Vitest config** — Root vitest now excludes workspace packages (admin, shared, mcp, slackbot) to prevent Workers pool from picking up Node.js-only tests

---

## v1.17.2 (2026-03-26)

### Fixed
- **Security** — Patch 6 Dependabot alerts (all dev-only): picomatch ReDoS + method injection (→2.3.2/4.0.4), yaml stack overflow (→2.8.3), flatted prototype pollution (→3.4.2)

---

## v1.17.1 (2026-03-26)

### Fixed
- **Audit logging** — Fix typecheck errors in transfer route and cache purge handlers using non-existent `actor` property instead of `actorLogin`/`actorName`

---

## v1.17.0 (2026-03-26)

### Changed
- **Backup system** — Removed D1 analytics backup; D1 is now covered by Cloudflare Time Travel (automatic 30-day PITR). Backup system now backs up KV routes only (~8KB/day).
- **Backup retention** — Changed from 30-day daily / 90-day weekly to indefinite retention (negligible storage cost)
- **Manifest version** — Bumped to 2.0.0 (removed `d1` and `retention` fields)
- **Dashboard** — Removed D1 analytics row count from backup health widget

### Removed
- `src/backup/d1.ts` — D1 table export (redundant with Time Travel)
- `src/backup/retention.ts` — Backup cleanup (no longer needed with indefinite retention)

---

## v1.16.4 (2026-03-15)

### Fixed
- **Storage cross-nav** — Fix race condition where auto-open fired against cached data from wrong bucket before bucket selection completed

---

## v1.16.3 (2026-03-15)

### Added
- **Storage dialog** — "View in Routes" clickable rows for associated routes, navigates to routes tab and auto-opens route's edit dialog
- **Cross-navigation** — Branded pill buttons for "View in Storage" and "View in Routes" actions (blue-50/blue-700 pill style)

---

## v1.16.2 (2026-03-15)

### Added
- **Routes dialog** — "View in Storage" button for R2 routes, navigates to storage tab and auto-opens the file's edit dialog

---

## v1.16.1 (2026-03-13)

### Fixed
- **Storage dialog** — Aligned popup width to match routes dialog (`sm:max-w-xl lg:max-w-2xl`)

---

## v1.16.0 (2026-03-13)

**Sync upstream v1.24.1–v1.24.3: Route preview + standalone target links**

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
**Sync upstream Bifrost v1.22.0–v1.23.3: Cache Purge, Route Transfer, Storage Dialog, D1 Pagination**

Sync 6 changes from upstream Bifrost. Adds global CDN cache purge, route domain transfer, unified storage edit dialog, paginated D1 backups with error isolation, and dependency updates.

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

Port and adapt R2 cross-bucket move, expanded audit action filtering, and dialog UX improvements from upstream Bifrost v1.20.0. Extends test count from 935 to 949.

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
**Tests: Comprehensive test coverage port from upstream Bifrost**

Port and adapt 11 new test files from upstream Bifrost v1.19.9, extending total test count from 487 to 935. Covers KV layer, D1 analytics, backup system, slackbot permissions, MCP storage tools, and R2 copy size guard. Fixes CI gap where root workspace tests were not run in pipeline.

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
- `test/kv/routes.test.ts` adapted to HC implementation: `getRoute`/`getRouteSafe`/`deleteRoute` don't call `normalizePath` (unlike upstream); `getAllRoutesAllDomains` filters to `SUPPORTED_DOMAINS`

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

Major feature release porting genericised features from upstream Bifrost. Adds full R2 storage management across API, MCP, and dashboard, plus route search and pagination.

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

Restructured GitHub Actions pipeline to cleanly separate CI (quality gates) from CD (deployment). Deploy now only triggers on version tags, matching the upstream Bifrost pattern.

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
- **Fixed**: `Property 'error' does not exist` in migrate route handler — aligned domain validation types with upstream Bifrost's centralised `error` pattern (renamed `providedValue` → `error` in types + validation function + all 7 call sites)

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

Replaced umbrella `radix-ui` package with individual `@radix-ui/*` packages for consistency with upstream Bifrost.

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

R2 routes can serve from 8 buckets: files (default), assets, and 6 additional buckets.

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

# Changelog

All notable changes to Bifrost are documented in this file.

For deployment instructions and project context, see [CLAUDE.md](./CLAUDE.md).

---

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

## v1.24.0 — Global security headers hardening + CI gate

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

## v1.23.0 — Dashboard typography: Gilroy → Inter Variable (full Inter v4 spec)

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

## v1.22.12

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

## v1.22.11

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

## v1.22.10

### Changed
- `safeServiceFetch` failure path now serves **503 instead of 404** — 404 conflated "URL doesn't exist" with "upstream is unavailable", hiding incidents and confusing CDN cache. One-line change in `src/index.ts`; helper unchanged. Mirrors upstream Bifrost v1.22.10.

---

## v1.22.9

### Added
- `safeServiceFetch` helper for service-binding fetch resilience — `src/utils/safe-service-fetch.ts` exports `safeServiceFetch(service, req, ctx) → Promise<Response | null>` which wraps `service.fetch(new Request(req))` in `try/catch`. URL-parse errors (e.g. `/%252fmaster%252f.env` from scanners) and binding failures return `null` + `warn` log instead of `scriptThrewException`. The service-fallback branch in `src/index.ts` calls the helper. 8 unit tests in `test/utils/safe-service-fetch.test.ts`.

---

## v1.22.7

### Fixed
- Added `enabled = true` to the top-level `[observability]` block in `wrangler.toml`. Without the parent flag, Cloudflare retains no Workers Logs or Traces — child flags alone don't persist.

---

## v1.22.6

### Changed
- **Bump minor/patch dependencies** — routine dev-tooling refresh:
  - `@biomejs/biome` `^2.4.11` → `^2.4.12` (root)
  - `@cloudflare/workers-types` `^4.20260414.1` → `^4.20260415.1` (root + slackbot)
  - `wrangler` `4.81.1` → `4.82.2` (root + slackbot)
  - `pnpm-lock.yaml` regenerated. No dependabot PRs or security alerts were open at the time of this bump. Major-version updates (`typescript` 6, `vite` 8, `vitest` 4 root/slackbot, `@vitest/coverage-v8` 4, `@vitejs/plugin-react` 6, `@cloudflare/vitest-pool-workers` 0.14, `lucide-react` 1.x) were intentionally deferred. CI parity validated locally: lint, admin lint, format check, root + workspace typechecks, full test suite (root 463 + shared 68 + admin 79 + mcp 80 + slackbot 104 = 794 tests), and admin dashboard build all pass.

---

## v1.22.5

### Changed
- **Restore Gilroy `@font-face` declarations (public CDN default)** — v1.22.4 removed the four `@font-face` blocks that loaded Gilroy from a public CDN, thinking it was a leak. The CDN bucket is in fact a public R2 bucket intended to serve the font publicly, so it's an appropriate default for this template. Restored the declarations in `admin/src/index.css` with an updated comment explaining that (a) the default loads from this public CDN, (b) the `font-display: swap` fallback stack handles CDN-unreachable cases gracefully, and (c) self-hosters can replace the blocks with their own font URLs. The rest of the v1.22.4 sanitisation sweep (the `VITE_API_URL` default, server comments, absolute-path examples, JSDoc host examples, and upstream provenance references) remains unchanged.

---

## v1.22.4

### Changed
- **Sanitisation sweep for public distribution** — remove or genericise residual references to personal/team infrastructure that had leaked into the public template:
  - **`VITE_API_URL` default** — `admin/Dockerfile`, `admin/Dockerfile.tailscale`, and `admin/.env.example` defaulted to a personal domain. Now defaults to `https://yourdomain.com` — self-hosters must set `VITE_API_URL` to their own Bifrost admin API origin at build time.
  - **Gilroy font `@font-face` blocks** — `admin/src/index.css` previously loaded the Gilroy typeface from a third-party CDN hard-coded into the template. Removed the four `@font-face` declarations; kept the `--font-gilroy` CSS variable with its `ui-sans-serif, system-ui, sans-serif` fallback stack so existing `font-gilroy` utility classes continue to resolve gracefully. Replaced with an inline comment documenting how self-hosters can supply their own brand font.
  - **"Blocktree" naming in dashboard CSS and JSDoc** — renamed to generic "Brand"/"Color Palette" labels in `admin/src/index.css` and `admin/src/lib/parse-changelog.ts`.
  - **`hostHeader` JSDoc examples** — changed to `"example.com"` in `shared/src/types.ts`, `shared/src/tools.ts`, `src/types.ts` (4 occurrences).
  - **`vps-2` comment in `admin/docker-compose.prod.yml`** — changed to generic "your server".
  - **Absolute-path example in `mcp/PLAN.md`** — changed to `/path/to/bifrost-router/mcp/dist/index.js` (two occurrences).
  - **Stale excluded path in `.dockerignore`** — removed (file does not exist in this repo; was a leftover from an upstream multi-zone config).
  - **`CHANGELOG.md` provenance references** — historical entries that credited the upstream repo by internal names rewritten to the generic phrase "upstream Bifrost". No functional history was altered; only the wording that revealed internal repo names.
- **`CONTRIBUTING.md` GitHub Issues link** — kept as-is (`github.com/henrychong-ai/bifrost-router`). This is the canonical public-repo URL that contributors need to file issues against; the `henrychong-ai` GitHub org owns this public template.

---

## v1.22.3

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

## v1.22.2

### Added
- **Drift-detection test for `SUPPORTED_DOMAINS`** — `test/supported-domains-consistency.test.ts` asserts that all three hardcoded copies (`src/types.ts`, `shared/src/types.ts`, `admin/src/context/filter-types.ts`) plus the OpenAPI `DomainQuery` enum contain identical domain lists. Self-hosters adding new domains will get a CI failure if they miss any of the 4 locations.

### Changed
- **"Adding a New Supported Domain" checklist updated from 4 → 6 locations** — `shared/src/types.ts` and `admin/src/context/filter-types.ts` were silently missing from the checklist, which caused drift in upstream repos.

---

## v1.22.1

### Changed
- **Use `routeKey()` helper in normalize-case endpoint** — `POST /api/routes/normalize-case` now uses the existing `routeKey(domain, path)` helper from `src/kv/schema.ts` instead of hand-constructing keys. Refactor-only; no behaviour change.

---

## v1.22.0

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
- **Changelog dashboard** — New `/changelog` page with searchable version history, section badges, current version highlighting, and inline code rendering. Synced from upstream Bifrost v1.25.0.
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
- **Cross-navigation** — Branded pill buttons for "View in Storage" and "View in Routes" actions (blue-50/blue-700 pill style)

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

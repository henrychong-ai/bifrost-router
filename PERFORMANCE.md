# Performance benchmarks

This file records reproducible performance baselines and measured changes. Run
benchmarks on an otherwise idle machine and compare the same benchmark and build
configuration before and after a change.

## 2026-08-12 — v1.32.0

Environment: macOS 26.5.2, Node.js 24.19.0, pnpm 10.33.0. Measurements are
deterministic local regression signals, not claims about Cloudflare production
latency. This public template still has CI only; no live infrastructure was
deployed during release validation.

### Analytics summary

Command: `pnpm run benchmark:analytics`

The real `getAnalyticsSummary()` read model was warmed, then measured three
times against 1,100 deterministic D1 rows across the four legacy streams and
the optional unified shadow stream. Run times were 5 / 5 / 5 ms (5 ms median),
below the enforced 20 ms ceiling. D1 work is bounded to six simultaneous
operations, matching the platform connection limit.

### Unified analytics dormant path

Command: `pnpm run benchmark:unified-disabled`

Five paired 100,000-iteration samples measured the actual response middleware,
not a helper proxy. The disabled path was 50.30 ns/op, with 27.03 ns/op median
incremental overhead and zero scheduled writes, below the 1,000 ns/op ceiling.

### Worker route lookup

Command: `pnpm run benchmark:routing:gate`

The gate records the median of three independent benchmark means and allows at
most 15% regression against the reviewed v1.31.0 baseline.

| Scenario | v1.31.0 baseline | v1.32.0 median | Change | Ceiling |
|---|---:|---:|---:|---:|
| Exact route hit | 2.2371 ms | 2.3256 ms | +3.96% | 2.5727 ms |
| Root wildcard hit | 4.6129 ms | 4.8641 ms | +5.45% | 5.3048 ms |
| Full miss | 4.6129 ms | 4.8976 ms | +6.17% | 5.3048 ms |

No route-lookup implementation changed in v1.32.0; the observed movement is
local scheduler variance and remains inside the fixed gate.

### Dashboard and Worker bundles

Command: `pnpm -C admin run build` and `pnpm run wrangler:check`

| Output | v1.31.0 | v1.32.0 | Change |
|---|---:|---:|---:|
| Dashboard initial JS, raw | 241.45 kB | 241.65 kB | +0.08% |
| Dashboard initial JS, gzip | 75.53 kB | 75.57 kB | +0.05% |
| Worker upload, raw | 1,096.71 KiB | 1,125.78 KiB | +2.65% |
| Worker upload, gzip | 193.41 KiB | 198.86 KiB | +2.82% |

The analytics page remains a deferred route chunk (23.20 kB raw / 6.77 kB
gzip). Production and development dry-runs produce the same Worker bundle and
show complete, isolated placeholder bindings.

### Verification

- `pnpm run check`: pass — 597 Worker, 217 shared, 208 dashboard, 92 MCP, and
  104 Slackbot tests (1,218 total), plus 6 Node regression gates
- `pnpm run test:coverage:all`: pass — Worker 69.91% statements / 58.26%
  branches / 67.35% functions / 70.78% lines; shared 83.29% / 76.47% /
  67.39% / 82.85%; dashboard scope 43.96% / 49.23% / 33.14% / 45.35%;
  MCP 68.44% / 57.56% / 85.71% / 68.70%
- Analytics read model: 93.67% statements / 74.31% branches / 92.30%
  functions / 93.15% lines; dashboard page: 56.25% statements / 65.59%
  branches / 53.48% functions / 57.97% lines
- `pnpm install --frozen-lockfile` and `pnpm audit`: pass; zero advisories
- `pnpm run public:check`: pass across 343 tracked and untracked release files
- Gitleaks: pass across 121 commits and the complete current tree
- OpenAPI YAML/schema assertions, static dashboard CSP/header checks, runtime
  types, production/development Wrangler dry-runs, and `git diff --check`: pass

## 2026-08-10 — v1.31.0

Environment: macOS 26.5.2, Node.js 24.19.0, pnpm 10.33.0. Browser tracing was
not available in this validation session, so the dashboard result is a
production-build transfer-size proxy, not a Core Web Vitals claim. This public
template has CI but no enabled deployment workflow, so no live production
latency claim is made.

### Worker route lookup

Command: `pnpm run benchmark:routing`

The benchmark calls the real `matchRoute()` implementation for an eight-segment
path. Its KV fake waits 2 ms per read so serial critical-path growth is visible
without internet variance. Each case warms up, then samples for one second.

| Scenario | Before mean | After mean | Change | p99 after |
|---|---:|---:|---:|---:|
| Exact route hit | 2.2267 ms | 2.2371 ms | +0.47% | 3 ms |
| Root wildcard hit | 19.9804 ms | 4.6129 ms | -76.91% (4.33x) | 5 ms |
| Full miss | 20.0000 ms | 4.6129 ms | -76.94% (4.34x) | 5 ms |

The implementation loads wildcard candidates concurrently after the exact
lookup. It still examines results from most-specific to least-specific, so
completion order cannot change route precedence. The trade-off is more
concurrent reads when an early wildcard matches; maximum reads are unchanged
from a full miss.

### Dashboard initial JavaScript

Command: `pnpm -C admin run build`

| Production build output | Before | After | Change |
|---|---:|---:|---:|
| Initial JS, raw | 959.61 kB | 241.45 kB | -74.84% |
| Initial JS, gzip | 280.85 kB | 75.53 kB | -73.11% |

All page modules previously entered the initial graph through the `@/pages`
barrel. Static route-level dynamic imports now retain only the application shell,
providers, layout, and command palette in the eager chunk. Each of the 13 pages
loads when navigated to; the final build's largest deferred chunk is 127.46 kB
raw / 34.59 kB gzip.

### Verification

- `pnpm run benchmark:routing`: pass
- `pnpm run check`: pass — 585 root tests plus 206 shared, 204 admin,
  92 MCP, and 104 Slackbot tests
- `pnpm run test:coverage`: pass — 69.24% statements / 70.17% lines
- `pnpm -C admin run build`: pass; root and nested SPA paths returned HTTP 200
- `wrangler deploy --dry-run`: pass — 1,096.71 KiB raw / 193.41 KiB gzip
- `wrangler check startup`: pass local startup analysis (diagnostic only; not a
  Cloudflare-hardware latency measurement)
- `pnpm install --frozen-lockfile`: pass
- `pnpm audit`: pass, zero known vulnerabilities
- Gitleaks current-tree scan: pass, no leaks found

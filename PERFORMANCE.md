# Performance benchmarks

This file records reproducible performance baselines and measured changes. Run
benchmarks on an otherwise idle machine and compare the same benchmark and build
configuration before and after a change.

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

# Cloudflare WAF — recommended custom rules

Bifrost ships application-layer hardening (see `src/middleware/sensitive-paths.ts`),
but a Worker is only one layer. This document lists the Cloudflare **WAF Custom
Rules** a self-hoster should deploy on their zone, and why.

None of these are created automatically — a Worker cannot configure its own zone.
Deploy them from **Cloudflare Dashboard → Security → WAF → Custom rules**, or via
the API.

> **Plan constraint:** the `matches` operator (regex) requires **Business or
> Enterprise**. Every rule below is written with `contains` / `eq` only, so they
> work on Free and Pro. If you are on Business+, you may prefer tighter regex
> equivalents.

---

## Rule 1: Skip bot protection for API and programmatic traffic

If you enable Bot Fight Mode, Cloudflare challenges automated (non-browser)
requests. That breaks legitimate server-to-server traffic — API clients, CI, and
any Worker self-subrequest.

| Field | Value |
|---|---|
| **Action** | Skip → Bot Fight Mode |

```
(http.host eq "bifrost.example.com" and (
  http.request.uri.path eq "/health"
  or starts_with(http.request.uri.path, "/api/")
  or starts_with(http.request.uri.path, "/.well-known/")
))
```

Dashboard routes are deliberately **not** skipped — real browsers solve the
challenge natively.

---

## Rule 2: Rate-limit the admin API

| Field | Value |
|---|---|
| **Action** | Block |
| **Expression** | `http.host eq "bifrost.example.com" and starts_with(http.request.uri.path, "/api/")` |
| **Rate** | 100 requests per 10 seconds |

**Sizing note.** A burst cap like this protects against floods but **not** against
slow credential probing — an attacker at 1 request/second never approaches it. If
that matters to you, add a *second, layered* rule at a sustained rate (for example
60 requests per 60 seconds) rather than lowering the burst cap, which legitimate
tool-driven traffic may depend on.

Bifrost's in-Worker `rate-limit` middleware runs **after** authentication and
therefore counts only authenticated requests. Pre-auth probes pass through it —
the edge is the layer that has to catch those.

---

## Rule 3: Block path-traversal / LFI patterns in query strings

Scanners probe for local-file-inclusion with query strings like
`?file=../../../etc/passwd`. A Worker has **no filesystem**, so the probe cannot
exfiltrate anything — and `denySensitivePaths` already returns a clean 404 for it
on the admin host. This rule is defence-in-depth, so the pattern is stopped at the
edge like its SQLi/XSS peers rather than reaching the origin at all.

| Field | Value |
|---|---|
| **Action** | Block |

```
(http.host eq "bifrost.example.com" and (
  http.request.uri.query contains "../"
  or http.request.uri.query contains "..%2f"
  or http.request.uri.query contains "..%2F"
  or http.request.uri.query contains "%2e%2e%2f"
  or http.request.uri.query contains "%2E%2E%2F"
  or http.request.uri.query contains "..%5c"
  or http.request.uri.query contains "..%5C"
  or http.request.uri.query contains "%2e%2e/"
))
```

**Matches on `query` only, not path.** Path-component traversal is normalised at
the Cloudflare edge before WAF evaluation, so a path-based rule would never fire.

**False-positive risk — low but real.** A legitimate query carrying `..` inside a
longer encoded value (say a base64 token that decodes to contain `../`) would also
be blocked. No bifrost admin endpoint accepts arbitrary file references in query
strings, so the blast radius is contained — but check your own additions.

**Smoke tests after deploying:**

```
403  https://bifrost.example.com/?file=../../../etc/passwd
403  https://bifrost.example.com/?file=..%2f..%2fetc%2fpasswd
403  https://bifrost.example.com/?file=%2e%2e%2f%2e%2e%2fetc%2fpasswd
403  https://bifrost.example.com/?file=..%5c..%5cwindows%5csystem32
200  https://bifrost.example.com/?file=resume.pdf     ← legitimate, must NOT block
```

That last case matters most — a rule that blocks everything is not a passing test.

---

## What the Worker already does (no WAF needed)

`src/middleware/sensitive-paths.ts` returns **404** for:

- build-system and source-tree paths (`/wrangler.toml`, `/package.json`,
  `/src/*`, `/.git/*`, `/node_modules/*`, …), case-insensitively
- query-string path traversal on the admin host, across up to three URL-decode
  passes so single-, double- and triple-encoded probes are all caught

**Deliberately NOT denied:** `/docs`, `/admin`, `/backup`, `/swagger`,
`/openapi.json`. These are plausible KV short-link names an operator may
legitimately register. Denying them would break a real feature to satisfy a
scanner — and since an unmatched path returns the same response as any random
string, they disclose nothing.

## Expression syntax quick reference

| Pattern | Syntax |
|---|---|
| Exact path | `http.request.uri.path eq "/health"` |
| Path prefix | `starts_with(http.request.uri.path, "/api/")` |
| Host match | `http.host eq "bifrost.example.com"` |
| Header check | `any(http.request.headers["x-custom"][*] eq "value")` |
| Case-insensitive | `lower(http.request.uri.path) eq "/wrangler.toml"` |
| AND / OR | `and` / `or` (lowercase) |

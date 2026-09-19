# Credential redaction

The route guard and analytics use one name-based policy, implemented in
`src/utils/credential-redaction.ts`. This is a heuristic, not a general secret
scanner. Repository Gitleaks and feedback-capture redaction remain separate controls.

- Ordinary query fields retain their original bytes, including duplicates and flags.
- Credential-named fields lose their entire value. `code`, `state`, `session`, and
  `ticket` are always sensitive; there are no length or randomness exceptions.
  Use explicit campaign names such as `utm_campaign`, `promo`, or `tier` instead.
  These names are not bypasses: embedded credentials are still detected.
- Nested URLs, packed pairs, path pairs, and fragments are inspected in raw form
  and at most two percent-decoded levels. A suspicious outer field is masked
  wholesale. No recursive parsing or reconstruction of nested content occurs.
- Inputs over 16,384 characters, invalid percent-encoded UTF-8, or encoding beyond
  the inspection budget are conservatively masked. The guard returns a fixed
  `uninspectable input` label. The bound limits work, not just output size.
- Stored destination/referrer copies preserve harmless URLs. Suspicious paths,
  fragments, or URL userinfo cause the whole URL to become `[redacted]`; ordinary
  query strings receive field-level masking. Existing capture clamps still apply.
- Route destination copies in analytics, matched-route/proxy error logs, and
  structured audit snapshots are sanitised. The actual KV destination, redirect
  Location, and proxy request remain intact. Do not sanitise operational values.
- Create/update/re-enable/seed/transfer keep server-enforced acknowledgement.
  Disabled routes and R2 object keys retain their existing guard exemptions.
  Acknowledgement permits the write; it does not make a credential safe to publish.
- Existing records are not rewritten. Use the read-only route inventory to review
  stored targets; repair or credential rotation requires a separate decision.

## Limits and deliberate trade-offs

This cannot identify arbitrary secrets under innocuous names or hidden in opaque
formats such as encrypted blobs. `pwd` retains its existing meeting-link semantics.
Whole-value masking may lose useful nested diagnostics. Malformed input may trigger
false positives. These costs replace the former complicated attempt to preserve
all harmless subfields. No retention policy or event capture is changed.

## Maintenance

`credential-redaction.json` pins the policy version and SHA-256 of the vendored
module and its portable contract/property tests. `pnpm run redaction:check` fails on
drift. Update the canonical implementation and tests together, distribute identical
copies, and update the manifest intentionally after review. Never fix drift by
blindly refreshing only a downstream hash.

Tests cover name detection, campaign fidelity, nested containment, idempotence,
opaque inputs, Unicode, bounded work, and stored-copy versus serving behaviour.
Keep coverage thresholds unchanged when refactoring. The generated test oracle
plants synthetic values independently of the production predicates.

## Existing-route inventory

Inject `BIFROST_ADMIN_KEY` from the correct account/environment and run
`node scripts/scan-route-credentials.mjs https://api.example.com /tmp/route-review.json`.
This issues only GET, refuses redirects and incomplete responses, and writes route
identities plus warning labels without target values. It includes disabled routes
for review, but skips R2 object keys. No route is changed or disabled.

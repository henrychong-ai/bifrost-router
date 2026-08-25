/**
 * R2 bucket-catalogue drift guards.
 *
 * `wrangler.toml` bindings are NOT inherited by `[env.*]`, so a bucket added to
 * `R2_BUCKETS`, `BUCKET_BINDINGS` and the top-level `[[r2_buckets]]` — but not
 * to `[[env.dev.r2_buckets]]` — is invisible to CI (the `Bindings` fields are
 * optional and the handler resolves them dynamically via
 * `c.env[BUCKET_BINDINGS[bucket]]`) and surfaces only on the deployed
 * development Worker as a handled 404. See the "Adding a New R2 Bucket"
 * checklist in CLAUDE.md — nothing else enforces steps 2 and 5.
 */
import { describe, expect, it } from 'vitest';
import { R2_BUCKETS as SHARED_R2_BUCKETS } from '@bifrost/shared';
import { R2_BUCKETS, BUCKET_BINDINGS, ALL_BUCKET_BINDINGS } from '../src/types';
import wranglerToml from '../wrangler.toml?raw';

/**
 * Parse `binding → bucket_name` from the TOP-LEVEL (production) [[r2_buckets]]
 * blocks only — everything before the first `[env.` table.
 */
function parseProdR2Bindings(toml: string): Record<string, string> {
  const prodSection = toml.split(/\n\[env\./)[0];
  const bindings: Record<string, string> = {};
  for (const block of prodSection.split(/\[\[r2_buckets\]\]/).slice(1)) {
    // Bound each block at the next TOML table header so the final block never
    // swallows unrelated sections ([[services]], [vars], ...).
    const body = block.split(/\n\[/)[0];
    const binding = body.match(/binding\s*=\s*"([^"]+)"/)?.[1];
    const bucketName = body.match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
    if (binding && bucketName) bindings[binding] = bucketName;
  }
  return bindings;
}

/**
 * Parse `binding → bucket_name` from the `[[env.dev.r2_buckets]]` blocks.
 *
 * This checks DECLARATION coverage only — that every binding exists in the
 * development environment — never physical-name correctness, which is a
 * production invariant asserted separately. A fork is free to point its
 * development bindings wherever it likes (distinct `*-dev` buckets, as shipped,
 * or several bindings aliased onto one shared bucket), and this guard stays
 * valid either way.
 */
function parseDevR2Bindings(toml: string): Record<string, string> {
  const devSection = toml.split(/\n\[env\.dev\]/)[1] ?? '';
  const bindings: Record<string, string> = {};
  for (const block of devSection.split(/\[\[env\.dev\.r2_buckets\]\]/).slice(1)) {
    // Bound at the next table header — the final block otherwise runs through
    // [[env.dev.services]] and [env.dev.triggers].
    const body = block.split(/\n\[/)[0];
    const binding = body.match(/binding\s*=\s*"([^"]+)"/)?.[1];
    const bucketName = body.match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
    if (binding && bucketName) bindings[binding] = bucketName;
  }
  return bindings;
}

describe('R2 bucket catalogue consistency', () => {
  it('the three catalogues are set-EQUAL, in the same order', () => {
    // Runtime VALUES, not parsed source text: a half-finished rename that left
    // a stale name behind as an EXTRA entry would pass a subset check while the
    // handler still accepted the stale bucket as valid.
    expect([...SHARED_R2_BUCKETS]).toEqual([...R2_BUCKETS]);
    expect(Object.keys(BUCKET_BINDINGS)).toEqual([...R2_BUCKETS]);
  });

  it('PROD: every logical bucket name IS its physical bucket_name', () => {
    const prod = parseProdR2Bindings(wranglerToml);
    for (const bucket of R2_BUCKETS) {
      const binding = BUCKET_BINDINGS[bucket];
      expect(
        prod[binding],
        `prod binding ${binding} should point at physical bucket "${bucket}"`,
      ).toBe(bucket);
    }
  });

  it('DEV: every catalogue bucket has an [env.dev] binding', () => {
    const dev = parseDevR2Bindings(wranglerToml);
    for (const bucket of R2_BUCKETS) {
      const binding = BUCKET_BINDINGS[bucket];
      expect(
        dev[binding],
        `[[env.dev.r2_buckets]] missing binding ${binding} for bucket "${bucket}"`,
      ).toBeDefined();
    }
  });

  it('BOTH ENVS: out-of-catalogue bucket bindings are declared too', () => {
    // Two R2 bindings live outside the `R2_BUCKETS` catalogue and would
    // otherwise have no drift guard at all:
    //   • BACKUP_BUCKET   — in ALL_BUCKET_BINDINGS (the generic storage
    //     resolver), so an undeclared binding breaks the KV backup writes.
    //   • FEEDBACK_BUCKET — deliberately absent from ALL_BUCKET_BINDINGS
    //     (reachable only via the scoped feedback-attachment endpoint), so it
    //     is named literally here rather than derived.
    const prod = parseProdR2Bindings(wranglerToml);
    const dev = parseDevR2Bindings(wranglerToml);
    const bindings = [...new Set([...Object.values(ALL_BUCKET_BINDINGS), 'FEEDBACK_BUCKET'])];
    for (const binding of bindings) {
      expect(prod[binding], `prod [[r2_buckets]] missing binding ${binding}`).toBeDefined();
      expect(dev[binding], `[[env.dev.r2_buckets]] missing binding ${binding}`).toBeDefined();
    }
    // PROD physical names for the out-of-catalogue pair — the name invariant
    // above does not cover them, and a typo would break KV backups / feedback
    // attachments silently.
    expect(prod.BACKUP_BUCKET).toBe('bifrost-backups');
    expect(prod.FEEDBACK_BUCKET).toBe('bifrost-feedback');
    // Enforce (not just document) the boundary: FEEDBACK_BUCKET must never
    // join the generic storage resolver.
    expect(Object.values(ALL_BUCKET_BINDINGS)).not.toContain('FEEDBACK_BUCKET');
  });

  it('the parsers actually find the blocks they claim to (self-check)', () => {
    // A regex that silently matched nothing would make every assertion above
    // vacuous, since `for (const x of [])` passes.
    expect(Object.keys(parseProdR2Bindings(wranglerToml)).length).toBeGreaterThanOrEqual(
      R2_BUCKETS.length + 2,
    );
    expect(Object.keys(parseDevR2Bindings(wranglerToml)).length).toBeGreaterThanOrEqual(
      R2_BUCKETS.length + 2,
    );
  });
});

/**
 * QR design presets (v1.30.0 — ported from the internal Bifrost deployments'
 * v1.58.0 preset system, shipped NEUTRAL for the public template).
 *
 * This template ships no branded presets: every QR defaults to the neutral
 * black-on-white design, and the editor's colour/logo fields cover ad-hoc
 * customisation. To brand your deployment, add entries to QR_BRAND_PRESETS —
 * each preset pins module/background colours and an optional `assets`-bucket
 * logo key, and maps the domains it should apply to. The drift-guard test
 * (qr-brand-presets.test.ts) then forces every SUPPORTED_DOMAIN to be either
 * branded or deliberately neutral, so a new domain can never silently ship
 * with an undecided design.
 *
 * Design doctrine (inherited): keep fg/bg contrast ≥4.5:1 for scannability
 * (the editor warns below that), and logos are fetched from the `assets`
 * bucket at CREATE time and embedded as downscaled PNG data URIs — never
 * bundled into the repo.
 */

import { SUPPORTED_DOMAINS, type SupportedDomain } from './types.js';

export interface QrBrandPreset {
  /** Stable preset id (dropdown value; NOT stored on QR records). */
  id: string;
  /** Human label for the dashboard dropdown. */
  label: string;
  /** Foreground (module) color. */
  fg: string;
  /** Background color. */
  bg: string;
  /**
   * `assets`-bucket key of the centre logo, or null for a colours-only
   * preset. Fetched same-origin via `GET /api/storage/assets/objects/{key}`.
   */
  logoAssetKey: string | null;
  /** Supported domains this preset covers (drift-guarded against the universe). */
  domains: readonly SupportedDomain[];
}

/** No branded presets in the template — add your own here. */
export const QR_BRAND_PRESETS: readonly QrBrandPreset[] = [] as const;

/**
 * Domains with NO branded preset — they fall back to the neutral default
 * design. The template ships with every domain neutral; move domains out of
 * this list as you add presets.
 */
export const QR_NEUTRAL_DOMAINS: readonly SupportedDomain[] = [...SUPPORTED_DOMAINS];

/** The neutral (non-branded) default design — the schema defaults. */
export const NEUTRAL_QR_DESIGN = { fg: '#000000', bg: '#ffffff' } as const;

/** Resolve the brand preset for a domain, or null for neutral/unknown domains. */
export function deriveBrandForDomain(domain: string): QrBrandPreset | null {
  for (const preset of QR_BRAND_PRESETS) {
    if ((preset.domains as readonly string[]).includes(domain)) return preset;
  }
  return null;
}

/**
 * Drift-guard helper: every SUPPORTED_DOMAIN must be covered by exactly one
 * preset or the explicit neutral list. Exported for the consistency test so a
 * NEW domain fails CI until someone decides its design.
 */
export function uncoveredDomains(): string[] {
  const covered = new Set<string>([
    ...QR_BRAND_PRESETS.flatMap(p => p.domains as readonly string[]),
    ...(QR_NEUTRAL_DOMAINS as readonly string[]),
  ]);
  return SUPPORTED_DOMAINS.filter(d => !covered.has(d));
}

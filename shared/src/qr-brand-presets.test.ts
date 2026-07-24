import { describe, it, expect } from 'vitest';
import {
  QR_BRAND_PRESETS,
  QR_NEUTRAL_DOMAINS,
  NEUTRAL_QR_DESIGN,
  deriveBrandForDomain,
  uncoveredDomains,
} from './qr-brand-presets.js';
import { qrContrastRatio } from './qr-render.js';
import { SUPPORTED_DOMAINS } from './types.js';

/**
 * Drift-guards for the QR presets (v1.30.0). The template ships neutral —
 * these tests make the structural obligations un-skippable for any presets a
 * self-hoster adds: full domain coverage, no double-brand ambiguity, and
 * scannable contrast.
 */
describe('QR design presets (template)', () => {
  it('every SUPPORTED_DOMAIN is covered by exactly one preset or the neutral list', () => {
    // A NEW supported domain fails here until someone decides its design —
    // add it to a preset's domains[] or to QR_NEUTRAL_DOMAINS deliberately.
    expect(uncoveredDomains()).toEqual([]);

    for (const domain of SUPPORTED_DOMAINS) {
      const inPresets = QR_BRAND_PRESETS.filter(p =>
        (p.domains as readonly string[]).includes(domain),
      );
      const inNeutral = (QR_NEUTRAL_DOMAINS as readonly string[]).includes(domain);
      expect(inPresets.length + (inNeutral ? 1 : 0)).toBe(1);
    }
  });

  it('preset domains never reference a domain outside SUPPORTED_DOMAINS', () => {
    const universe = new Set<string>(SUPPORTED_DOMAINS);
    for (const preset of QR_BRAND_PRESETS) {
      for (const domain of preset.domains) {
        expect(universe.has(domain)).toBe(true);
      }
    }
    for (const domain of QR_NEUTRAL_DOMAINS) {
      expect(universe.has(domain)).toBe(true);
    }
  });

  it('any presets added stay scannable (≥4.5:1 contrast)', () => {
    for (const preset of QR_BRAND_PRESETS) {
      const ratio = qrContrastRatio(preset.fg, preset.bg);
      expect(ratio, `${preset.id} fg/bg contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the template ships fully neutral', () => {
    expect(QR_BRAND_PRESETS).toEqual([]);
    expect([...QR_NEUTRAL_DOMAINS].sort()).toEqual([...SUPPORTED_DOMAINS].sort());
  });

  it('deriveBrandForDomain returns null for every domain (neutral template)', () => {
    for (const domain of SUPPORTED_DOMAINS) {
      expect(deriveBrandForDomain(domain)).toBeNull();
    }
    expect(deriveBrandForDomain('unknown.example.com')).toBeNull();
  });

  it('neutral design stays black-on-white', () => {
    expect(NEUTRAL_QR_DESIGN).toEqual({ fg: '#000000', bg: '#ffffff' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_HEALTHCHECK_UA_TOKEN,
  analyticsDeltaPercent,
  analyticsShare,
  canonicalAnalyticsUrl,
  isCloudflareHealthcheckUserAgent,
  normalizeAnalyticsPath,
} from './analytics-utils';

describe('analytics monitoring classifier', () => {
  it('matches the stable token inside wrapper variants', () => {
    expect(isCloudflareHealthcheckUserAgent(CLOUDFLARE_HEALTHCHECK_UA_TOKEN)).toBe(true);
    expect(
      isCloudflareHealthcheckUserAgent(
        `Mozilla/5.0 (compatible; ${CLOUDFLARE_HEALTHCHECK_UA_TOKEN}; +https://www.cloudflare.com/)`,
      ),
    ).toBe(true);
  });

  it('retains null, case variants, near matches, and unrelated bots', () => {
    expect(isCloudflareHealthcheckUserAgent(null)).toBe(false);
    expect(isCloudflareHealthcheckUserAgent(undefined)).toBe(false);
    expect(isCloudflareHealthcheckUserAgent('cloudflare-healthchecks/1.0')).toBe(false);
    expect(isCloudflareHealthcheckUserAgent('Cloudflare-Healthcheck/1.0')).toBe(false);
    expect(isCloudflareHealthcheckUserAgent('Googlebot/2.1')).toBe(false);
  });
});

describe('canonical analytics URLs', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['legacy', '/legacy'],
    ['///legacy', '/legacy'],
    ['//evil.example/path', '/evil.example/path'],
  ])('normalises %j without changing authority', (stored, expected) => {
    expect(normalizeAnalyticsPath(stored)).toBe(expected);
  });

  it('encodes spaces and Unicode safely', () => {
    expect(canonicalAnalyticsUrl('Example.COM', '/reports/Q3 results/張')).toBe(
      'https://example.com/reports/Q3%20results/%E5%BC%B5',
    );
  });

  it('keeps query and fragment text inside the path', () => {
    expect(canonicalAnalyticsUrl('example.com', '/already%20encoded?q=1#frag')).toBe(
      'https://example.com/already%20encoded%3Fq=1%23frag',
    );
  });
});

describe('analytics ratios', () => {
  it('uses 0..1 shares with zero guards', () => {
    expect(analyticsShare(25, 100)).toBe(0.25);
    expect(analyticsShare(0, 100)).toBe(0);
    expect(analyticsShare(1, 0)).toBe(0);
  });

  it('uses explicit zero-baseline delta semantics', () => {
    expect(analyticsDeltaPercent(150, 100)).toBe(50);
    expect(analyticsDeltaPercent(50, 100)).toBe(-50);
    expect(analyticsDeltaPercent(0, 0)).toBe(0);
    expect(analyticsDeltaPercent(1, 0)).toBeNull();
  });
});

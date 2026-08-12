import { describe, expect, it } from 'vitest';
import {
  boundedUnifiedCacheStatus,
  boundedUnifiedCountry,
  boundedUnifiedLatencyMs,
  classifyUnifiedTraffic,
  isUnifiedTrafficCaptureActive,
  isUnifiedTrafficRequestEligible,
  parseUnifiedTrafficCutoverAt,
  parseUnifiedTrafficRetentionDays,
  privacySafeUnifiedAnalyticsPath,
  unifiedTrafficOutcome,
} from '../../src/utils/unified-traffic';

describe('unified traffic configuration', () => {
  it('requires shadow mode and an explicit reached RFC3339 cutover', () => {
    expect(isUnifiedTrafficCaptureActive('off', '2026-08-12T00:00:00Z', 1_786_492_800)).toBe(false);
    expect(isUnifiedTrafficCaptureActive('shadow', '', 1_786_492_800)).toBe(false);
    expect(isUnifiedTrafficCaptureActive('shadow', '2026-08-13T00:00:00Z', 1_786_492_800)).toBe(
      false,
    );
    expect(isUnifiedTrafficCaptureActive('shadow', '2026-08-12T00:00:00Z', 1_786_492_800)).toBe(
      true,
    );
  });

  it('fails closed on timezone-free or invalid values', () => {
    expect(parseUnifiedTrafficCutoverAt('2026-08-12T00:00:00')).toBeNull();
    expect(parseUnifiedTrafficCutoverAt('not-a-date')).toBeNull();
    expect(parseUnifiedTrafficRetentionDays('30')).toBe(30);
    expect(parseUnifiedTrafficRetentionDays('0')).toBeNull();
  });
});

describe('unified request eligibility', () => {
  const base = {
    mode: 'shadow',
    cutoverAt: '2026-08-12T00:00:00Z',
    hostname: 'example.com',
    adminHostname: 'bifrost.example.com',
    path: '/docs',
    userAgent: 'Mozilla/5.0',
    nowSeconds: 1_786_492_800,
  };

  it('includes public traffic and excludes operational surfaces', () => {
    expect(isUnifiedTrafficRequestEligible(base)).toBe(true);
    expect(isUnifiedTrafficRequestEligible({ ...base, hostname: 'bifrost.example.com' })).toBe(
      false,
    );
    expect(isUnifiedTrafficRequestEligible({ ...base, path: '/health' })).toBe(false);
    expect(isUnifiedTrafficRequestEligible({ ...base, path: '/api/routes' })).toBe(false);
    expect(isUnifiedTrafficRequestEligible({ ...base, path: '/.well-known/security.txt' })).toBe(
      false,
    );
  });

  it('excludes only the exact Cloudflare Health Checks token', () => {
    expect(
      isUnifiedTrafficRequestEligible({ ...base, userAgent: 'Cloudflare-Healthchecks/1.0' }),
    ).toBe(false);
    expect(
      isUnifiedTrafficRequestEligible({ ...base, userAgent: 'cloudflare-healthchecks/1.0' }),
    ).toBe(true);
  });
});

describe('unified event bounds', () => {
  it('normalises path and coarse classifications', () => {
    expect(privacySafeUnifiedAnalyticsPath('///docs')).toBe('/docs');
    expect(classifyUnifiedTraffic('/docs', 'Mozilla/5.0')).toBe('browser');
    expect(classifyUnifiedTraffic('/wp-login.php', 'Mozilla/5.0')).toBe('automation');
    expect(classifyUnifiedTraffic('/docs', undefined)).toBe('unknown');
  });

  it('bounds metadata and maps outcomes', () => {
    expect(boundedUnifiedCacheStatus(' hit ')).toBe('HIT');
    expect(boundedUnifiedCountry('sg')).toBe('SG');
    expect(boundedUnifiedCountry('SGP')).toBeNull();
    expect(boundedUnifiedLatencyMs(999_999)).toBe(120_000);
    expect(unifiedTrafficOutcome(302)).toBe('redirect');
    expect(unifiedTrafficOutcome(404)).toBe('client_error');
    expect(unifiedTrafficOutcome(503)).toBe('server_error');
  });
});

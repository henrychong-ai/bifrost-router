import { describe, expect, it } from 'vitest';
import {
  findCredentialParams as find,
  legacyQueryString,
  legacyReferrer,
  redactSensitiveQueryValues as redact,
  redactRouteTarget as target,
  MAX_CREDENTIAL_INPUT,
  redactAuditDetails,
} from '../../src/utils/credential-redaction';

describe('credential policy contract', () => {
  it.each([
    'token',
    'access_token',
    'client_secret',
    'password',
    'api_key',
    'oauth.state',
    'code',
    'state[]',
    'session[0]',
    'ticket',
    'SAMLResponse',
    'X-Amz-Signature',
  ])('masks %s by name, irrespective of value shape', (name) => {
    const query = `?${name}=short&utm_campaign=Summer2026Sale`;
    expect(redact(query)).toBe(`?${name}=[redacted]&utm_campaign=Summer2026Sale`);
    expect(legacyQueryString(new URL(`https://example.com/${query}`))).toBe(redact(query));
    expect(find(query)).toContain(name);
  });

  it.each([
    '?utm_source=a+b&promo=Summer2026Sale&tier=VIPGold2026',
    '?q=a%20b&q=c%2Bd&flag&empty=',
    '?next=https%3A%2F%2Fexample.com%2Fhelp',
    '?pwd=meeting&author=alice&codec=png&statement=ok',
    '?',
    '?page=2',
  ])('preserves ordinary fields: %s', (query) => {
    expect(redact(query)).toBe(query);
    expect(find(query)).toEqual([]);
  });

  it.each([
    'next=https%3A%2F%2Fexample.com%2F%3Ftoken%3DLIVE_SECRET',
    'next=x;token=LIVE_SECRET',
    'next=/auth/token=LIVE_SECRET/path',
    'next=/callback#access_token=LIVE_SECRET',
    'next=key%3Fv%3DLIVE_SECRET',
    'next=to%09ken%3DLIVE_SECRET',
    'next=token%23v%3DLIVE_SECRET',
    'next=token%3Bv%3DLIVE_SECRET',
  ])('masks the whole outer value: %s', (field) => {
    expect(redact(`?${field}&page=2`)).toBe('?next=[redacted]&page=2');
  });

  it('handles encoded names without retaining dangerous name text', () => {
    expect(redact('?%74oken=LIVE_SECRET')).toBe('?[redacted]');
    expect(redact('?token/LIVE_SECRET=x')).toBe('?[redacted]');
    expect(redact('?token')).toBe('?token');
    expect(find('?token$=LIVE_SECRET')).toEqual(['credential-like field']);
    expect(find('?next=PLANTED_SECRET_VALUE=tail')).toEqual(['credential-like field']);
    expect(redact('?PLANTED_SECRET_VALUE=tail')).toBe('?[redacted]');
    expect(redact('token=LIVE_SECRET')).toBe('?token=[redacted]');
  });

  it('fails closed on oversized, malformed, and over-encoded input', () => {
    for (const input of [
      '?next=%E0%A4%A',
      '?next=%252574oken%253DLIVE_SECRET',
      `?q=${'x'.repeat(MAX_CREDENTIAL_INPUT)}`,
    ]) {
      expect(find(input)).toContain('uninspectable input');
      expect(redact(input)).not.toContain('LIVE_SECRET');
    }
    expect(redact(`?q=${'x'.repeat(MAX_CREDENTIAL_INPUT)}`)).toBe('?[redacted]');
    expect(target('x'.repeat(MAX_CREDENTIAL_INPUT + 1))).toBe('[redacted]');
  });

  it('protects stored URL copies including paths, fragments and userinfo', () => {
    expect(target('https://example.com/a?token=LIVE_SECRET&page=2')).toBe(
      'https://example.com/a?token=[redacted]&page=2',
    );
    for (const url of [
      'https://example.com/token=LIVE_SECRET/tail',
      'https://example.com/#access_token=LIVE_SECRET',
      'https://user:LIVE_SECRET@example.com/',
      'https://example.com/%74oken=LIVE_SECRET',
    ]) {
      expect(target(url)).toBe('[redacted]');
      expect(legacyReferrer(url)).toBe('[redacted]');
      expect(find(url).length).toBeGreaterThan(0);
    }
    expect(target('https://example.com/a?page=2#section')).toBe(
      'https://example.com/a?page=2#section',
    );
    expect(target('https://example.com/a#section')).toBe('https://example.com/a#section');
    expect(target('/plain/path')).toBe('/plain/path');
    expect(target('')).toBe('');
    expect(legacyReferrer(undefined)).toBeUndefined();
    expect(redact('')).toBeNull();
  });
});

describe('audit destination snapshots', () => {
  it('sanitises nested target fields while retaining normal audit metadata', () => {
    const target = 'https://example.com/?token=LIVE_SECRET';
    const details = JSON.stringify({
      route: { target },
      before: { targetUrl: target },
      after: { target_url: target },
      count: 2,
      target: null,
    });
    const result = redactAuditDetails(details)!;
    expect(result).not.toContain('LIVE_SECRET');
    expect(JSON.parse(result)).toMatchObject({ count: 2, target: null });
    expect(redactAuditDetails(result)).toBe(result);
    expect(redactAuditDetails(null)).toBeNull();
    expect(redactAuditDetails(undefined)).toBeNull();
    expect(redactAuditDetails('not JSON')).toBe('[redacted]');
  });
});

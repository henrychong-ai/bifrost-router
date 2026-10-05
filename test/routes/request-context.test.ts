import { describe, expect, it } from 'vitest';
import {
  getDomainFromRequest,
  getDomainOrDefaultFromRequest,
  getRequiredDomainFromRequest,
  MISSING_DOMAIN_ERROR,
} from '../../src/routes/request-context';

function context(options: { adminDomain?: string; headerDomain?: string; queryDomain?: string }) {
  return {
    req: {
      header: (name: string) => (name === 'X-Domain' ? options.headerDomain : undefined),
      query: (name: string) => (name === 'domain' ? options.queryDomain : undefined),
    },
    env: { ADMIN_API_DOMAIN: options.adminDomain },
  };
}

describe('read domain context (keeps the ADMIN_API_DOMAIN default)', () => {
  it('rejects unsupported admin and probe hosts as implicit route domains', () => {
    expect(
      getDomainOrDefaultFromRequest(context({ adminDomain: 'bifrost-dev.example.com' })),
    ).toEqual({ valid: false, error: 'Invalid default domain: bifrost-dev.example.com' });
    expect(
      getDomainOrDefaultFromRequest(context({ adminDomain: 'probe-dev.example.com' })),
    ).toEqual({
      valid: false,
      error: 'Invalid default domain: probe-dev.example.com',
    });
  });

  it('accepts an explicit supported domain before validating the fallback', () => {
    expect(
      getDomainOrDefaultFromRequest(
        context({ adminDomain: 'bifrost-dev.example.com', queryDomain: 'example.com' }),
      ),
    ).toEqual({ valid: true, domain: 'example.com' });
  });

  it('retains the supported default and rejects unsupported explicit input', () => {
    expect(getDomainOrDefaultFromRequest(context({}))).toEqual({
      valid: true,
      domain: 'example.com',
    });
    expect(getDomainOrDefaultFromRequest(context({ adminDomain: 'bifrost.example.com' }))).toEqual({
      valid: true,
      domain: 'bifrost.example.com',
    });
    expect(getDomainOrDefaultFromRequest(context({ headerDomain: 'evil.test' }))).toEqual({
      valid: false,
      error: 'Invalid domain: evil.test',
    });
  });
});

describe('mutation domain context (explicit, never defaulted)', () => {
  it('refuses an omitted domain even when ADMIN_API_DOMAIN names a supported domain', () => {
    for (const adminDomain of [undefined, 'example.com', 'bifrost.example.com']) {
      expect(getRequiredDomainFromRequest(context({ adminDomain }))).toEqual({
        valid: false,
        error: MISSING_DOMAIN_ERROR,
      });
    }
  });

  it('treats an empty selector as absent', () => {
    expect(getRequiredDomainFromRequest(context({ headerDomain: '', queryDomain: '' }))).toEqual({
      valid: false,
      error: MISSING_DOMAIN_ERROR,
    });
    expect(
      getRequiredDomainFromRequest(
        context({ headerDomain: '', queryDomain: 'secondary.example.net' }),
      ),
    ).toEqual({ valid: true, domain: 'secondary.example.net' });
  });

  it('accepts the header or the query alone, and both when they agree', () => {
    expect(getRequiredDomainFromRequest(context({ headerDomain: 'user1.example.com' }))).toEqual({
      valid: true,
      domain: 'user1.example.com',
    });
    expect(getRequiredDomainFromRequest(context({ queryDomain: 'links.example.com' }))).toEqual({
      valid: true,
      domain: 'links.example.com',
    });
    expect(
      getRequiredDomainFromRequest(
        context({ headerDomain: 'example.com', queryDomain: 'example.com' }),
      ),
    ).toEqual({ valid: true, domain: 'example.com' });
  });

  it('refuses an X-Domain header that conflicts with ?domain', () => {
    expect(
      getRequiredDomainFromRequest(
        context({ headerDomain: 'example.com', queryDomain: 'secondary.example.net' }),
      ),
    ).toEqual({
      valid: false,
      error:
        'Conflicting domain parameters: X-Domain is example.com but domain is secondary.example.net',
    });
    // Checked before validation, so an unsupported value in either slot still conflicts
    expect(
      getRequiredDomainFromRequest(
        context({ headerDomain: 'evil.test', queryDomain: 'example.com' }),
      ),
    ).toEqual({
      valid: false,
      error: 'Conflicting domain parameters: X-Domain is evil.test but domain is example.com',
    });
  });

  it('rejects an unsupported explicit domain', () => {
    expect(getRequiredDomainFromRequest(context({ queryDomain: 'evil.test' }))).toEqual({
      valid: false,
      error: 'Invalid domain: evil.test',
    });
  });
});

describe('conflicting selectors: one rule for every resolver', () => {
  const conflict = {
    valid: false,
    error:
      'Conflicting domain parameters: X-Domain is example.com but domain is secondary.example.net',
  };
  const both = context({
    adminDomain: 'example.com',
    headerDomain: 'example.com',
    queryDomain: 'secondary.example.net',
  });

  it('refuses them for list, single-domain read and write alike', () => {
    expect(getDomainFromRequest(both)).toEqual(conflict);
    expect(getDomainOrDefaultFromRequest(both)).toEqual(conflict);
    expect(getRequiredDomainFromRequest(both)).toEqual(conflict);
  });

  it('accepts agreeing selectors and treats an empty one as absent on reads', () => {
    expect(
      getDomainFromRequest(context({ headerDomain: 'example.com', queryDomain: 'example.com' })),
    ).toEqual({ valid: true, domain: 'example.com' });
    expect(
      getDomainOrDefaultFromRequest(
        context({ adminDomain: 'example.com', headerDomain: '', queryDomain: 'user1.example.com' }),
      ),
    ).toEqual({ valid: true, domain: 'user1.example.com' });
  });
});

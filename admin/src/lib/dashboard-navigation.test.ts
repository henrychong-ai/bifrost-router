import { describe, it, expect } from 'vitest';
import { buildRecentActivityHref } from './dashboard-navigation';

/**
 * Recent Activity rows carry the event's own domain, path, and country. The
 * link has to land on the matching Analytics page with that context already
 * applied — an unfiltered page would drop the reader back into every event on
 * the deployment and make them re-derive the filter by hand.
 */
describe('buildRecentActivityHref', () => {
  it('routes each event type to its own analytics page', () => {
    const base = { domain: 'example.com', path: '/report', country: 'SG' };
    expect(buildRecentActivityHref({ ...base, type: 'click' }, 30, false)).toContain(
      '/analytics/redirects?',
    );
    expect(buildRecentActivityHref({ ...base, type: 'view' }, 30, false)).toContain(
      '/analytics/views?',
    );
    expect(buildRecentActivityHref({ ...base, type: 'download' }, 30, false)).toContain(
      '/analytics/downloads?',
    );
    expect(buildRecentActivityHref({ ...base, type: 'proxy' }, 30, false)).toContain(
      '/analytics/proxy?',
    );
  });

  it('carries the event context and the dashboard period into the query', () => {
    const href = buildRecentActivityHref(
      { type: 'click', domain: 'links.example.com', path: '/report', country: 'SG' },
      7,
      true,
    );
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('domain')).toBe('links.example.com');
    expect(params.get('days')).toBe('7');
    expect(params.get('country')).toBe('SG');
    expect(params.get('search')).toBe('/report');
    expect(params.get('includeMonitoring')).toBe('true');
  });

  it('omits an absent country rather than sending an empty filter', () => {
    const href = buildRecentActivityHref(
      { type: 'view', domain: 'example.com', path: '/', country: null },
      30,
      false,
    );
    expect(new URLSearchParams(href.split('?')[1]).get('country')).toBeNull();
  });
});

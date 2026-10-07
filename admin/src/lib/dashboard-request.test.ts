/**
 * The dashboard's own API requests (v1.39.0): the cross-site refusal the dev
 * server applies before its key-adding proxy (admin/dev-api-proxy.ts). nginx
 * applies the same three checks in the containers
 * (scripts/check-dashboard-security.test.mjs, and the container check).
 */
import { describe, expect, it } from 'vitest';
import {
  crossSiteRefusal,
  DASHBOARD_REQUEST_HEADER,
  DASHBOARD_REQUEST_VALUE,
} from './dashboard-request';

const HOST = 'localhost:3001';
const OWN = { 'x-bifrost-dashboard': '1', host: HOST };

describe('crossSiteRefusal', () => {
  it('passes the dashboard’s own requests', () => {
    expect(DASHBOARD_REQUEST_HEADER).toBe('X-Bifrost-Dashboard');
    expect(DASHBOARD_REQUEST_VALUE).toBe('1');
    // A GET: same-origin fetch metadata, no Origin
    expect(crossSiteRefusal({ ...OWN, 'sec-fetch-site': 'same-origin' })).toBeNull();
    // A POST: the browser adds its own Origin
    expect(
      crossSiteRefusal({ ...OWN, 'sec-fetch-site': 'same-origin', origin: `http://${HOST}` }),
    ).toBeNull();
    // Behind a TLS front door on the default port, any case
    expect(
      crossSiteRefusal({
        'x-bifrost-dashboard': '1',
        host: 'Dashboard.Example.com',
        origin: 'https://dashboard.example.com',
      }),
    ).toBeNull();
    // A browser without fetch metadata, and a non-browser client
    expect(crossSiteRefusal({ ...OWN, origin: `http://${HOST}` })).toBeNull();
    expect(crossSiteRefusal(OWN)).toBeNull();
  });

  it('refuses a request without the dashboard header, whatever else it carries', () => {
    for (const value of [undefined, '', '0', 'true', '1 ', ['1', '1']]) {
      const headers = { host: HOST, 'sec-fetch-site': 'same-origin', 'x-bifrost-dashboard': value };
      expect({ value, refusal: crossSiteRefusal(headers) }).toEqual({ value, refusal: 'header' });
    }
  });

  it('refuses a cross-site or cross-origin fetch, and a navigation', () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect({ site, refusal: crossSiteRefusal({ ...OWN, 'sec-fetch-site': site }) }).toEqual({
        site,
        refusal: 'site',
      });
    }
  });

  it('refuses an Origin that is not this host', () => {
    for (const origin of [
      'https://evil.example',
      `https://${HOST}.evil.example`,
      `https://evil.example/${HOST}`,
      'null',
      `http://${HOST}/`,
      `ftp://${HOST}`,
      `http://user@${HOST}`,
    ]) {
      expect({ origin, refusal: crossSiteRefusal({ ...OWN, origin }) }).toEqual({
        origin,
        refusal: 'origin',
      });
    }
    // No Host to compare with
    expect(crossSiteRefusal({ 'x-bifrost-dashboard': '1', origin: `http://${HOST}` })).toBe(
      'origin',
    );
  });
});

/**
 * Linked routes in the QR editor and the edit patch (v1.38.0): the editor
 * links a url code to a route on its own domain, and an edit sends only the
 * fields the user changed.
 */
import { type QRCode, QRDesignSchema } from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import {
  linkedRouteFromState,
  linkedRouteUrl,
  normalizeQrRoutePath,
  qrEditPatch,
  stateFromQr,
  submittedPayload,
  tagsFromState,
} from './qr-form-state';

const DOMAIN = 'links.example.com';

/** Saved under earlier limits: a 120-character description and 12 tags. */
const legacy: QRCode = {
  id: 'legacy-code',
  domain: DOMAIN,
  type: 'url',
  payload: { url: 'https://example.com/landing' },
  description: 'd'.repeat(120),
  tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`),
  design: QRDesignSchema.parse({}),
  createdAt: 1,
  updatedAt: 2,
  createdBy: 'test',
};

describe('normalizeQrRoutePath', () => {
  it.each([
    ['  Summer Sale ', '/summer-sale'],
    ['/Spring_Promo//2026/', '/spring-promo/2026'],
    ['a - b', '/a-b'],
    ['', ''],
    ['///', ''],
    ['/-/', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalizeQrRoutePath(input)).toBe(expected);
  });
});

describe('linkedRouteFromState', () => {
  const base = stateFromQr();

  it('links nothing for a static code, another type, or an unsupported domain', () => {
    expect(linkedRouteFromState(base, DOMAIN)).toBeUndefined();
    expect(
      linkedRouteFromState(
        {
          ...base,
          type: 'text',
          linkMode: 'existing',
          linkedRoute: { domain: DOMAIN, path: '/a' },
        },
        DOMAIN,
      ),
    ).toBeUndefined();
    expect(
      linkedRouteFromState({ ...base, linkMode: 'new', newRoutePath: '/a' }, 'unsupported.example'),
    ).toBeUndefined();
  });

  it('keeps an existing selection only on its own domain', () => {
    const state = {
      ...base,
      linkMode: 'existing' as const,
      linkedRoute: { domain: DOMAIN, path: '/a' },
    };
    expect(linkedRouteFromState(state, DOMAIN)).toEqual({ domain: DOMAIN, path: '/a' });
    expect(linkedRouteFromState(state, 'example.com')).toBeUndefined();
  });

  it('links a new route at its normalised path, or nothing while the path is empty', () => {
    expect(
      linkedRouteFromState({ ...base, linkMode: 'new', newRoutePath: 'Summer Sale' }, DOMAIN),
    ).toEqual({
      domain: DOMAIN,
      path: '/summer-sale',
    });
    expect(
      linkedRouteFromState({ ...base, linkMode: 'new', newRoutePath: ' ' }, DOMAIN),
    ).toBeUndefined();
  });

  it('encodes the short URL as the payload of a linked code', () => {
    const state = {
      ...base,
      url: 'https://example.com/other',
      linkMode: 'existing' as const,
      linkedRoute: { domain: DOMAIN, path: '/a' },
    };
    expect(linkedRouteUrl({ domain: DOMAIN, path: '/a' })).toBe(`https://${DOMAIN}/a`);
    expect(submittedPayload(state, DOMAIN)).toEqual({ url: `https://${DOMAIN}/a` });
    expect(submittedPayload({ ...state, linkMode: 'static' }, DOMAIN)).toEqual({
      url: 'https://example.com/other',
    });
  });

  it('reads tags from comma-separated text', () => {
    expect(tagsFromState({ ...base, tags: ' print, , web ,' })).toEqual(['print', 'web']);
  });
});

describe('qrEditPatch', () => {
  it('sends nothing for an unchanged form, even on a record over today’s limits', () => {
    expect(qrEditPatch(legacy, stateFromQr(legacy), DOMAIN)).toEqual({});
  });

  it('sends only the changed field, never an untouched over-limit one', () => {
    const state = stateFromQr(legacy);
    expect(qrEditPatch(legacy, { ...state, fg: '#112233' }, DOMAIN)).toEqual({
      design: { ...QRDesignSchema.parse({}), fg: '#112233' },
    });
    expect(qrEditPatch(legacy, { ...state, url: 'https://example.com/new' }, DOMAIN)).toEqual({
      payload: { url: 'https://example.com/new' },
    });
    expect(qrEditPatch(legacy, { ...state, tags: 'a, b' }, DOMAIN)).toEqual({ tags: ['a', 'b'] });
  });

  it('sends a cleared description as an empty string, and ignores surrounding spaces', () => {
    const state = stateFromQr(legacy);
    expect(qrEditPatch(legacy, { ...state, description: '' }, DOMAIN)).toEqual({ description: '' });
    expect(
      qrEditPatch(legacy, { ...state, description: ` ${legacy.description} ` }, DOMAIN),
    ).toEqual({});
  });

  it('sends a new link with its short URL, and null when the link is cleared', () => {
    const state = stateFromQr(legacy);
    expect(
      qrEditPatch(
        legacy,
        { ...state, linkMode: 'existing', linkedRoute: { domain: DOMAIN, path: '/a' } },
        DOMAIN,
      ),
    ).toEqual({
      payload: { url: `https://${DOMAIN}/a` },
      linkedRoute: { domain: DOMAIN, path: '/a' },
    });

    const linked: QRCode = {
      ...legacy,
      payload: { url: `https://${DOMAIN}/a` },
      linkedRoute: { domain: DOMAIN, path: '/a' },
    };
    expect(qrEditPatch(linked, stateFromQr(linked), DOMAIN)).toEqual({});
    expect(qrEditPatch(linked, { ...stateFromQr(linked), linkMode: 'static' }, DOMAIN)).toEqual({
      linkedRoute: null,
    });
  });

  it('clears a stored link on another domain, which the editor cannot show as selected', () => {
    const foreign: QRCode = { ...legacy, linkedRoute: { domain: 'retired.example', path: '/a' } };
    expect(qrEditPatch(foreign, { ...stateFromQr(foreign), linkMode: 'static' }, DOMAIN)).toEqual({
      linkedRoute: null,
    });
  });

  it('a link that cannot be shown (unavailable route, or one on another domain) switched to static sends null', () => {
    // Absent and null are told apart: the stored link is present, the
    // final one absent, so the change is sent as linkedRoute: null
    for (const linkedRoute of [
      { domain: DOMAIN, path: '/deleted-route' },
      { domain: 'retired.example', path: '/a' },
    ]) {
      const code: QRCode = {
        ...legacy,
        payload: { url: `https://${linkedRoute.domain}${linkedRoute.path}` },
        linkedRoute,
      };
      const patch = qrEditPatch(code, { ...stateFromQr(code), linkMode: 'static' }, DOMAIN);
      expect(patch).toHaveProperty('linkedRoute', null);
    }
    // A code with no link stays unchanged: an absent link is never sent as null
    expect(qrEditPatch(legacy, stateFromQr(legacy), DOMAIN)).not.toHaveProperty('linkedRoute');
  });

  it('never sends a link for a code of another type', () => {
    const text: QRCode = { ...legacy, type: 'text', payload: { text: 'hello' } };
    expect(qrEditPatch(text, { ...stateFromQr(text), text: 'bye' }, DOMAIN)).toEqual({
      payload: { text: 'bye' },
    });
  });
});

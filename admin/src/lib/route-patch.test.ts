/**
 * The route edit dialog sends only what changed (v1.38.0): an untouched field
 * written under older limits is never re-sent, a field the stored route lacks
 * compares as the router's default, and clearing a stored text field sends ''.
 */
import { MAX_ROUTE_TARGET_LENGTH } from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import { routeEditPatch } from './route-patch';
import type { Route, UpdateRouteInput } from './schemas';

const legacy: Route = {
  path: '/legacy',
  type: 'redirect',
  // Written before the target cap: longer than any write accepts today
  target: `https://example.com/?q=${'x'.repeat(MAX_ROUTE_TARGET_LENGTH)}`,
  statusCode: 302,
  preserveQuery: true,
  preservePath: false,
  enabled: true,
  domain: 'links.example.com',
  createdAt: 1,
  updatedAt: 1,
};

/** What the edit form submits for a redirect route when nothing is changed. */
const untouched = (route: Route): UpdateRouteInput => ({
  type: route.type,
  target: route.target,
  statusCode: route.statusCode ?? 302,
  preserveQuery: route.preserveQuery ?? true,
  preservePath: route.preservePath ?? false,
  cacheControl: route.cacheControl || undefined,
  hostHeader: undefined,
  forceDownload: undefined,
  bucket: undefined,
  enabled: route.enabled ?? true,
});

/** What the edit form submits for an r2 route stored without forceDownload or bucket. */
const r2Form = (patch: Partial<UpdateRouteInput> = {}): UpdateRouteInput => ({
  type: 'r2',
  target: 'docs/brochure.pdf',
  preserveQuery: true,
  preservePath: false,
  // The form keeps "unset" for a route stored without forceDownload
  forceDownload: undefined,
  // The edit form defaults to the stored bucket, else the router default
  bucket: 'files',
  enabled: true,
  ...patch,
});

describe('routeEditPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(routeEditPatch(legacy, untouched(legacy))).toEqual({});
  });

  it('sends only the changed field, never an untouched over-cap target', () => {
    expect(routeEditPatch(legacy, { ...untouched(legacy), statusCode: 301 })).toEqual({
      statusCode: 301,
    });
    expect(routeEditPatch(legacy, { ...untouched(legacy), enabled: false })).toEqual({
      enabled: false,
    });
  });

  it('sends a changed target', () => {
    expect(
      routeEditPatch(legacy, { ...untouched(legacy), target: 'https://example.com/short' }),
    ).toEqual({ target: 'https://example.com/short' });
  });

  it('compares a field the route lacks with the router default for it', () => {
    const bare: Route = {
      path: '/bare',
      type: 'redirect',
      target: 'https://example.com/',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(routeEditPatch(bare, untouched(bare))).toEqual({});
    expect(
      routeEditPatch(bare, { ...untouched(bare), preserveQuery: false, enabled: false }),
    ).toEqual({
      preserveQuery: false,
      enabled: false,
    });
  });

  describe('R2 routes stored without forceDownload or bucket', () => {
    const file: Route = {
      path: '/brochure',
      type: 'r2',
      target: 'docs/brochure.pdf',
      createdAt: 1,
      updatedAt: 1,
    };

    it('sends nothing for an unchanged save', () => {
      expect(routeEditPatch(file, r2Form())).toEqual({});
    });

    it('sends an explicit forceDownload, false included (absent means "by content type")', () => {
      expect(routeEditPatch(file, r2Form({ forceDownload: false }))).toEqual({
        forceDownload: false,
      });
      expect(routeEditPatch(file, r2Form({ forceDownload: true }))).toEqual({
        forceDownload: true,
      });
    });

    it('treats a missing bucket as the default bucket, and sends another one', () => {
      expect(routeEditPatch(file, r2Form({ bucket: 'assets' }))).toEqual({ bucket: 'assets' });
      expect(routeEditPatch({ ...file, bucket: 'assets' }, r2Form({ bucket: 'files' }))).toEqual({
        bucket: 'files',
      });
    });
  });

  it('sends an empty string when a stored Cache-Control or Host header is cleared', () => {
    const proxied: Route = {
      ...legacy,
      type: 'proxy',
      target: 'https://origin.example.com/',
      cacheControl: 'max-age=60',
      hostHeader: 'origin.example.com',
    };
    const form: UpdateRouteInput = {
      type: 'proxy',
      target: proxied.target,
      preserveQuery: true,
      preservePath: false,
      cacheControl: 'max-age=60',
      hostHeader: 'origin.example.com',
      enabled: true,
    };
    expect(routeEditPatch(proxied, form)).toEqual({});
    expect(routeEditPatch(proxied, { ...form, cacheControl: '', hostHeader: '' })).toEqual({
      cacheControl: '',
      hostHeader: '',
    });
    // Nothing stored and nothing typed: nothing sent
    expect(
      routeEditPatch({ ...proxied, cacheControl: undefined }, { ...form, cacheControl: '' }),
    ).toEqual({});
  });

  it('sends a type switch with the new type fields; undefined fields stay unsent', () => {
    expect(
      routeEditPatch(legacy, {
        type: 'proxy',
        target: legacy.target,
        statusCode: undefined,
        preserveQuery: true,
        hostHeader: 'origin.example.com',
        enabled: true,
      }),
    ).toEqual({ type: 'proxy', hostHeader: 'origin.example.com' });
  });
});

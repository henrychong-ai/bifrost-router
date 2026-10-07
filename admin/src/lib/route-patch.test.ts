/**
 * The route edit dialog sends only DIRTY fields (v1.38.0): each final form
 * value is compared with the value the form showed when the dialog opened,
 * never with the stored record and copied server defaults. An untouched field
 * written under older limits is never re-sent, a switch toggled on and off is
 * not dirty, clearing a field that showed a value sends '', and a type change
 * sends every field the new type uses.
 */
import { MAX_ROUTE_TARGET_LENGTH } from '@bifrost/shared';
import { describe, expect, it } from 'vitest';
import {
  type RouteFormValues,
  routeEditPatch,
  routeFormValues,
  routeTargetProblem,
  toUpdateRouteInput,
  unappliedPatchFields,
  unsupportedPatchFields,
} from './route-patch';
import type { Route } from './schemas';

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

/** The dialog opened on `route`, then `edit` applied by the user. */
const edited = (route: Route, edit: Partial<RouteFormValues> = {}) => {
  const opened = routeFormValues(route);
  return routeEditPatch(opened, { ...opened, ...edit });
};

describe('routeEditPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(edited(legacy)).toEqual({});
  });

  it('sends only the changed field, never an untouched over-cap target', () => {
    expect(edited(legacy, { statusCode: 301 })).toEqual({ statusCode: 301 });
    expect(edited(legacy, { enabled: false })).toEqual({ enabled: false });
    expect(edited(legacy, { cacheControl: 'no-store' })).toEqual({ cacheControl: 'no-store' });
  });

  it('sends a changed target', () => {
    expect(edited(legacy, { target: 'https://example.com/short' })).toEqual({
      target: 'https://example.com/short',
    });
  });

  it('never sends a field the stored route lacks unless the user changes it', () => {
    const bare: Route = { path: '/bare', type: 'redirect', target: 'https://example.com/' };
    expect(edited(bare)).toEqual({});
    expect(edited(bare, { preserveQuery: false, enabled: false })).toEqual({
      preserveQuery: false,
      enabled: false,
    });
  });

  it('shows a status code or bucket no write accepts as it is: unchanged, never sent', () => {
    const older: Route = {
      path: '/older',
      type: 'redirect',
      target: 'https://example.com/',
      statusCode: 303,
    };
    expect(routeFormValues(older).statusCode).toBe(303);
    expect(edited(older)).toEqual({});
    expect(edited(older, { enabled: false })).toEqual({ enabled: false });
    const file: Route = { path: '/f', type: 'r2', target: 'a.pdf', bucket: 'retired-bucket' };
    expect(routeFormValues(file).bucket).toBe('retired-bucket');
    expect(edited(file)).toEqual({});
  });

  it('choosing the supported default over an unsupported stored value IS a change, and is sent', () => {
    const older: Route = {
      path: '/older',
      type: 'redirect',
      target: 'https://example.com/',
      statusCode: 303,
    };
    expect(edited(older, { statusCode: 302 })).toEqual({ statusCode: 302 });
    const file: Route = { path: '/f', type: 'r2', target: 'a.pdf', bucket: 'retired-bucket' };
    expect(edited(file, { bucket: 'files' })).toEqual({ bucket: 'files' });
  });

  it('an unsupported value the patch would send is named, and never becomes an update', () => {
    // A proxy stored with an old status code, converted to a redirect: the
    // type change sends the status code the form shows
    const proxy: Route = {
      path: '/p',
      type: 'proxy',
      target: 'https://example.com/',
      statusCode: 303,
    };
    const patch = edited(proxy, { type: 'redirect' });
    expect(patch).toMatchObject({ type: 'redirect', statusCode: 303 });
    expect(unsupportedPatchFields(patch)).toEqual(['statusCode']);
    expect(toUpdateRouteInput(patch)).toBeNull();
    expect(unsupportedPatchFields({ bucket: 'retired-bucket' })).toEqual(['bucket']);
    expect(toUpdateRouteInput({ bucket: 'retired-bucket' })).toBeNull();
    expect(toUpdateRouteInput({ statusCode: 301, bucket: 'assets', enabled: false })).toEqual({
      statusCode: 301,
      bucket: 'assets',
      enabled: false,
    });
  });

  describe('R2 routes stored without forceDownload or bucket', () => {
    const file: Route = { path: '/brochure', type: 'r2', target: 'docs/brochure.pdf' };

    it('sends nothing for an unchanged save: an unset Force Download stays unset', () => {
      expect(edited(file)).toEqual({});
    });

    it('a Force Download switched on and off again is not dirty', () => {
      const opened = routeFormValues(file);
      const on = { ...opened, forceDownload: true };
      expect(routeEditPatch(opened, on)).toEqual({ forceDownload: true });
      expect(routeEditPatch(opened, { ...on, forceDownload: false })).toEqual({});
    });

    it('shows a missing bucket as the default bucket, and sends another one', () => {
      expect(edited(file, { bucket: 'assets' })).toEqual({ bucket: 'assets' });
      expect(edited({ ...file, bucket: 'assets' }, { bucket: 'files' })).toEqual({
        bucket: 'files',
      });
    });
  });

  it('sends an empty string when a shown Cache-Control or Host header is cleared', () => {
    const proxied: Route = {
      ...legacy,
      type: 'proxy',
      target: 'https://origin.example.com/',
      cacheControl: 'max-age=60',
      hostHeader: 'origin.example.com',
    };
    expect(edited(proxied)).toEqual({});
    expect(edited(proxied, { cacheControl: '', hostHeader: '' })).toEqual({
      cacheControl: '',
      hostHeader: '',
    });
    // Nothing shown and nothing typed: nothing sent
    expect(edited({ ...proxied, cacheControl: undefined }, { cacheControl: '' })).toEqual({});
  });

  it('a type change sends every field the new type uses, and none it does not', () => {
    expect(edited(legacy, { type: 'proxy', hostHeader: 'origin.example.com' })).toEqual({
      type: 'proxy',
      target: legacy.target,
      preserveQuery: true,
      hostHeader: 'origin.example.com',
    });
  });

  it('a redirect or proxy converted to R2 sends the bucket and Force Download explicitly', () => {
    for (const type of ['redirect', 'proxy'] as const) {
      const route: Route = { path: '/doc', type, target: 'https://example.com/' };
      expect(edited(route, { type: 'r2', target: 'docs/a.pdf' })).toEqual({
        type: 'r2',
        target: 'docs/a.pdf',
        bucket: 'files',
        forceDownload: false,
      });
    }
  });
});

describe('routeTargetProblem: the target checked for the type it will serve (v1.38.0)', () => {
  it('a redirect needs an absolute URL, a mailto or tel link included', () => {
    for (const target of ['https://example.com/', 'mailto:team@example.com', 'tel:+15550100']) {
      expect(routeTargetProblem('redirect', target)).toBeNull();
    }
    expect(routeTargetProblem('redirect', 'docs/a.pdf')).toMatch(/absolute target URL/);
  });

  it('a proxy needs an absolute http(s) URL', () => {
    expect(routeTargetProblem('proxy', 'https://origin.example.com/')).toBeNull();
    expect(routeTargetProblem('proxy', 'mailto:team@example.com')).toMatch(/http or https/);
    expect(routeTargetProblem('proxy', 'docs/a.pdf')).toMatch(/absolute target URL/);
  });

  it('an r2 route needs an object key the Worker serves as it is, never a URL', () => {
    expect(routeTargetProblem('r2', 'docs/a.pdf')).toBeNull();
    for (const target of ['https://example.com/a.pdf', '/docs/a.pdf', '', 'a/../b']) {
      expect(routeTargetProblem('r2', target)).toMatch(/R2 object key/);
    }
  });
});

describe('unappliedPatchFields: a migrate answer that ignored the patch (v1.38.0)', () => {
  const moved: Route = {
    path: '/b',
    type: 'redirect',
    target: 'https://example.com/',
    statusCode: 302,
  };
  it('names the fields the moved route does not show', () => {
    expect(unappliedPatchFields({ statusCode: 301, cacheControl: 'no-store' }, moved)).toEqual([
      'statusCode',
      'cacheControl',
    ]);
  });
  it('counts an applied patch, and a cleared field the route no longer holds, as applied', () => {
    expect(unappliedPatchFields({ statusCode: 302, cacheControl: '' }, moved)).toEqual([]);
    expect(unappliedPatchFields({ cacheControl: '' }, { ...moved, cacheControl: '' })).toEqual([]);
  });
});

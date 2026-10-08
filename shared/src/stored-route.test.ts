import { describe, expect, it } from 'vitest';
import { RouteSchema } from './schemas.js';
import {
  DEFAULT_ROUTE_BUCKET,
  InvalidRouteRowSchema,
  isInvalidRouteRow,
  isStoredRoute,
  parseStoredRoute,
  r2ObjectId,
  routeR2ObjectId,
  STORED_ROUTE_FIELDS,
  STORED_ROUTE_REQUIRED,
  StoredRouteSchema,
} from './stored-route.js';

describe('stored routes: one tolerant read shape for the Worker and the dashboard (v1.38.0)', () => {
  it('classifies every RouteSchema field, and nothing else', () => {
    const classified = [
      'type',
      ...STORED_ROUTE_REQUIRED,
      ...Object.values(STORED_ROUTE_FIELDS).flat(),
    ].toSorted();
    expect(classified).toEqual(Object.keys(RouteSchema.shape).toSorted());
  });

  it('reads an older record no write accepts today, null optionals dropped', () => {
    const legacy = {
      path: '/legacy',
      type: 'redirect',
      target: 'https://example.com/',
      statusCode: 303,
      bucket: 'retired-bucket',
      cacheControl: null,
      enabled: null,
      extra: 'kept',
    };
    expect(isStoredRoute(legacy)).toBe(true);
    expect(parseStoredRoute(legacy)).toEqual({
      path: '/legacy',
      type: 'redirect',
      target: 'https://example.com/',
      statusCode: 303,
      bucket: 'retired-bucket',
      extra: 'kept',
    });
    expect(StoredRouteSchema.parse(legacy)).toMatchObject({ statusCode: 303 });
    // No timestamps at all
    expect(parseStoredRoute({ path: '/a', type: 'r2', target: 'a.pdf' })).toEqual({
      path: '/a',
      type: 'r2',
      target: 'a.pdf',
    });
  });

  it.each([
    ['null', null],
    ['an unknown type', { path: '/a', type: 'script', target: 'x' }],
    ['a missing target', { path: '/a', type: 'redirect' }],
    ['a string status code', { path: '/a', type: 'redirect', target: 'x', statusCode: '301' }],
  ])('refuses %s with one fixed message', (_label, value) => {
    expect(parseStoredRoute(value)).toBeNull();
    const result = StoredRouteSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Not a route record');
  });

  it('recognises a listing row for an unreadable record', () => {
    const row = { domain: 'links.example.com', path: '/bad', invalid: true };
    expect(isInvalidRouteRow(row)).toBe(true);
    expect(InvalidRouteRowSchema.parse(row)).toEqual(row);
    expect(isInvalidRouteRow({ ...row, invalid: 'yes' })).toBe(false);
    expect(isInvalidRouteRow({ path: '/a', type: 'redirect', target: 'x' })).toBe(false);
  });

  it('a readable record that holds an `invalid` field stays a route, never an unreadable row', () => {
    const route = {
      domain: 'links.example.com',
      path: '/promo',
      type: 'redirect',
      target: 'https://example.com/',
      invalid: true,
    };
    expect(isStoredRoute(route)).toBe(true);
    expect(isInvalidRouteRow(route)).toBe(false);
    expect(InvalidRouteRowSchema.safeParse(route).success).toBe(false);
    // The extra field is kept, as the Worker sends it
    expect(StoredRouteSchema.parse(route)).toMatchObject({ invalid: true, type: 'redirect' });
  });
});

describe('routeR2ObjectId (v1.41.1)', () => {
  it('names the object an r2 route serves, its bucket defaulting to files', () => {
    expect(routeR2ObjectId({ type: 'r2', target: 'a.pdf' })).toBe(r2ObjectId('files', 'a.pdf'));
    expect(routeR2ObjectId({ type: 'r2', target: 'a.pdf', bucket: '' })).toBe(
      r2ObjectId(DEFAULT_ROUTE_BUCKET, 'a.pdf'),
    );
    expect(routeR2ObjectId({ type: 'r2', target: 'a.pdf', bucket: 'assets' })).toBe(
      r2ObjectId('assets', 'a.pdf'),
    );
    expect(routeR2ObjectId({ type: 'r2', target: 'a.pdf', bucket: 'assets' })).not.toBe(
      r2ObjectId('files', 'a.pdf'),
    );
  });

  it('names none for a redirect or proxy route', () => {
    expect(routeR2ObjectId({ type: 'redirect', target: 'a.pdf' })).toBeUndefined();
    expect(routeR2ObjectId({ type: 'proxy', target: 'https://a.example/' })).toBeUndefined();
  });

  it('keeps bucket and key apart (no separator collision)', () => {
    expect(r2ObjectId('a', 'b/c')).not.toBe(r2ObjectId('a/b', 'c'));
  });
});

/**
 * The dashboard's build target (Vite's default browser baseline) includes
 * browsers without ES2023's change-array-by-copy methods (`toSorted`,
 * `toReversed`, `toSpliced`, `with`), which a bundler does not polyfill. These
 * tests run the dashboard's list and patch helpers, and the shared code they
 * call, with those methods removed from the prototype.
 */
import {
  parseStoredQR,
  parseStoredRoute,
  type QRCode,
  QRDesignSchema,
  qrMatchesListFilters,
  searchAndRankRoutes,
} from '@bifrost/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qrEditPatch, stateFromQr } from './qr-form-state';
import { createPendingQrStore } from './qr-pending';
import { routeEditPatch, routeFormValues } from './route-patch';

const METHODS = ['toSorted', 'toReversed', 'toSpliced', 'with'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const name of METHODS) {
    saved.set(name, Object.getOwnPropertyDescriptor(Array.prototype, name));
    Reflect.deleteProperty(Array.prototype, name);
  }
});

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Reflect.defineProperty(Array.prototype, name, descriptor);
  }
});

const qr = (id: string, updatedAt: number): QRCode => ({
  id,
  domain: 'example.com',
  type: 'url',
  payload: { url: `https://example.com/${id}` },
  design: QRDesignSchema.parse({}),
  createdAt: updatedAt,
  updatedAt,
  createdBy: 'test',
});

describe('without ES2023 array copies', () => {
  it('the methods are really gone in this suite', () => {
    expect('toSorted' in Array.prototype).toBe(false);
  });

  it('the QR store projects, sorts and tombstones a page', () => {
    const store = createPendingQrStore(() => 1_000);
    store.remember(qr('new', 50));
    store.markDeleted('example.com', 'gone', 10);
    const page = store.project(
      { domain: 'example.com', offset: 0, limit: 50 },
      {
        items: [qr('old', 20), qr('gone', 10)],
        meta: { total: 2, count: 2, offset: 0, limit: 50, hasMore: false },
      },
    );
    expect(page.items.map(item => item.id)).toEqual(['new', 'old']);
  });

  it('the route and QR edit patches, the matchers and the stored readers run', () => {
    const route = { path: '/a', type: 'redirect' as const, target: 'https://example.com/' };
    const opened = routeFormValues(route);
    expect(routeEditPatch(opened, { ...opened, type: 'r2', target: 'a.pdf' })).toMatchObject({
      type: 'r2',
      forceDownload: false,
    });
    const code = qr('code', 1);
    expect(qrEditPatch(code, { ...stateFromQr(code), tags: 'a, b' }, 'example.com')).toEqual({
      tags: ['a', 'b'],
    });
    expect(
      searchAndRankRoutes([route, { ...route, path: '/b-sale' }], 'sale').map(r => r.path),
    ).toEqual(['/b-sale']);
    expect(qrMatchesListFilters(code, { search: 'code' })).toBe(true);
    expect(parseStoredQR(JSON.parse(JSON.stringify(code)))).toEqual(code);
    expect(parseStoredRoute(route)).toEqual(route);
  });
});

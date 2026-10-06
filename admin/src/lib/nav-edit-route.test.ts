/**
 * The Routes page's navigation hand-off (v1.38.0): `location.state` is read as
 * unknown and its `editRoute` validated, so a stale or foreign history entry
 * never opens the edit dialog on something that is not a route.
 */
import { describe, expect, it } from 'vitest';
import { navEditRoute } from './navigation-state';

const route = {
  path: '/a',
  type: 'redirect',
  target: 'https://example.com',
  createdAt: 1,
  updatedAt: 2,
  domain: 'links.example.com',
};

describe('navEditRoute', () => {
  it('returns a valid route, domain kept', () => {
    expect(navEditRoute({ editRoute: route })).toEqual(route);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'editRoute'],
    ['state without editRoute', { open: true }],
    ['an editRoute that is not a route', { editRoute: { path: '/a' } }],
    ['an editRoute of the wrong type', { editRoute: { ...route, type: 'script' } }],
  ])('returns undefined for %s', (_label, state) => {
    expect(navEditRoute(state)).toBeUndefined();
  });
});

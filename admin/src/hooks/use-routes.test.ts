import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://api.example.test' },
}));

// `vi.mock` is hoisted above every top-level binding, so the spies are created
// inside the factory and read back from the mocked module afterwards.
vi.mock('@/lib/api-client', () => ({
  api: {
    routes: {
      create: vi.fn<typeof api.routes.create>(),
      get: vi.fn<typeof api.routes.get>(),
    },
  },
}));

import { api } from '@/lib/api-client';
import { ApiError, isNotFoundError, RouteExistsError } from '@/lib/api-error';
import { keyOfInput, keyOfStored, pendingRoutes } from '@/lib/route-pending';
import type { CreateRouteInput, Route } from '@/lib/schemas';
import { createRouteMutationOptions } from './use-routes';

const create = vi.mocked(api.routes.create);
const get = vi.mocked(api.routes.get);

afterEach(() => {
  vi.clearAllMocks();
  pendingRoutes.clear();
});

const sent: CreateRouteInput = {
  path: '/autumn',
  type: 'redirect',
  target: 'https://example.net/autumn',
  statusCode: 302,
  preserveQuery: true,
};

const storedRoute = (overrides: Partial<Route> = {}): Route => ({
  ...sent,
  enabled: true,
  preservePath: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const exists = () => new ApiError(409, 'Route already exists: /autumn');

function run(variables: { afterUncertainAnswer?: boolean }) {
  const client = new QueryClient();
  return new MutationObserver(client, createRouteMutationOptions(client)).mutate({
    data: sent,
    domain: 'example.com',
    ...variables,
  });
}

/**
 * A route create retried after an uncertain answer (v1.38.0): a 409 "Route
 * already exists" for the same path is the earlier create when the stored
 * route holds every value sent; otherwise the route exists with other values.
 */
describe('a route create retried after an uncertain answer', () => {
  it('takes the existing route as its own when every sent value matches', async () => {
    create.mockRejectedValueOnce(exists());
    get.mockResolvedValueOnce(storedRoute());
    expect(await run({ afterUncertainAnswer: true })).toEqual({
      route: storedRoute(),
      readBack: true,
    });
    expect(get).toHaveBeenCalledWith('/autumn', 'example.com');
  });

  it.each([
    ['the target', { target: 'https://example.net/other' }],
    ['the status code', { statusCode: 301 as const }],
    ['the query setting', { preserveQuery: false }],
    ['the type', { type: 'proxy' as const }],
  ])('refuses with the existing route when %s differs', async (_label, change) => {
    create.mockRejectedValueOnce(exists());
    const other = storedRoute(change);
    get.mockResolvedValueOnce(other);
    const failure = await run({ afterUncertainAnswer: true }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RouteExistsError);
    expect((failure as RouteExistsError).route).toEqual(other);
    expect((failure as RouteExistsError).status).toBe(409);
  });

  it('never reads back after a certain answer: the 409 stands', async () => {
    create.mockRejectedValueOnce(exists());
    await expect(run({})).rejects.toMatchObject({ status: 409 });
    expect(get).not.toHaveBeenCalled();
  });

  it('passes any other refusal on unchanged', async () => {
    const coded = new ApiError(409, 'unreadable', undefined, { code: 'ROUTE_RECORD_INVALID' });
    create.mockRejectedValueOnce(coded);
    await expect(run({ afterUncertainAnswer: true })).rejects.toBe(coded);
    expect(get).not.toHaveBeenCalled();
  });
});

/**
 * v1.41.1: a route create holds its route in the pending-route store for its
 * flight and records its answer there (the listings show it once a refetch
 * lists it); a failed create records nothing and frees the route.
 */
describe('a route create and the pending-route store', () => {
  it('records the created route, the earlier create’s included, and frees the route', async () => {
    create.mockResolvedValueOnce(storedRoute());
    expect(await run({})).toEqual({ route: storedRoute(), readBack: false });
    expect(pendingRoutes.generation(keyOfInput('example.com', '/autumn'))).toBe(1);
    pendingRoutes.clear();
    create.mockRejectedValueOnce(exists());
    get.mockResolvedValueOnce(storedRoute({ updatedAt: 2 }));
    await run({ afterUncertainAnswer: true });
    expect(pendingRoutes.answerAt(keyOfStored('example.com', '/autumn'))).toEqual({
      state: 'live',
      route: { ...storedRoute({ updatedAt: 2 }), domain: 'example.com' },
    });
    expect(pendingRoutes.isPending(keyOfInput('example.com', '/autumn'))).toBe(false);
  });

  // v1.41.1 review: the read back may lag; this session's own answer at the
  // route (a disable answered v2 since) is never overwritten by it
  it('a route read back after an uncertain answer never overwrites an own answer', async () => {
    const disabled = { ...storedRoute({ enabled: false, updatedAt: 2 }), domain: 'example.com' };
    pendingRoutes.observe(disabled);
    create.mockRejectedValueOnce(exists());
    get.mockResolvedValueOnce(storedRoute({ updatedAt: 1 }));
    expect(await run({ afterUncertainAnswer: true })).toMatchObject({
      route: { updatedAt: 1 },
      readBack: true,
    });
    expect(pendingRoutes.answerAt(keyOfStored('example.com', '/autumn'))).toEqual({
      state: 'live',
      route: disabled,
    });
    // A gone entry wins too
    pendingRoutes.markGone(keyOfInput('example.com', '/autumn'));
    create.mockRejectedValueOnce(exists());
    get.mockResolvedValueOnce(storedRoute({ updatedAt: 1 }));
    await run({ afterUncertainAnswer: true });
    expect(pendingRoutes.answerAt(keyOfStored('example.com', '/autumn'))).toEqual({
      state: 'gone',
    });
  });

  it('a failed create records nothing and frees the route', async () => {
    create.mockRejectedValueOnce(exists());
    await expect(run({})).rejects.toMatchObject({ status: 409 });
    expect(pendingRoutes.generation(keyOfInput('example.com', '/autumn'))).toBe(0);
    expect(pendingRoutes.isPending(keyOfInput('example.com', '/autumn'))).toBe(false);
  });
});

/**
 * v1.41.1: a route write answered 404 only refetches (the Worker's "Route not
 * found" is a bare text with no code, and an unknown endpoint or a proxy
 * answers 404 too), so any 404 is one, and nothing else is.
 */
describe('isNotFoundError', () => {
  // v1.41.1 review: it narrows to a 404 ApiError, so a `false` answer never
  // narrows an ApiError away (with `error is ApiError` this branch was
  // `never`, and reading `status` failed to compile)
  it('a false answer leaves an ApiError an ApiError', () => {
    const error: unknown = new ApiError(409, 'Route already exists: /promo');
    if (!(error instanceof ApiError) || isNotFoundError(error)) throw new Error('unexpected');
    const status: number = error.status;
    expect(status).toBe(409);
  });

  it('is any 404 ApiError, coded or not, and nothing else', () => {
    expect(isNotFoundError(new ApiError(404, 'Route not found: /promo'))).toBe(true);
    expect(isNotFoundError(new ApiError(404, 'x', undefined, { code: 'QR_NOT_FOUND' }))).toBe(true);
    for (const other of [
      new ApiError(409, 'Route already exists: /promo'),
      new ApiError(400, 'Not found'),
      new Error('Route not found: /promo'),
      { status: 404 },
    ]) {
      expect(isNotFoundError(other)).toBe(false);
    }
  });
});

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
import { ApiError, RouteExistsError } from '@/lib/api-error';
import type { CreateRouteInput, Route } from '@/lib/schemas';
import { createRouteMutationOptions } from './use-routes';

const create = vi.mocked(api.routes.create);
const get = vi.mocked(api.routes.get);

afterEach(() => {
  vi.clearAllMocks();
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
    expect(await run({ afterUncertainAnswer: true })).toMatchObject({ path: '/autumn' });
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

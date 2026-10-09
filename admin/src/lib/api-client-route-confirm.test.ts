/**
 * A route write the server answered 2xx without confirming it (v1.41.2): a
 * 2xx is not a refusal, so the write may have landed, and its error must
 * never read as a 4xx. v1.41.1 threw a synthetic 400 for a create, update,
 * migration or transfer, and took a delete's `success: false` as a delete.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routesApi } from './api-client';
import { ApiError, isUncertainAnswer, UNCONFIRMED_ANSWER_STATUS } from './api-error';

vi.mock('@/env', () => ({
  env: { API_ORIGIN: 'https://dashboard.example.com' },
}));

/** Answer each fetch in turn with one of `bodies`, as JSON with `status`. */
function answers(...bodies: Array<[number, unknown]>) {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  for (const [status, body] of bodies) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }
}

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('a route write answered 2xx without a route is uncertain', () => {
  afterEach(() => vi.restoreAllMocks());

  it('create, update, migrate and transfer throw an unconfirmed ApiError', async () => {
    answers(
      [200, { success: false, error: 'Something odd' }],
      [200, { success: false }],
      [200, { success: true }],
      [201, { success: false }],
    );
    const failures = [
      await failureOf(
        routesApi.create(
          { path: '/a', type: 'redirect', target: 'https://example.com/' },
          'example.com',
        ),
      ),
      await failureOf(routesApi.update('/a', { enabled: false }, 'example.com')),
      await failureOf(routesApi.migrate('/a', '/b', 'example.com')),
      await failureOf(routesApi.transfer('/a', 'example.com', 'links.example.com')),
    ];
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: UNCONFIRMED_ANSWER_STATUS });
      expect(isUncertainAnswer(failure)).toBe(true);
    }
    expect((failures[0] as ApiError).message).toBe('Something odd');
    expect((failures[1] as ApiError).message).toBe('Failed to update route');
  });

  it('a delete and a recovery delete answered 200 { success: false } are unconfirmed', async () => {
    answers(
      [200, { success: false, error: 'Delete not confirmed' }],
      [200, { success: false }],
      [200, { success: true }],
    );
    const deleted = await failureOf(routesApi.delete('/a', 'example.com'));
    const recovered = await failureOf(
      routesApi.delete('/a', 'example.com', { recoverInvalid: true }),
    );
    for (const failure of [deleted, recovered]) {
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toMatchObject({ status: UNCONFIRMED_ANSWER_STATUS });
      expect(isUncertainAnswer(failure)).toBe(true);
    }
    expect((deleted as ApiError).message).toBe('Delete not confirmed');
    expect((recovered as ApiError).message).toBe('Failed to delete the unreadable record');
    await expect(routesApi.delete('/a', 'example.com')).resolves.toBeUndefined();
  });

  it('a refusal is still the server’s 4xx, definite', async () => {
    answers([409, { success: false, error: 'Route already exists: /a' }]);
    const failure = await failureOf(
      routesApi.create(
        { path: '/a', type: 'redirect', target: 'https://example.com/' },
        'example.com',
      ),
    );
    expect(failure).toMatchObject({ status: 409 });
    expect(isUncertainAnswer(failure)).toBe(false);
  });
});

/**
 * The Routes page's failed-write toasts (v1.41.2): a write that may have
 * landed is never reported as failed.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, UNCONFIRMED_ANSWER_STATUS } from './api-error';
import { RouteWritePendingError } from './route-pending';
import { requireWriteDomain } from './route-write-domain';
import { routeWriteFailureText } from './route-write-outcome';

const UNCERTAIN =
  'Could not confirm the migration: it may have gone through. The list is reloading.';

describe('routeWriteFailureText', () => {
  it('says a write with no definite answer could not be confirmed', () => {
    for (const error of [
      new ApiError(502, 'Bad Gateway'),
      new ApiError(UNCONFIRMED_ANSWER_STATUS, 'Failed to migrate route'),
      new TypeError('Failed to fetch'),
      new SyntaxError('Unexpected end of JSON input'),
      'thrown string',
    ]) {
      expect(routeWriteFailureText(error, 'migration', 'Failed to migrate route')).toBe(UNCERTAIN);
    }
  });

  it('keeps the definite text and reason for a refusal', () => {
    let domainError: unknown;
    try {
      requireWriteDomain(undefined, undefined);
    } catch (error) {
      domainError = error;
    }
    expect(
      routeWriteFailureText(
        new ApiError(400, 'Validation failed'),
        'migration',
        'Failed to migrate route',
      ),
    ).toBe('Failed to migrate route: Validation failed');
    expect(
      routeWriteFailureText(new RouteWritePendingError(), 'delete', 'Failed to delete route'),
    ).toBe('Failed to delete route: Another change to this route is still saving');
    expect(routeWriteFailureText(domainError, 'update', 'Failed to update route')).toBe(
      'Failed to update route: This route has no domain. Select its domain and try again.',
    );
  });
});

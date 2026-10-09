/**
 * The one predicate the route writes, the Routes page and the QR page share
 * for "the write may have landed" (v1.41.2), and the one marker for a write
 * refused before any request.
 */
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  isUncertainAnswer,
  RouteExistsError,
  RouteWriteRefusedError,
  UNCONFIRMED_ANSWER_STATUS,
} from './api-error';
import { RouteWritePendingError } from './route-pending';
import { RouteWriteDomainError } from './route-write-domain';

describe('isUncertainAnswer', () => {
  it('only a 4xx ApiError is a definite refusal', () => {
    for (const status of [400, 404, 409, 413, 499]) {
      expect(isUncertainAnswer(new ApiError(status, 'refused'))).toBe(false);
    }
    for (const status of [UNCONFIRMED_ANSWER_STATUS, 200, 399, 500, 502, 503]) {
      expect(isUncertainAnswer(new ApiError(status, 'unknown'))).toBe(true);
    }
    expect(isUncertainAnswer(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUncertainAnswer(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
    expect(isUncertainAnswer(new Error('This route has no domain'))).toBe(true);
    expect(isUncertainAnswer(undefined)).toBe(true);
    expect(
      isUncertainAnswer(new RouteExistsError({ path: '/a', type: 'redirect', target: 'x' })),
    ).toBe(false);
  });

  it('a write refused before any request is definite, whatever its subclass', () => {
    expect(isUncertainAnswer(new RouteWriteRefusedError('Refused'))).toBe(false);
    expect(isUncertainAnswer(new RouteWritePendingError())).toBe(false);
    expect(isUncertainAnswer(new RouteWriteDomainError())).toBe(false);
    expect(new RouteWritePendingError()).toBeInstanceOf(RouteWriteRefusedError);
    expect(new RouteWriteDomainError()).toBeInstanceOf(RouteWriteRefusedError);
    expect(new RouteWriteRefusedError('Refused').name).toBe('RouteWriteRefusedError');
  });
});

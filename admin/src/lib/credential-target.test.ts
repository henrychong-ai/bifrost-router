import { describe, test, expect } from 'vitest';
import { ApiError } from './api-error';
import {
  ROUTE_TARGET_CREDENTIAL_CODE,
  credentialTargetParametersFromError,
} from './credential-target';

/**
 * The dashboard turns the server's machine CODE into its own confirmation, so
 * all it needs from the refusal is the parameter NAMES. The values are never
 * sent and must never be required.
 */
describe('credentialTargetParametersFromError', () => {
  const refusal = (details: unknown) => new ApiError(400, ROUTE_TARGET_CREDENTIAL_CODE, details);

  test('returns the parameter names from a genuine refusal', () => {
    expect(credentialTargetParametersFromError(refusal({ parameters: ['token', 'code'] }))).toEqual(
      ['token', 'code'],
    );
  });

  test('returns null for any other error', () => {
    expect(credentialTargetParametersFromError(new ApiError(404, 'Route not found'))).toBeNull();
    expect(credentialTargetParametersFromError(new Error('network down'))).toBeNull();
    expect(credentialTargetParametersFromError('not an error')).toBeNull();
    expect(credentialTargetParametersFromError(undefined)).toBeNull();
  });

  test('returns null when the refusal carries no usable names', () => {
    expect(credentialTargetParametersFromError(refusal(undefined))).toBeNull();
    expect(credentialTargetParametersFromError(refusal({}))).toBeNull();
    expect(credentialTargetParametersFromError(refusal({ parameters: [] }))).toBeNull();
    expect(credentialTargetParametersFromError(refusal({ parameters: 'token' }))).toBeNull();
  });

  test('keeps only the string entries', () => {
    expect(
      credentialTargetParametersFromError(refusal({ parameters: ['token', 42, null] })),
    ).toEqual(['token']);
  });
});

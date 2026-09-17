import { ApiError } from './api-error';

/**
 * The machine code a route write answers with when its TARGET carries a
 * credential-named query parameter and the operator has not acknowledged it.
 *
 * The Worker sends `error` as this CODE and puts the human sentence in
 * `message`; the dashboard writes its own sentence, so it needs only the names.
 */
export const ROUTE_TARGET_CREDENTIAL_CODE = 'ROUTE_TARGET_CREDENTIAL';

/**
 * The credential-named parameters a route write refused on, or `null` when the
 * error is anything else. Names only — the Worker never sends the values.
 */
export function credentialTargetParametersFromError(error: unknown): string[] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.message !== ROUTE_TARGET_CREDENTIAL_CODE) return null;
  const details = error.details as { parameters?: unknown } | undefined;
  const parameters = details?.parameters;
  if (!Array.isArray(parameters)) return null;
  const names = parameters.filter((name): name is string => typeof name === 'string');
  return names.length > 0 ? names : null;
}

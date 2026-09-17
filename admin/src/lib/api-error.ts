/**
 * The dashboard's API error.
 *
 * Its own module so callers that need only the error shape do not pull in
 * `api-client.ts`, which validates the runtime environment at import time.
 */
export class ApiError extends Error {
  status: number;
  /**
   * The refusal's `details` object, verbatim. The route-target credential
   * guard answers `error: 'ROUTE_TARGET_CREDENTIAL'` with
   * `details: { parameters: [...] }`, and the dashboard needs those NAMES to
   * write its confirmation. Values are never sent.
   */
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

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
  /**
   * The refusal's machine-readable code when the server sent one beside a
   * message (`{ error: 'QR_NOT_FOUND', message }`, v1.38.0).
   */
  code?: string | undefined;

  constructor(
    status: number,
    message: string,
    details?: unknown,
    extra: { code?: string | undefined } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = extra.code;
  }
}

/**
 * Whether an error is the server's own answer that a QR code does not exist
 * (v1.38.0): a 404 whose body names `QR_NOT_FOUND`. Any other 404 (a wrong
 * base URL, a proxy in front of the API) says nothing about the code.
 */
export function isQrNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404 && error.code === 'QR_NOT_FOUND';
}

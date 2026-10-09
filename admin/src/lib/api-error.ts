import type { Route } from './schemas';

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
 * The status of an {@link ApiError} the dashboard builds itself from an answer
 * that says nothing definite (v1.41.2): a route write the server answered 2xx
 * with `success: false` or no route. A 2xx means the request was not refused,
 * so whether the write landed is unknown; status 0, like no answer at all,
 * reads as uncertain ({@link isUncertainAnswer}), never as a 4xx refusal.
 */
export const UNCONFIRMED_ANSWER_STATUS = 0;

/**
 * A route write the dashboard refused itself, before any request was sent
 * (v1.41.2): the one marker for "nothing went out", so nothing changed. Every
 * such client-side refusal extends it (another write of this session holds
 * the route, `RouteWritePendingError`; the write names no domain,
 * `RouteWriteDomainError`), and {@link isUncertainAnswer} reads it as
 * definite.
 */
export class RouteWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteWriteRefusedError';
  }
}

/**
 * Whether `error` leaves it unknown if the server applied the write: anything
 * but an `ApiError` with a 4xx status, the server's own refusal, after which
 * nothing was written, or a {@link RouteWriteRefusedError}, refused before any
 * request. So no HTTP answer (a network failure, an aborted request, an
 * unreadable body), a 5xx (an edge or a Worker can send one after the write
 * landed), and a 2xx the dashboard could not read as a success (status
 * {@link UNCONFIRMED_ANSWER_STATUS}) are all uncertain. The one predicate the
 * route writes, the Routes page and the QR page share (v1.41.2; each carried
 * its own copy of the 4xx check before).
 */
export function isUncertainAnswer(error: unknown): boolean {
  if (error instanceof RouteWriteRefusedError) return false;
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/**
 * Whether an error is the server's own answer that a QR code does not exist
 * (v1.38.0): a 404 whose body names `QR_NOT_FOUND`. Any other 404 (a wrong
 * base URL, a proxy in front of the API) says nothing about the code.
 */
export function isQrNotFoundError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 404 && error.code === 'QR_NOT_FOUND';
}

/**
 * Whether an error is the server's answer that a create's id is already taken
 * (v1.38.0): a 409 whose body names `QR_ALREADY_EXISTS`. Not `QR_RECORD_INVALID`
 * (the id holds an unreadable record), which is another 409.
 */
export function isQrAlreadyExistsError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'QR_ALREADY_EXISTS';
}

/**
 * Whether an error is the server's answer that a route create's path is
 * already taken (v1.38.0): a 409 with no code whose text is `Route already
 * exists: …`. Not `ROUTE_RECORD_INVALID` (the path holds an unreadable
 * record), which is a coded 409.
 */
export function isRouteAlreadyExistsError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === undefined &&
    error.message.startsWith('Route already exists')
  );
}

/**
 * A route create retried after an uncertain answer that met a route at its
 * path holding other values (v1.38.0): not this create's own route. Carries
 * the existing route, so the page can offer to view it.
 */
export class RouteExistsError extends ApiError {
  /** The route stored at the path. */
  readonly route: Route;

  constructor(route: Route) {
    super(409, `Route ${route.path} already exists with other values.`);
    this.name = 'RouteExistsError';
    this.route = route;
  }
}

/**
 * Whether an error is the Worker's 409 `ROUTE_SOURCE_CHANGED` (v1.40.0 for
 * the edit precondition): the route changed since the dashboard loaded it, so
 * nothing was saved or moved. The caller reloads the route before any retry,
 * which would otherwise send the same stale `expectedUpdatedAt`.
 */
export function isRouteSourceChanged(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'ROUTE_SOURCE_CHANGED' || error.message === 'ROUTE_SOURCE_CHANGED')
  );
}

/**
 * Whether an error is a 404 answer (v1.41.1). The Worker answers a missing
 * route ("Route not found: …", on an update, toggle, delete, migration or
 * transfer) as a bare text with no code, and an unknown endpoint, the admin
 * API hidden on another host or a proxy in front of the API answer 404 too,
 * so it never says the route is gone: a route write answered this way only
 * refetches the listings. (A QR code's own absence has a code,
 * {@link isQrNotFoundError}.) It narrows to a 404 `ApiError` only, so a
 * `false` answer never narrows an `ApiError` away (v1.41.1 review).
 */
export function isNotFoundError(error: unknown): error is ApiError & { status: 404 } {
  return error instanceof ApiError && error.status === 404;
}

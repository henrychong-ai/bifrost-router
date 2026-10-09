import { RouteWriteRefusedError } from './api-error';

/**
 * The write named no domain, so it was refused before any request (v1.41.2:
 * a {@link RouteWriteRefusedError}, told apart from a request's failure,
 * which may have landed).
 */
export class RouteWriteDomainError extends RouteWriteRefusedError {
  constructor() {
    super('This route has no domain. Select its domain and try again.');
    this.name = 'RouteWriteDomainError';
  }
}

/**
 * The domain a route write targets, or `undefined` when there is none: the
 * route's own domain (set on every row of the all-domains view), else the
 * domain the page is filtered to. An empty string is no domain (v1.41.2: the
 * one resolution the Routes page's held-route checks, store reads and writes
 * share, so a check reads the key the write will hold).
 */
export function writeDomain(
  routeDomain: string | undefined,
  selectedDomain: string | undefined,
): string | undefined {
  return routeDomain || selectedDomain || undefined;
}

/**
 * The domain a route write targets ({@link writeDomain}). The API refuses a
 * mutation that names no domain, so the dashboard resolves one before
 * sending, and refuses the write itself when there is none.
 */
export function requireWriteDomain(
  routeDomain: string | undefined,
  selectedDomain: string | undefined,
): string {
  const domain = writeDomain(routeDomain, selectedDomain);
  if (domain === undefined) {
    throw new RouteWriteDomainError();
  }
  return domain;
}

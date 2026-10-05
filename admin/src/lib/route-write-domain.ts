/**
 * The domain a route write targets. The API refuses a mutation that names no
 * domain, so the dashboard resolves one before sending: the route's own domain
 * (set on every row of the all-domains view), else the domain the page is
 * filtered to.
 */
export function requireWriteDomain(
  routeDomain: string | undefined,
  selectedDomain: string | undefined,
): string {
  const domain = routeDomain || selectedDomain;
  if (!domain) {
    throw new Error('This route has no domain. Select its domain and try again.');
  }
  return domain;
}

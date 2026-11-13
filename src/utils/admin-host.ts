/**
 * Whether `hostname` serves the admin API: the admin host (`ADMIN_API_DOMAIN`)
 * only, or every host when it is unset (a development convenience). The admin
 * mount hides itself with a 404 on every other host, and the catch-all 404
 * names the admin API only where this holds, so a public short-link or file
 * host never tells a visitor how routes are managed.
 */
export function servesAdminApi(hostname: string, adminDomain: string | undefined): boolean {
  return !adminDomain || hostname === adminDomain;
}

/**
 * Boot-time warnings for the stdio MCP server (v1.35.0).
 *
 * A removed environment variable left behind in an operator's config is never a
 * startup failure — the server must still serve. But it must not stay silent
 * either, or the operator keeps believing a default is being applied. This lives
 * in its own module rather than inline in `index.ts` because that file calls
 * `main()` at module scope, so importing it starts a real stdio server and the
 * behaviour could not otherwise be tested.
 */

/** Environment variables the server no longer reads, and what to say about each. */
export const IGNORED_ENV_WARNINGS: Readonly<Record<string, string>> = {
  EDGE_ROUTER_DOMAIN:
    'EDGE_ROUTER_DOMAIN is set but ignored since v1.35.0 — pass domain on every route, QR and slug-stats call.',
};

/**
 * Emit one warning per ignored variable that is still set, and return the names
 * warned about. Never throws and never fails startup.
 */
export function warnIgnoredEnv(
  env: Record<string, string | undefined>,
  log: (message: string) => void,
): string[] {
  const warned: string[] = [];
  for (const [key, message] of Object.entries(IGNORED_ENV_WARNINGS)) {
    if (env[key]) {
      log(message);
      warned.push(key);
    }
  }
  return warned;
}

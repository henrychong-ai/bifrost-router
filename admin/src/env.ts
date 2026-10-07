/**
 * Where the dashboard sends its API calls (v1.39.0): its own origin, always.
 * The dashboard holds no admin key. In a container, nginx proxies `/api` to
 * the Worker and adds `X-Admin-Key` from the container's ADMIN_API_KEY; under
 * `pnpm dev`, the Vite dev server does the same from admin/.env.local
 * (`vite.config.ts`). So the bundle carries no environment value at all, and
 * no build of it can contain or send the key.
 */
export const env = {
  /** The origin every API call goes to: the page's own. */
  API_ORIGIN: window.location.origin,
} as const;

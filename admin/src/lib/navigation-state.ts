import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { type Route, RouteSchema } from '@/lib/schemas';

/**
 * The route a page hand-off asks the Routes page to open for editing
 * (`navigate('/routes', { state: { editRoute } })`), read from
 * `location.state` as unknown and validated (v1.38.0); undefined when the
 * state carries no valid route.
 */
export function navEditRoute(state: unknown): Route | undefined {
  if (typeof state !== 'object' || state === null || !('editRoute' in state)) return undefined;
  const parsed = RouteSchema.safeParse(state.editRoute);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Clear the current history entry's navigation state once a page has consumed
 * it (v1.37.1), so a reload or a return to the entry opens on the page's own
 * defaults instead of replaying the hand-off.
 *
 * The clear goes through the router, a replace navigation to the same path,
 * query and hash with `state: null`, so React Router's own `location.state`
 * agrees with the history entry. Writing `window.history.replaceState({}, '')`
 * behind its back left `location.state` stale and dropped the router's own
 * fields from the entry.
 *
 * @param consumed - true once the page has read state it must not replay
 */
export function useClearNavigationState(consumed: boolean): void {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname, search, hash } = location;
  useEffect(() => {
    if (!consumed) return;
    void navigate({ pathname, search, hash }, { replace: true, state: null });
  }, [consumed, pathname, search, hash, navigate]);
}

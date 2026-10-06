import type { Route, UpdateRouteInput } from './schemas';

/**
 * What the router does when a stored route lacks the field (`src/handlers`):
 * an absent value means this, so sending it changes nothing. A missing
 * `bucket` is the default bucket (`route.bucket ?? 'files'` in the R2
 * handler). `forceDownload` is not here: absent means "decide by content
 * type", which `false` does not.
 */
const ABSENT_MEANS: Readonly<Partial<Record<keyof Route, unknown>>> = {
  enabled: true,
  statusCode: 302,
  preserveQuery: true,
  preservePath: false,
  bucket: 'files',
};

/** A stored value as the comparison sees it: an empty string is absent. */
function normalised(value: unknown): unknown {
  return value === '' ? undefined : value;
}

/**
 * The update the route edit dialog sends (v1.38.0): only the fields whose
 * submitted value differs from the route as loaded, so the request is a true
 * patch. The Worker applies today's field limits to the fields a patch sets
 * only, so an edit that does not touch a field written under older limits (a
 * target longer than today's cap) is not refused because the form re-sent
 * it. A field the form leaves undefined is not sent (JSON drops it); an
 * empty string counts as equal to an absent value, and is still sent when it
 * clears a stored one (`''` clears a Cache-Control or Host header); a field
 * the stored route lacks compares as the router's default for it
 * (ABSENT_MEANS). An unchanged form gives `{}`.
 */
export function routeEditPatch(route: Route, desired: UpdateRouteInput): UpdateRouteInput {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const key = field as keyof Route;
    if (normalised(value) !== normalised(route[key] ?? ABSENT_MEANS[key])) patch[field] = value;
  }
  return patch;
}

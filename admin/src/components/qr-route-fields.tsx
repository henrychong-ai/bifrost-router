import {
  isSupportedDomain,
  linkNamingIssues,
  matchesSearchFields,
  parseSearchQuery,
  type QRCode,
} from '@bifrost/shared';
import { useMemo, useState } from 'react';
import { FieldHint } from '@/components/field-hint';
import { LinkNamingWarnings } from '@/components/link-naming-warnings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { linkedRouteUrl, normalizeQrRoutePath, type QrFormState } from '@/lib/qr-form-state';
import type { Route } from '@/lib/schemas';

/**
 * The QR editor's linked-route section (v1.38.0, url codes): a switch makes
 * the code dynamic, so it encodes `https://<domain><path>` and is re-pointed
 * by editing the route. Pick an existing route on the code's own domain
 * (searched with the shared matcher), or name a new one, which the editor
 * creates as a 302 redirect before saving the code.
 */
export function QrRouteFields({
  state,
  domain,
  set,
  routes,
  loading,
  failed,
  duplicate,
  retry,
}: {
  state: QrFormState;
  domain: string;
  set: (patch: Partial<QrFormState>) => void;
  routes: Route[];
  loading: boolean;
  failed: boolean;
  duplicate?: QRCode | undefined;
  retry: () => void;
}) {
  const [search, setSearch] = useState('');
  const dynamic = state.linkMode !== 'static';
  const query = useMemo(() => parseSearchQuery(search), [search]);
  const matches = useMemo(
    () => routes.filter(route => matchesSearchFields([route.path], query)),
    [routes, query],
  );
  const newPath = normalizeQrRoutePath(state.newRoutePath);
  const namingIssues = newPath ? linkNamingIssues(newPath) : [];
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Switch
          id="qr-link-route"
          checked={dynamic}
          onCheckedChange={checked => set({ linkMode: checked ? 'existing' : 'static' })}
        />
        <FieldHint
          htmlFor="qr-link-route"
          label="Link to a route (dynamic QR)"
          hint="The printed code encodes https://<domain>/<path>. Change where it goes later by editing the route. Re-point, never reprint."
        />
      </div>
      {dynamic && (
        <>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={state.linkMode === 'existing' ? 'secondary' : 'outline'}
              aria-pressed={state.linkMode === 'existing'}
              onClick={() => set({ linkMode: 'existing' })}
            >
              Existing route
            </Button>
            <Button
              type="button"
              variant={state.linkMode === 'new' ? 'secondary' : 'outline'}
              aria-pressed={state.linkMode === 'new'}
              onClick={() => set({ linkMode: 'new' })}
            >
              New route
            </Button>
          </div>
          {state.linkMode === 'existing' ? (
            <div className="space-y-2">
              <Label htmlFor="qr-route-search">Search routes on {domain}</Label>
              <Input
                id="qr-route-search"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading routes…</p>
              ) : failed ? (
                <p className="text-sm text-destructive">
                  Routes could not be loaded.{' '}
                  <Button type="button" variant="link" onClick={retry}>
                    Retry routes
                  </Button>
                </p>
              ) : (
                <fieldset className="max-h-36 overflow-y-auto" aria-label="Matching routes">
                  {matches.map(route => (
                    <Button
                      key={route.path}
                      type="button"
                      variant="ghost"
                      className="w-full justify-start font-mono text-xs"
                      aria-pressed={
                        state.linkedRoute?.domain === domain &&
                        state.linkedRoute.path === route.path
                      }
                      onClick={() => {
                        if (isSupportedDomain(domain)) {
                          set({ linkedRoute: { domain, path: route.path } });
                        }
                      }}
                    >
                      {route.path}
                    </Button>
                  ))}
                  {matches.length === 0 && (
                    <p className="text-sm text-muted-foreground">No matching routes.</p>
                  )}
                </fieldset>
              )}
              {state.linkedRoute?.domain === domain && (
                <p className="text-xs break-all">Selected: {linkedRouteUrl(state.linkedRoute)}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="qr-route-path">New route path</Label>
              <Input
                id="qr-route-path"
                placeholder="/summer-campaign"
                value={state.newRoutePath}
                onChange={e => set({ newRoutePath: e.target.value })}
                onBlur={() => set({ newRoutePath: normalizeQrRoutePath(state.newRoutePath) })}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase with hyphens; spaces convert automatically. A printed code keeps its link
                for good, so leave dates and versions out of it.
              </p>
              <LinkNamingWarnings issues={namingIssues} />
              <FieldHint
                htmlFor="qr-route-target"
                label="New route target"
                hint="Where the short link sends people today. Add UTM parameters here if you track scans separately from clicks."
              />
              <Input
                id="qr-route-target"
                placeholder="https://example.com/campaign"
                value={state.newRouteTarget}
                onChange={e => set({ newRouteTarget: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Creates a 302 redirect that keeps query parameters.
              </p>
            </div>
          )}
          {duplicate && (
            <output className="block text-sm text-amber-700">
              QR code “{duplicate.id}” already links to this route. You can still save another
              design.
            </output>
          )}
        </>
      )}
    </div>
  );
}

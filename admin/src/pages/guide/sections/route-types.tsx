import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, TypeBadge, Warn } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'route-types')!;

export function RouteTypesSection() {
  return (
    <GuideSection
      meta={meta}
      description="The three behaviours a route can have, the options that shape them, and the lifecycle actions."
    >
      <div className="space-y-3">
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="mb-1 flex items-center gap-2">
            <TypeBadge type="redirect" />
            <span className="font-medium text-blue-950">URL redirect</span>
          </div>
          <p className="text-charcoal-600">
            Sends the visitor to the target with an HTTP status you choose — <strong>302</strong>{' '}
            (default, temporary), <strong>301</strong> (permanent — browsers cache it hard),{' '}
            <strong>307/308</strong> (method-preserving variants). Query strings on the short link
            pass through to the target by default (<FactChip>preserveQuery</FactChip>); wildcard
            routes like <FactChip>/blog/*</FactChip> can also append the matched remainder to the
            target with <FactChip>preservePath</FactChip>.
          </p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="mb-1 flex items-center gap-2">
            <TypeBadge type="proxy" />
            <span className="font-medium text-blue-950">Reverse proxy</span>
          </div>
          <p className="text-charcoal-600">
            Fetches the target and serves its content under your Bifrost path — the visitor never
            leaves your domain. Supports a Host-header override (needed for CDN-hosted sites like
            Webflow) and custom <FactChip>Cache-Control</FactChip>. Requests time out after 30s and
            private/internal targets are blocked.
          </p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="mb-1 flex items-center gap-2">
            <TypeBadge type="r2" />
            <span className="font-medium text-blue-950">File serving (R2)</span>
          </div>
          <p className="text-charcoal-600">
            Serves an object from one of the R2 storage buckets. Options:{' '}
            <FactChip>forceDownload</FactChip> (download vs open in the browser), and{' '}
            <FactChip>serveMode: prefix</FactChip> to serve a whole folder as a static site (pair an
            exact route with a <FactChip>/site/*</FactChip> wildcard;{' '}
            <FactChip>index.html</FactChip> is the default document).
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <p className="font-medium text-blue-950">Lifecycle actions:</p>
        <ul className="space-y-1 text-charcoal-600">
          <li>
            <strong>Edit</strong> (row menu) — change the target or options; the short URL stays
            stable.
          </li>
          <li>
            <strong>Enable / Disable</strong> (row menu) — switch a route off without deleting it.
          </li>
          <li>
            <strong>Migrate</strong> — change the <em>Path</em> field inside the Edit dialog; a
            confirmation migrates the route to the new slug, preserving its config and creation
            date.
          </li>
          <li>
            <strong>Transfer</strong> — pick a different domain in the Edit dialog's
            Transfer-to-Domain selector (you need access to both domains).
          </li>
          <li>
            <strong>Delete</strong> (row menu) — permanent, with a confirmation dialog. Prefer
            Disable if unsure.
          </li>
        </ul>
      </div>
      <p>
        Every route also takes a free-text <strong>comment</strong> (up to 1,000 characters) — use
        it to note ownership or context for the next person.
      </p>
      <Warn>
        301 redirects are cached aggressively by browsers — if a link's target may ever change,
        prefer the default 302. And remember paths are normalised to lowercase:{' '}
        <FactChip>/Summit</FactChip> and <FactChip>/summit</FactChip> are the same route.
      </Warn>
    </GuideSection>
  );
}

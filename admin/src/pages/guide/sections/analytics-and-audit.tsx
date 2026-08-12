import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, Tip } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'analytics-and-audit')!;

export function AnalyticsAndAuditSection() {
  return (
    <GuideSection
      meta={meta}
      description="Four traffic streams, a summary dashboard, and a complete history of who changed what."
    >
      <p>
        The <strong>Dashboard</strong> (home page) is a domain-aware operational overview. It shows
        canonical source URLs, period comparisons, recent activity,{' '}
        <strong>Top Routes - Redirect</strong>, <strong>Top Routes - Proxy</strong>, and{' '}
        <strong>Top Website Pages</strong> for service-bound HTML, plus leading domains, countries,
        and referrers. Cloudflare Health Checks are excluded by default and can be restored with the
        labelled toggle. The four Analytics pages hold the raw, filterable logs behind the legacy
        totals:
      </p>
      <ul className="space-y-1 text-charcoal-600">
        <li>
          <strong>Redirects</strong> — every short-link click, with country, referrer, and device
          detail.
        </li>
        <li>
          <strong>Views</strong> — page views on proxied and served content.
        </li>
        <li>
          <strong>Downloads</strong> — file fetches from storage-backed routes.
        </li>
        <li>
          <strong>Proxy</strong> — requests flowing through reverse-proxy routes.
        </li>
      </ul>
      <p>
        The Dashboard filters by domain, time window, country, and text search, exports the current
        view to a formula-safe CSV, and surfaces bounded actionable signals for traffic changes,
        proxy 5xx responses, low download cache-hit rates, and scanner-like leaders. Its partial
        coverage label is deliberate: the legacy tables are useful operational signals, not a count
        of every request. The optional unified shadow stream stays outside headline totals until an
        operator validates reconciliation.
      </p>
      <p>
        The <strong>Audit</strong> page is the platform's memory: every create, edit, delete,
        upload, share, and permission-relevant event, with the actor, source (dashboard, storage
        event, or Cloudflare), and full details. Click any row for the detail view — it deep-links
        straight to the affected route or file. When something looks wrong, start here:{' '}
        <FactChip>who changed it, and when?</FactChip>
      </p>
      <Tip>
        Want per-link numbers fast? Ask the AI side: the MCP tool{' '}
        <FactChip>get_slug_stats</FactChip> gives clicks-by-day, top countries, and referrers for
        any slug — or just ask your agent "how did /summit perform this month?".
      </Tip>
    </GuideSection>
  );
}

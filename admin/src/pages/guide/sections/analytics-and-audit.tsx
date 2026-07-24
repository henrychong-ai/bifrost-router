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
        The <strong>Dashboard</strong> (home page) summarises the last 30 days: total clicks, unique
        slugs, page views, and the top links, pages, countries, and referrers. The four Analytics
        pages hold the raw, filterable logs behind those numbers:
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
        Each page filters by domain, time window, country, and text search. Analytics respects your
        selected domain filter.
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

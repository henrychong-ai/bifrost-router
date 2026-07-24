import type { ReactNode } from 'react';
import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, Tip } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'faq')!;

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-medium text-blue-950">{q}</p>
      <div className="text-charcoal-600">{children}</div>
    </div>
  );
}

export function FaqSection() {
  return (
    <GuideSection meta={meta} description="The answers people usually need in week one.">
      <Faq q="My new link is not working — why?">
        Check three things: the route is <strong>Enabled</strong> (status column), you are using the
        exact path (<strong>paths are lowercase</strong> — <FactChip>/Summit</FactChip> becomes{' '}
        <FactChip>/summit</FactChip>), and you gave the change a few seconds to propagate. Changes
        go live globally in seconds, not instantly.
      </Faq>
      <Faq q="Why did a mutation fail with 401?">
        The dashboard's admin key is missing or stale — the single-operator deployment has no roles,
        so a refused write almost always means the <FactChip>X-Admin-Key</FactChip> the dashboard
        holds no longer matches the Worker secret. See the <strong>Access model</strong> section
        above.
      </Faq>
      <Faq q="Do query strings survive a redirect?">
        By default, yes — <FactChip>?utm_source=…</FactChip> on the short link is passed to the
        target (<FactChip>preserveQuery</FactChip>, on by default). Turn it off per-route if the
        target dislikes extra parameters.
      </Faq>
      <Faq q="What is the Dev Preview environment?">
        A fully isolated sandbox (the dev Worker environment, deployed with{' '}
        <FactChip>pnpm run deploy:dev</FactChip>) — separate routes, storage, and analytics. Try
        things there without touching production.
      </Faq>
      <Faq q="Can I add a new domain to the dropdown?">
        Yes — add it to <FactChip>SUPPORTED_DOMAINS</FactChip> in the repo (plus DNS + the Worker
        route on Cloudflare) and redeploy. The QR preset drift-guard will fail CI until the new
        domain is assigned a QR design, which is the reminder working as intended.
      </Faq>
      <Faq q="Who can see served files?">
        Files served through r2 routes are public on their route URLs — this deployment has no
        login-gated serving tier. Keep anything sensitive out of the routed buckets; the dashboard
        and admin API themselves stay Tailscale-gated.
      </Faq>
      <Faq q="Is any of this backed up?">
        Yes — route configuration is backed up daily and analytics storage has point-in-time
        recovery. The Dashboard shows backup health. Deleting a route or file is still permanent
        from your side, so treat Delete with respect (Disable is reversible).
      </Faq>
      <Tip>
        Not covered here? Search this guide (box at the top), check the Changelog for recent
        behaviour changes, or send a question via Feedback — questions are a first-class feedback
        type.
      </Tip>
    </GuideSection>
  );
}

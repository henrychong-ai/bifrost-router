import { SUPPORTED_DOMAINS } from '@bifrost/shared';
import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, TypeBadge } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'what-is-bifrost')!;

export function WhatIsBifrostSection() {
  return (
    <GuideSection
      meta={meta}
      description="The 30-second mental model — what this platform does and why it is fast."
    >
      <p>
        Bifrost is your self-hosted edge router — it answers requests on{' '}
        <strong>{SUPPORTED_DOMAINS.length} domains</strong> (like{' '}
        <FactChip>links.example.com</FactChip> and <FactChip>secondary.example.net</FactChip>) and
        decides what each path does. Every link you create is configuration, not code — it is stored
        at the edge and goes <strong>live worldwide in seconds</strong>, with no deployment.
      </p>
      <div className="space-y-2">
        <p className="font-medium text-blue-950">A route is a path plus a behaviour:</p>
        <ul className="space-y-2">
          <li className="flex items-start gap-2">
            <TypeBadge type="redirect" />
            <span>
              Send visitors to another URL — the classic short link. <FactChip>/linkedin</FactChip>{' '}
              → your LinkedIn page.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <TypeBadge type="proxy" />
            <span>
              Serve another site's content under a Bifrost path, transparently (reverse proxy).
            </span>
          </li>
          <li className="flex items-start gap-2">
            <TypeBadge type="r2" />
            <span>
              Serve a file — or a whole static site — straight from cloud storage (R2 buckets).
            </span>
          </li>
        </ul>
      </div>
      <p>
        You can drive Bifrost three ways: this <strong>dashboard</strong>, an{' '}
        <strong>AI agent</strong> over MCP (Claude, Cursor, Codex — see the AI &amp; automation
        section), or the <strong>Slack bot</strong> for quick checks. Every change is recorded in
        the audit trail.
      </p>
    </GuideSection>
  );
}

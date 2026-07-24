import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { toolDefinitions } from '@bifrost/shared';
import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, MediaSlot, Tip } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'ai-and-automation')!;

const EXAMPLE_PROMPTS = [
  'Create a redirect from /talk on links.example.com to the slides PDF, and give me a QR code for it.',
  'Which of our short links got the most clicks in the last 30 days?',
  'Upload this report to storage and create a short link that forces download.',
];

export function AiAndAutomationSection() {
  return (
    <GuideSection
      meta={meta}
      description="Drive Bifrost from your AI tools in natural language — same permissions, same audit trail."
    >
      <MediaSlot slotId="ai-and-automation" />
      <p>
        Bifrost ships an <strong>MCP server</strong>, which means AI clients — Claude Code, Claude
        Desktop, Cursor, Codex — can manage routes, storage, QR codes, analytics, and the feedback
        queue for you. It exposes <strong>{toolDefinitions.length} tools</strong> over the local
        stdio transport, authenticated with the admin API key, and every change lands in the audit
        trail.
      </p>
      <div className="space-y-1.5">
        <p className="font-medium text-blue-950">Things you can just ask your agent:</p>
        <ul className="space-y-1">
          {EXAMPLE_PROMPTS.map(prompt => (
            <li key={prompt} className="flex gap-2 text-charcoal-600">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-charcoal-300" />
              <span>"{prompt}"</span>
            </li>
          ))}
        </ul>
      </div>
      <Link
        to="/integrations/mcp"
        className="
          inline-flex items-center gap-1.5 font-medium text-blue-600
          transition-colors
          hover:text-blue-800
        "
      >
        Set it up on the MCP page — per-client install snippets and the full tool list
        <ArrowRight className="size-4" />
      </Link>
      <p>
        There is also a <strong>Slack bot</strong> for quick checks without leaving Slack: @-mention
        it or DM it with things like <FactChip>list routes for links.example.com</FactChip>,{' '}
        <FactChip>stats for /summit</FactChip>, or{' '}
        <FactChip>create redirect from /x to https://…</FactChip> (send <FactChip>help</FactChip>{' '}
        for the full set).
      </p>
      <Tip>
        The Slack bot holds the same admin key as the dashboard — treat its channel like a terminal
        with root.
      </Tip>
    </GuideSection>
  );
}

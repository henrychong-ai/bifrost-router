import { SUPPORTED_DOMAINS } from '@/context';
import { GUIDE_SECTIONS } from '../guide-registry';
import { FactChip, GuideSection, Tip } from '../guide-primitives';

const meta = GUIDE_SECTIONS.find(s => s.id === 'access-and-roles')!;

/**
 * Single-operator access model (v1.30.0 — replaces the upstream multi-user
 * roles section): this deployment has no role system, so the section explains
 * the two real gates instead.
 */
export function AccessAndRolesSection() {
  return (
    <GuideSection
      meta={meta}
      description="One operator, two gates: the Tailscale network edge and the admin API key."
    >
      <p>
        This is a <strong>single-operator</strong> deployment — there are no accounts, roles, or
        permission tiers to manage. Access is controlled by two layers that both sit in front of
        everything you see here:
      </p>
      <p>
        <strong>1. The network edge.</strong> The dashboard is designed to sit on a private network
        — the template ships a Tailscale-enabled Docker compose file for exactly that, so the admin
        surfaces are never exposed to the public internet. When a Tailscale identity is available,
        changes you make are attributed to it in the audit log.
      </p>
      <p>
        <strong>2. The admin API key.</strong> Every call the dashboard (and the MCP server, and the
        Slack bot) makes to the admin API carries the <FactChip>X-Admin-Key</FactChip> header. The
        key grants full read-write access to all {SUPPORTED_DOMAINS.length} domains and every bucket
        — there is no read-only tier.
      </p>
      <p>
        The public side is different: short links, proxied pages, and served files respond on their
        own domains for anyone. Only the <em>management</em> surfaces (this dashboard, the admin
        API, MCP, Slack bot) sit behind the gates above.
      </p>
      <Tip>
        Because one key grants everything, treat it like a root credential: keep it in a secret
        manager and the Worker's secrets — never in a file in this repo, never in a shared chat.
      </Tip>
    </GuideSection>
  );
}

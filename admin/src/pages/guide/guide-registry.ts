import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  Bot,
  CircleHelp,
  Command,
  Compass,
  HardDrive,
  KeyRound,
  MessageSquare,
  QrCode,
  Rocket,
  Route,
} from 'lucide-react';

/**
 * The single source of truth for the User Guide's structure. Drives the TOC,
 * the in-page search, hash-anchor deep links (/guide#<id>), ContextualHelp
 * targets, and the coverage parity test (guide-coverage.test.ts) that fails CI
 * when a sidebar page ships without guide coverage.
 *
 * Render-free by design (no JSX) so the parity test can import it in a plain
 * node vitest run. Section components are mapped by id in guide.tsx — typed
 * Record<GuideSectionId, …>, so a registry id without a component (or vice
 * versa) fails tsc.
 */
export const GUIDE_SECTION_IDS = [
  'what-is-bifrost',
  'access-and-roles',
  'first-short-link',
  'route-types',
  'qr-codes',
  'files-and-storage',
  'analytics-and-audit',
  'power-tools',
  'ai-and-automation',
  'feedback-and-help',
  'faq',
] as const;

export type GuideSectionId = (typeof GUIDE_SECTION_IDS)[number];

export interface GuideSectionMeta {
  /** Stable anchor id — used in URLs (/guide#<id>) and ContextualHelp links. */
  id: GuideSectionId;
  title: string;
  icon: LucideIcon;
  /** Search keywords beyond the title. */
  keywords: string[];
  /** Dashboard routes this section documents — drives the coverage parity test. */
  covers: string[];
}

export const GUIDE_SECTIONS: GuideSectionMeta[] = [
  {
    id: 'what-is-bifrost',
    title: 'What is Bifrost?',
    icon: Compass,
    keywords: ['overview', 'introduction', 'edge router', 'short links', 'domains', 'concept'],
    covers: ['/'],
  },
  {
    id: 'access-and-roles',
    title: 'Access model',
    icon: KeyRound,
    keywords: ['access', 'tailscale', 'admin key', 'api key', 'auth', 'security', 'single user'],
    covers: [],
  },
  {
    id: 'first-short-link',
    title: 'Create your first short link',
    icon: Rocket,
    keywords: ['getting started', 'create', 'redirect', 'walkthrough', 'tutorial', 'new route'],
    covers: ['/routes'],
  },
  {
    id: 'route-types',
    title: 'Route types & options',
    icon: Route,
    keywords: [
      'redirect',
      'proxy',
      'r2',
      'wildcard',
      'status code',
      'preserve query',
      'preserve path',
      'migrate',
      'transfer',
      'toggle',
      'disable',
    ],
    covers: ['/routes'],
  },
  {
    id: 'qr-codes',
    title: 'QR codes',
    icon: QrCode,
    keywords: [
      'qr',
      'wifi',
      'wpa3',
      'enterprise',
      'vcard',
      'dynamic qr',
      'logo',
      'brand',
      'brand colours',
      'reference',
      'description',
      'gold background',
      'svg',
      'png',
      'svg vs png',
      'linked route',
    ],
    covers: ['/qr-codes'],
  },
  {
    id: 'files-and-storage',
    title: 'Files & storage',
    icon: HardDrive,
    keywords: [
      'r2',
      'buckets',
      'upload',
      'download',
      'private sites',
      'share links',
      'purge cache',
      'rename',
      'move',
    ],
    covers: ['/storage'],
  },
  {
    id: 'analytics-and-audit',
    title: 'Analytics & audit trail',
    icon: BarChart3,
    keywords: ['clicks', 'views', 'downloads', 'proxy', 'stats', 'audit', 'history', 'countries'],
    covers: [
      '/analytics/redirects',
      '/analytics/views',
      '/analytics/downloads',
      '/analytics/proxy',
      '/audit',
    ],
  },
  {
    id: 'power-tools',
    title: 'Power tools & shortcuts',
    icon: Command,
    keywords: ['command palette', 'keyboard shortcuts', 'cmd+k', 'search', 'link preview'],
    covers: [],
  },
  {
    id: 'ai-and-automation',
    title: 'AI & automation (MCP)',
    icon: Bot,
    keywords: [
      'mcp',
      'claude',
      'cursor',
      'codex',
      'ai',
      'slackbot',
      'slack',
      'agent',
      'automation',
    ],
    covers: ['/integrations/mcp'],
  },
  {
    id: 'feedback-and-help',
    title: 'Feedback & getting help',
    icon: MessageSquare,
    keywords: ['bug report', 'feature request', 'feedback', 'changelog', 'help', 'triage'],
    covers: ['/feedback', '/changelog'],
  },
  {
    id: 'faq',
    title: 'FAQ & gotchas',
    icon: CircleHelp,
    keywords: [
      'faq',
      'troubleshooting',
      'propagation',
      'lowercase',
      'dev preview',
      'sandbox',
      'questions',
    ],
    covers: [],
  },
];

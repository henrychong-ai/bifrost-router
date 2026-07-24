import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  ClipboardList,
  Download,
  Eye,
  Globe,
  HardDrive,
  LayoutDashboard,
  MessageSquarePlus,
  QrCode,
  Route,
  ScrollText,
} from 'lucide-react';

/**
 * Sidebar navigation registry (v1.30.0 — extracted from app-sidebar.tsx,
 * mirroring the upstream layout/nav-items.ts module). Render-free so the
 * User Guide coverage parity test (guide-coverage.test.ts) can import it in
 * a plain node vitest run.
 */
export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
}

export const navigationItems: NavItem[] = [
  {
    title: 'Dashboard',
    href: '/',
    icon: LayoutDashboard,
  },
  {
    title: 'Routes',
    href: '/routes',
    icon: Route,
  },
  {
    title: 'Storage',
    href: '/storage',
    icon: HardDrive,
  },
  // QR Codes sits directly below Storage (upstream v1.58.2 ordering): the two
  // storage-shaped surfaces stay together, and QR Codes builds on a route.
  {
    title: 'QR Codes',
    href: '/qr-codes',
    icon: QrCode,
  },
  {
    title: 'Audit',
    href: '/audit',
    icon: ClipboardList,
  },
  {
    title: 'Feedback',
    href: '/feedback',
    icon: MessageSquarePlus,
  },
];

export const analyticsItems: NavItem[] = [
  {
    title: 'Redirects',
    href: '/analytics/redirects',
    icon: ArrowUpRight,
  },
  {
    title: 'Views',
    href: '/analytics/views',
    icon: Eye,
  },
  {
    title: 'Downloads',
    href: '/analytics/downloads',
    icon: Download,
  },
  {
    title: 'Proxy',
    href: '/analytics/proxy',
    icon: Globe,
  },
];

/**
 * Resources group (v1.30.0): User Guide leads, above the Changelog — the
 * ordering is pinned by the guide coverage test.
 */
export const resourceItems: NavItem[] = [
  {
    title: 'User Guide',
    href: '/guide',
    icon: BookOpen,
  },
  {
    title: 'MCP',
    href: '/integrations/mcp',
    icon: Bot,
  },
  {
    title: 'Changelog',
    href: '/changelog',
    icon: ScrollText,
  },
];

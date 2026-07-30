import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { GUIDE_SECTIONS, type GuideSectionId, type GuideSectionMeta } from './guide-registry';
import { AccessAndRolesSection } from './sections/access-and-roles';
import { AiAndAutomationSection } from './sections/ai-and-automation';
import { AnalyticsAndAuditSection } from './sections/analytics-and-audit';
import { FaqSection } from './sections/faq';
import { FeedbackAndHelpSection } from './sections/feedback-and-help';
import { FilesAndStorageSection } from './sections/files-and-storage';
import { FirstShortLinkSection } from './sections/first-short-link';
import { PowerToolsSection } from './sections/power-tools';
import { QrCodesSection } from './sections/qr-codes';
import { RouteTypesSection } from './sections/route-types';
import { WhatIsBifrostSection } from './sections/what-is-bifrost';

/**
 * Section components keyed by registry id. The registry (guide-registry.ts)
 * stays render-free for the coverage parity test; this map is the render side.
 * Typed over the GuideSectionId union, so adding a registry id without a
 * component here (or removing one) is a compile error.
 */
const SECTION_COMPONENTS: Record<GuideSectionId, React.ComponentType> = {
  'what-is-bifrost': WhatIsBifrostSection,
  'access-and-roles': AccessAndRolesSection,
  'first-short-link': FirstShortLinkSection,
  'route-types': RouteTypesSection,
  'qr-codes': QrCodesSection,
  'files-and-storage': FilesAndStorageSection,
  'analytics-and-audit': AnalyticsAndAuditSection,
  'power-tools': PowerToolsSection,
  'ai-and-automation': AiAndAutomationSection,
  'feedback-and-help': FeedbackAndHelpSection,
  faq: FaqSection,
};

function matchesSearch(section: GuideSectionMeta, lowerQuery: string): boolean {
  if (section.title.toLowerCase().includes(lowerQuery)) return true;
  return section.keywords.some(k => k.toLowerCase().includes(lowerQuery));
}

/**
 * The User Guide — a task-oriented introduction to the whole platform.
 * Content lives in typed TSX sections (sections/*.tsx); enumerable facts
 * (domains, buckets, tool counts) are imported from @bifrost/shared so
 * they can never drift from the live product. Lazy-loaded (the app's first
 * code-split route) — keep this file default-exported for React.lazy.
 */
export default function GuidePage() {
  const [search, setSearch] = useState('');
  const location = useLocation();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return GUIDE_SECTIONS;
    return GUIDE_SECTIONS.filter(s => matchesSearch(s, q));
  }, [search]);

  // Arrival deep-link (/guide#section-id): scroll to the section once mounted
  // and flash a highlight ring. Also fires on in-page hash navigation.
  useEffect(() => {
    const id = location.hash.replace('#', '');
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const card = el.querySelector('[data-slot="card"]') ?? el;
    card.classList.add('ring-2', 'ring-gold-400/50');
    const clearRing = () => card.classList.remove('ring-2', 'ring-gold-400/50');
    const timer = setTimeout(clearRing, 2000);
    // Cleanup must also clear the ring — a hash change within 2s would
    // otherwise cancel the timer and leave the old section ringed forever.
    return () => {
      clearTimeout(timer);
      clearRing();
    };
  }, [location.hash]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in flex items-center gap-4">
        <h1 className="font-inter text-huge font-bold text-blue-950">User Guide</h1>
        <Badge className="border-transparent bg-gold-100 font-inter text-gold-600 hover:scale-100">
          v{__APP_VERSION__}
        </Badge>
        <div className="gradient-accent-bar h-1 flex-1 rounded-full opacity-30" />
      </div>

      <p className="animate-stagger-init animate-fade-in-up stagger-1 max-w-3xl font-inter text-small text-charcoal-600">
        Everything you need to use Bifrost, task-first: create links, serve files, read the numbers,
        and automate it all. New here? Read the first three sections — that is enough to be
        productive.
      </p>

      {/* Search + count */}
      <div
        className="
        animate-stagger-init animate-fade-in-up stagger-2
        flex items-center gap-4
      "
      >
        <div className="relative max-w-sm flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-charcoal-400" />
          <Input
            aria-label="Search the user guide"
            placeholder="Search topics — routes, storage, QR, shortcuts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10 font-inter"
          />
        </div>
        <span aria-live="polite" className="font-inter text-small text-muted-foreground">
          {filtered.length} of {GUIDE_SECTIONS.length} topics
        </span>
      </div>

      <div
        className="
          gap-6
          lg:grid lg:grid-cols-[220px_1fr] lg:items-start
        "
      >
        {/* TOC rail (desktop) */}
        <nav
          aria-label="Guide contents"
          className="
            sticky top-6 mb-6 hidden
            lg:block
          "
        >
          <ul className="space-y-1">
            {filtered.map(section => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="
                    flex items-center gap-2 rounded-md px-2 py-1.5 font-inter
                    text-small text-charcoal-600 transition-colors
                    hover:bg-blue-50 hover:text-blue-950
                  "
                >
                  <section.icon className="size-3.5 shrink-0 text-charcoal-400" />
                  <span className="truncate">{section.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Sections */}
        {filtered.length === 0 ? (
          <Card className="animate-fade-in border-border/50">
            <CardContent className="py-12 text-center">
              <p className="font-inter text-muted-foreground">No topics match your search.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filtered.map((section, index) => {
              const SectionComponent = SECTION_COMPONENTS[section.id];
              return (
                <div
                  key={section.id}
                  className="animate-stagger-init animate-fade-in-up"
                  style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
                >
                  <SectionComponent />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

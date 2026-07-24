import type { ReactNode } from 'react';
import { Lightbulb, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Kbd } from '@/components/ui/kbd';
import type { GuideSectionMeta } from './guide-registry';

/**
 * Shared building blocks for User Guide sections — thin wrappers over the
 * existing shadcn primitives so the guide renders with full design-system
 * fidelity (the same badges, kbd chips, and cards users see in the app).
 */

export function GuideSection({
  meta,
  description,
  children,
}: {
  meta: GuideSectionMeta;
  description?: string;
  children: ReactNode;
}) {
  const Icon = meta.icon;
  return (
    <section id={meta.id} className="scroll-mt-6">
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 font-inter font-semibold text-blue-950">
            <Icon className="size-4 text-blue-600" />
            {meta.title}
          </CardTitle>
          {description && <CardDescription className="font-inter">{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4 font-inter text-small text-charcoal-700">
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

export function StepList({ children }: { children: ReactNode }) {
  return <ol className="space-y-3">{children}</ol>;
}

export function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        className="
          mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full
          bg-blue-100 font-inter text-tiny font-semibold text-blue-700
        "
      >
        {n}
      </span>
      <div className="space-y-1">
        <p className="font-medium text-blue-950">{title}</p>
        {children && <div className="text-charcoal-600">{children}</div>}
      </div>
    </li>
  );
}

export function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-blue-100 bg-blue-50/40 p-3">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-blue-600" />
      <div className="text-charcoal-700">{children}</div>
    </div>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-gold-200 bg-gold-100/40 p-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-gold-600" />
      <div className="text-charcoal-700">{children}</div>
    </div>
  );
}

/** Inline keyboard-shortcut chip row, e.g. ⌘ K — Open the command palette. */
export function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex gap-0.5">
        {keys.map(k => (
          <Kbd key={k} size="sm">
            {k}
          </Kbd>
        ))}
      </span>
      <span className="text-charcoal-600">{label}</span>
    </span>
  );
}

/** The live route-type badge, matching the styling used across the app. */
export function TypeBadge({ type }: { type: 'redirect' | 'proxy' | 'r2' }) {
  const styles = {
    redirect: 'border-blue-200 bg-blue-100 text-blue-700',
    proxy: 'border-gold-200 bg-gold-100 text-gold-700',
    r2: 'border-charcoal-200 bg-charcoal-100 text-charcoal-700',
  }[type];
  return (
    <Badge variant="outline" className={`font-inter text-tiny ${styles}`}>
      {type}
    </Badge>
  );
}

/** Small mono chip for domains, buckets, and paths. */
export function FactChip({ children }: { children: ReactNode }) {
  return (
    <span
      className="
        inline-flex items-center rounded-md border border-charcoal-200
        bg-charcoal-50/70 px-1.5 py-0.5 font-mono text-tiny text-charcoal-700
      "
    >
      {children}
    </span>
  );
}

/**
 * Reserved per-section media extension point (plan Phase 3 — short silent
 * workflow recordings hosted on R2 and served through Bifrost itself). Renders
 * nothing today; gives future recordings a stable, non-breaking mount point.
 */
export function MediaSlot(_props: { slotId: string }) {
  return null;
}

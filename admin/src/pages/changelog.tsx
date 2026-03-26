import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  parseChangelog,
  getSectionBadgeClasses,
  renderInlineCode,
  type ChangelogVersion,
} from '@/lib/parse-changelog';
import changelogRaw from '../../../CHANGELOG.md?raw';

const allVersions = parseChangelog(changelogRaw);

function matchesSearch(version: ChangelogVersion, lowerQuery: string): boolean {
  if (version.version.toLowerCase().includes(lowerQuery)) return true;
  if (version.subtitle?.toLowerCase().includes(lowerQuery)) return true;
  for (const section of version.sections) {
    if (section.name.toLowerCase().includes(lowerQuery)) return true;
    for (const item of section.items) {
      if (item.title.toLowerCase().includes(lowerQuery)) return true;
      if (item.description.toLowerCase().includes(lowerQuery)) return true;
    }
  }
  return false;
}

export function ChangelogPage() {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^v/, '');
    if (!q) return allVersions;
    return allVersions.filter(v => matchesSearch(v, q));
  }, [search]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in flex items-center gap-4">
        <h1 className="font-gilroy text-huge font-bold text-blue-950">Changelog</h1>
        <Badge className="border-transparent bg-gold-100 font-gilroy text-gold-600 hover:scale-100">
          v{__APP_VERSION__}
        </Badge>
        <div className="gradient-accent-bar h-1 flex-1 rounded-full opacity-30" />
      </div>

      {/* Search + count */}
      <div
        className="
        animate-stagger-init animate-fade-in-up stagger-1
        flex items-center gap-4
      "
      >
        <div className="relative max-w-sm flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-charcoal-400" />
          <Input
            aria-label="Search changelog"
            placeholder="Search versions, features, fixes..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10 font-gilroy"
          />
        </div>
        <span aria-live="polite" className="font-gilroy text-small text-muted-foreground">
          {filtered.length} of {allVersions.length} versions
        </span>
      </div>

      {/* Version cards */}
      {filtered.length === 0 ? (
        <Card className="animate-fade-in border-border/50">
          <CardContent className="py-12 text-center">
            <p className="font-gilroy text-muted-foreground">No versions match your search.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filtered.map((version, vIndex) => {
            const isCurrent = version.version === __APP_VERSION__;
            return (
              <Card
                key={version.version}
                className={`
                  animate-stagger-init animate-fade-in-up border-border/50
                  ${isCurrent ? 'ring-2 ring-gold-400/50' : ''}
                `}
                style={{ animationDelay: `${Math.min(vIndex, 10) * 30}ms` }}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <CardTitle className="font-gilroy text-large font-semibold text-blue-950">
                      v{version.version}
                    </CardTitle>
                    {isCurrent && (
                      <Badge className="border-transparent bg-gold-100 font-gilroy text-tiny text-gold-600 hover:scale-100">
                        Current
                      </Badge>
                    )}
                  </div>
                  {version.subtitle && (
                    <p className="font-gilroy font-semibold text-charcoal-700">
                      {version.subtitle}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  {version.sections.map(section => (
                    <div key={section.name}>
                      <Badge
                        className={`
                          mb-2 border-transparent font-gilroy text-tiny hover:scale-100
                          ${getSectionBadgeClasses(section.name)}
                        `}
                      >
                        {section.name}
                      </Badge>
                      <ul className="space-y-1.5 pl-1">
                        {section.items.map((item, iIndex) => (
                          <li key={iIndex} className="flex gap-2 text-small">
                            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-charcoal-300" />
                            <span className="font-gilroy">
                              <span
                                className={
                                  item.isBold ? 'font-semibold text-blue-950' : 'text-charcoal-700'
                                }
                              >
                                {renderInlineCode(item.title)}
                              </span>
                              {item.description && (
                                <span className="text-charcoal-600">
                                  {' — '}
                                  {renderInlineCode(item.description)}
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  {version.sections.length === 0 && (
                    <p className="font-gilroy text-small text-muted-foreground italic">
                      No changes documented.
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

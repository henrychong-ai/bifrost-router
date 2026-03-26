import { beforeAll, describe, test, expect } from 'vitest';
import { parseChangelog, getSectionBadgeClasses, renderInlineCode } from './parse-changelog';

// =============================================================================
// parseChangelog
// =============================================================================

describe('parseChangelog', () => {
  test('parses a single version with one section', () => {
    const input = `## v1.0.0

### Added
- **Feature A** — Description of feature A
`;
    const result = parseChangelog(input);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('1.0.0');
    expect(result[0].sections).toHaveLength(1);
    expect(result[0].sections[0].name).toBe('Added');
    expect(result[0].sections[0].items).toHaveLength(1);
    expect(result[0].sections[0].items[0].title).toBe('Feature A');
    expect(result[0].sections[0].items[0].description).toBe('Description of feature A');
    expect(result[0].sections[0].items[0].isBold).toBe(true);
  });

  test('parses multiple versions', () => {
    const input = `## v2.0.0

### Added
- **New feature** — Something new

---

## v1.0.0

### Fixed
- **Bug fix** — Fixed something
`;
    const result = parseChangelog(input);
    expect(result).toHaveLength(2);
    expect(result[0].version).toBe('2.0.0');
    expect(result[1].version).toBe('1.0.0');
  });

  test('extracts subtitle from bold text after version header', () => {
    const input = `## v1.5.0

**Major refactor of the routing engine**

### Changed
- **Router** — Rewritten from scratch
`;
    const result = parseChangelog(input);
    expect(result[0].subtitle).toBe('Major refactor of the routing engine');
  });

  test('does not treat section headers as subtitles', () => {
    const input = `## v1.0.0

### Added
- **Feature** — A feature
`;
    const result = parseChangelog(input);
    expect(result[0].subtitle).toBeUndefined();
  });

  test('parses multiple sections within a version', () => {
    const input = `## v1.0.0

### Added
- **Feature A** — Added A

### Fixed
- **Bug B** — Fixed B

### Changed
- **Change C** — Changed C
`;
    const result = parseChangelog(input);
    expect(result[0].sections).toHaveLength(3);
    expect(result[0].sections[0].name).toBe('Added');
    expect(result[0].sections[1].name).toBe('Fixed');
    expect(result[0].sections[2].name).toBe('Changed');
  });

  test('parses all known section types', () => {
    const sectionNames = [
      'Added',
      'Fixed',
      'Changed',
      'Enhanced',
      'Features',
      'Security',
      'Dependencies',
      'Dashboard',
      'API',
      'MCP',
      'Tests',
      'Configuration',
      'Audit',
    ];
    const sections = sectionNames.map(n => `### ${n}\n- **Item** — Desc`).join('\n\n');
    const input = `## v1.0.0\n\n${sections}`;
    const result = parseChangelog(input);
    expect(result[0].sections).toHaveLength(sectionNames.length);
    for (let i = 0; i < sectionNames.length; i++) {
      expect(result[0].sections[i].name).toBe(sectionNames[i]);
    }
  });

  test('splits items on em-dash into title and description', () => {
    const input = `## v1.0.0

### Fixed
- **Storage cross-nav** — Fix race condition where auto-open fired against cached data
`;
    const result = parseChangelog(input);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('Storage cross-nav');
    expect(item.description).toBe('Fix race condition where auto-open fired against cached data');
    expect(item.isBold).toBe(true);
  });

  test('handles items with en-dash separator', () => {
    const input = `## v1.0.0

### Added
- **Feature** – Description with en-dash
`;
    const result = parseChangelog(input);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('Feature');
    expect(item.description).toBe('Description with en-dash');
    expect(item.isBold).toBe(true);
  });

  test('handles items without em-dash (title only with bold)', () => {
    const input = `## v1.0.0

### Added
- **Standalone feature**
`;
    const result = parseChangelog(input);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('Standalone feature');
    expect(item.description).toBe('');
    expect(item.isBold).toBe(true);
  });

  test('handles items without bold formatting', () => {
    const input = `## v1.0.0

### Dependencies
- oxlint 1.54 → 1.55, wrangler 4.72 → 4.73
`;
    const result = parseChangelog(input);
    const item = result[0].sections[0].items[0];
    expect(item.title).toBe('oxlint 1.54 → 1.55, wrangler 4.72 → 4.73');
    expect(item.description).toBe('');
    expect(item.isBold).toBe(false);
  });

  test('preserves inline backtick code in descriptions', () => {
    const input = `## v1.0.0

### Added
- **Helper** — Added \`getR2ObjectUrl()\` helper in \`admin/src/lib/constants.ts\`
`;
    const result = parseChangelog(input);
    const item = result[0].sections[0].items[0];
    expect(item.description).toContain('`getR2ObjectUrl()`');
    expect(item.description).toContain('`admin/src/lib/constants.ts`');
  });

  test('skips horizontal rules and blank lines', () => {
    const input = `# Changelog

All notable changes.

---

## v1.0.0

### Added
- **Feature** — Desc

---
`;
    const result = parseChangelog(input);
    expect(result).toHaveLength(1);
    expect(result[0].version).toBe('1.0.0');
  });

  test('returns empty array for empty input', () => {
    expect(parseChangelog('')).toEqual([]);
  });

  test('returns empty array for header-only input', () => {
    const input = `# Changelog

All notable changes to this project.

---
`;
    expect(parseChangelog(input)).toEqual([]);
  });

  test('handles multiple items per section', () => {
    const input = `## v1.0.0

### Added
- **Feature A** — Description A
- **Feature B** — Description B
- **Feature C** — Description C
`;
    const result = parseChangelog(input);
    expect(result[0].sections[0].items).toHaveLength(3);
  });

  test('extracts version number from dated headers', () => {
    const input = `## v1.21.0 (2026-03-02)

- Some change
`;
    const result = parseChangelog(input);
    expect(result[0].version).toBe('1.21.0');
  });

  test('collects bullets without ### section into fallback Overview', () => {
    const input = `## v1.20.0 (2026-02-25)

**Feature: Cross-bucket R2 move**

- New \`POST /api/storage/:bucket/move\` endpoint
- Full RBAC validation on both source and destination buckets
`;
    const result = parseChangelog(input);
    expect(result[0].version).toBe('1.20.0');
    expect(result[0].subtitle).toBe('Feature: Cross-bucket R2 move');
    // Bullets should be collected into a section (not lost)
    expect(result[0].sections.length).toBeGreaterThan(0);
    const allItems = result[0].sections.flatMap(s => s.items);
    expect(allItems.length).toBeGreaterThanOrEqual(2);
  });

  test('handles bold subheadings as section names in older format', () => {
    const input = `## v1.20.0 (2026-02-25)

**Subtitle here**

**Feature:**
- Item A
- Item B

**Changes:**
- Item C
`;
    const result = parseChangelog(input);
    expect(result[0].subtitle).toBe('Subtitle here');
    // Bold subheadings become sections
    const sectionNames = result[0].sections.map(s => s.name);
    expect(sectionNames).toContain('Feature');
    expect(sectionNames).toContain('Changes');
  });

  test('parses real CHANGELOG.md structure (newer format)', () => {
    const input = `# Changelog

All notable changes to Bifrost are documented in this file.

---

## v1.24.6

### Fixed
- **Storage cross-nav** — Fix race condition

---

## v1.24.5

### Added
- **Routes dialog** — "View in Storage" pill button
- **Storage dialog** — "View in Routes" clickable rows
- **Cross-navigation** — Branded pill buttons

---

## v1.0.0

**Initial release**

### Added
- **Dynamic Routing** — Configure routes via API
- **Three Route Types** — redirect, proxy, r2

### Security
- **SSRF Protection** — Blocks proxy requests to private IPs
`;
    const result = parseChangelog(input);
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0].version).toBe('1.24.6');
    expect(result[result.length - 1].version).toBe('1.0.0');
    expect(result[result.length - 1].subtitle).toBe('Initial release');

    const v1245 = result.find(v => v.version === '1.24.5');
    expect(v1245?.sections[0].items).toHaveLength(3);

    const v100 = result.find(v => v.version === '1.0.0');
    expect(v100?.sections).toHaveLength(2);
    expect(v100?.sections[0].name).toBe('Added');
    expect(v100?.sections[1].name).toBe('Security');
  });

  test('captures plain paragraph body text in older entries', () => {
    const input = `## v1.5.0 (2026-01-23)
**R2 Force Download Feature**

New \`forceDownload\` option for explicit Content-Disposition control.
`;
    const result = parseChangelog(input);
    expect(result[0].version).toBe('1.5.0');
    expect(result[0].subtitle).toBe('R2 Force Download Feature');
    // The paragraph should be captured, not lost
    const allItems = result[0].sections.flatMap(s => s.items);
    expect(allItems.length).toBeGreaterThanOrEqual(1);
    expect(allItems[0].title).toContain('forceDownload');
  });

  test('skips table rows in older entries', () => {
    const input = `## v1.13.1 (2026-02-05)
**Security: Dependency Updates**

Critical security updates.

| Package | From | To |
|---------|------|-----|
| hono | 4.11.4 | 4.11.7 |
`;
    const result = parseChangelog(input);
    const allItems = result[0].sections.flatMap(s => s.items);
    // Should have the paragraph but NOT the table rows
    expect(allItems.some(i => i.title.includes('Critical security'))).toBe(true);
    expect(allItems.some(i => i.title.includes('|'))).toBe(false);
  });

  test('parses older format without ### sections', () => {
    const input = `## v1.19.14 (2026-02-25)
**Fix: LinkPreview URL now clickable**

- The ExternalLink icon was a plain div — now wraps in an anchor tag

---

## v1.19.13 (2026-02-24)
**Chore: Dependency updates**

- **pnpm** — 10.28.2 → 10.30.2
- **Workers ecosystem** — wrangler 4.63.0 → 4.68.0
`;
    const result = parseChangelog(input);
    expect(result).toHaveLength(2);

    // v1.19.14 should have content, not be empty
    expect(result[0].version).toBe('1.19.14');
    expect(result[0].subtitle).toBe('Fix: LinkPreview URL now clickable');
    const allItems0 = result[0].sections.flatMap(s => s.items);
    expect(allItems0.length).toBeGreaterThanOrEqual(1);

    // v1.19.13 should parse bold items
    expect(result[1].version).toBe('1.19.13');
    const allItems1 = result[1].sections.flatMap(s => s.items);
    expect(allItems1.length).toBeGreaterThanOrEqual(2);
  });

  test('does not capture intro text before first version', () => {
    const input = `# Changelog

All notable changes to Bifrost are documented in this file.

For deployment instructions and project context, see CLAUDE.md.

---

## v1.0.0

### Added
- **Feature** — Desc
`;
    const result = parseChangelog(input);
    expect(result).toHaveLength(1);
    // Intro text should NOT appear as items
    const allItems = result[0].sections.flatMap(s => s.items);
    expect(allItems.some(i => i.title.includes('notable changes'))).toBe(false);
    expect(allItems.some(i => i.title.includes('deployment instructions'))).toBe(false);
  });

  // ===========================================================================
  // isBold flag tests
  // ===========================================================================

  test('marks bold items with isBold: true', () => {
    const input = `## v1.0.0

### Added
- **Bold title** — With description
- **Bold only**
`;
    const result = parseChangelog(input);
    const items = result[0].sections[0].items;
    expect(items[0].isBold).toBe(true);
    expect(items[1].isBold).toBe(true);
  });

  test('marks plain bullet items with isBold: false', () => {
    const input = `## v1.0.0

### Changed
- Plain bullet without any bold
- \`src/routes/admin.ts\`: Updated domain resolution
`;
    const result = parseChangelog(input);
    const items = result[0].sections[0].items;
    expect(items[0].isBold).toBe(false);
    expect(items[1].isBold).toBe(false);
  });

  test('marks plain paragraph text with isBold: false', () => {
    const input = `## v1.19.8 (2026-02-19)
**Feature: Analytics domain RBAC**

Non-admin users hitting analytics endpoints were getting 403.
The middleware now normalises domain access.
`;
    const result = parseChangelog(input);
    expect(result[0].subtitle).toBe('Feature: Analytics domain RBAC');
    const allItems = result[0].sections.flatMap(s => s.items);
    expect(allItems.length).toBe(2);
    expect(allItems[0].isBold).toBe(false);
    expect(allItems[1].isBold).toBe(false);
  });

  test('correctly distinguishes bold and plain items in mixed content', () => {
    const input = `## v1.19.6 (2026-02-19)
**Security: Strict R2 key validation**

Two R2 security improvements identified during review.

- **Path validation** — Rejects dangerous patterns
- \`src/utils/path-validation.ts\`: Return valid: false when sanitizedKey !== key
- Updated 2 existing tests, added 5 new rejection tests
`;
    const result = parseChangelog(input);
    const allItems = result[0].sections.flatMap(s => s.items);
    // Paragraph text — plain
    expect(allItems[0].title).toContain('Two R2 security');
    expect(allItems[0].isBold).toBe(false);
    // Bold bullet
    expect(allItems[1].title).toBe('Path validation');
    expect(allItems[1].isBold).toBe(true);
    // Plain bullets
    expect(allItems[2].isBold).toBe(false);
    expect(allItems[3].isBold).toBe(false);
  });

  // =========================================================================
  // Regression test against real CHANGELOG.md
  // =========================================================================

  describe('real CHANGELOG.md regression', () => {
    let versions: ReturnType<typeof parseChangelog>;

    // Dynamic imports with ts-expect-error — admin tsconfig is browser-only (no @types/node in types)
    // but vitest runs in Node where these modules are available
    beforeAll(async () => {
      // @ts-expect-error -- node:fs available at test runtime, not in browser tsconfig
      const fs = await import('node:fs');
      // @ts-expect-error -- node:path available at test runtime, not in browser tsconfig
      const path = await import('node:path');
      // @ts-expect-error -- process available at test runtime
      const cwd: string = process.cwd();
      // When run from admin/ package: cwd is admin/, CHANGELOG.md is ../CHANGELOG.md
      // When run from root vitest: cwd is repo root, CHANGELOG.md is ./CHANGELOG.md
      const changelogPath = fs.existsSync(path.resolve(cwd, 'CHANGELOG.md'))
        ? path.resolve(cwd, 'CHANGELOG.md')
        : path.resolve(cwd, '../CHANGELOG.md');
      const raw = fs.readFileSync(changelogPath, 'utf-8');
      versions = parseChangelog(raw);
    });

    test('parses all versions', () => {
      expect(versions.length).toBeGreaterThanOrEqual(30);
    });

    test('first version is the latest release', () => {
      const major = Number.parseInt(versions[0].version.split('.')[0]);
      expect(major).toBeGreaterThanOrEqual(1);
    });

    test('every version has a valid version string', () => {
      for (const v of versions) {
        // Allow semver (1.2.3) and range versions (1.9.x parsed as 1.9.)
        expect(v.version).toMatch(/^\d+\.\d+/);
      }
    });

    test('every version with a subtitle also has body content', () => {
      for (const v of versions) {
        if (v.subtitle) {
          const hasContent = v.sections.some(s => s.items.length > 0);
          expect(hasContent, `v${v.version} has subtitle "${v.subtitle}" but no body content`).toBe(
            true,
          );
        }
      }
    });

    test('known older versions exist and have content', () => {
      const olderVersions = ['1.7.0', '1.6.0', '1.5.0', '1.4.0', '1.3.0'];
      for (const ver of olderVersions) {
        const found = versions.find(v => v.version === ver);
        expect(found, `version ${ver} should exist`).toBeDefined();
        const totalItems = found!.sections.flatMap(s => s.items).length;
        expect(totalItems, `version ${ver} should have body content`).toBeGreaterThanOrEqual(1);
      }
    });

    test('known newer versions with ### sections parse correctly', () => {
      const v1164 = versions.find(v => v.version === '1.16.4');
      expect(v1164).toBeDefined();
      expect(v1164!.sections.some(s => s.name === 'Fixed')).toBe(true);

      const v1163 = versions.find(v => v.version === '1.16.3');
      expect(v1163).toBeDefined();
      expect(v1163!.sections.some(s => s.name === 'Added')).toBe(true);
    });

    test('no version contains table row content as items', () => {
      for (const v of versions) {
        for (const s of v.sections) {
          for (const item of s.items) {
            expect(item.title.startsWith('|'), `table row leaked into v${v.version}`).toBe(false);
          }
        }
      }
    });

    test('every item has a boolean isBold field', () => {
      for (const v of versions) {
        for (const s of v.sections) {
          for (const item of s.items) {
            expect(
              typeof item.isBold,
              `item in v${v.version} section "${s.name}" missing isBold`,
            ).toBe('boolean');
          }
        }
      }
    });

    test('newer versions (### sections) have bold items', () => {
      // Versions with ### sections and - **bold** — desc items should have isBold: true
      const v1164 = versions.find(v => v.version === '1.16.4');
      expect(v1164).toBeDefined();
      const fixedItems = v1164!.sections.find(s => s.name === 'Fixed')?.items ?? [];
      expect(fixedItems.length).toBeGreaterThan(0);
      expect(fixedItems[0].isBold).toBe(true);
    });

    test('versions with subtitles parse correctly', () => {
      // v1.16.0 has a subtitle
      const v1160 = versions.find(v => v.version === '1.16.0');
      expect(v1160).toBeDefined();
      expect(v1160!.subtitle).toBeDefined();
    });
  });
});

// =============================================================================
// getSectionBadgeClasses
// =============================================================================

describe('getSectionBadgeClasses', () => {
  test('returns green for Added', () => {
    expect(getSectionBadgeClasses('Added')).toBe('bg-green-100 text-green-700');
  });

  test('returns green for Features', () => {
    expect(getSectionBadgeClasses('Features')).toBe('bg-green-100 text-green-700');
  });

  test('returns orange for Fixed', () => {
    expect(getSectionBadgeClasses('Fixed')).toBe('bg-orange-100 text-orange-700');
  });

  test('returns blue for Changed', () => {
    expect(getSectionBadgeClasses('Changed')).toBe('bg-blue-100 text-blue-700');
  });

  test('returns blue for Enhanced', () => {
    expect(getSectionBadgeClasses('Enhanced')).toBe('bg-blue-100 text-blue-700');
  });

  test('returns red for Security', () => {
    expect(getSectionBadgeClasses('Security')).toBe('bg-red-100 text-red-700');
  });

  test('returns charcoal for Dependencies', () => {
    expect(getSectionBadgeClasses('Dependencies')).toBe('bg-charcoal-50 text-charcoal-700');
  });

  test('returns blue for Dashboard', () => {
    expect(getSectionBadgeClasses('Dashboard')).toBe('bg-blue-100 text-blue-600');
  });

  test('returns charcoal for Tests', () => {
    expect(getSectionBadgeClasses('Tests')).toBe('bg-charcoal-50 text-charcoal-600');
  });

  test('returns default charcoal for unknown section', () => {
    expect(getSectionBadgeClasses('Unknown')).toBe('bg-charcoal-50 text-charcoal-600');
  });

  test('is case-insensitive', () => {
    expect(getSectionBadgeClasses('ADDED')).toBe('bg-green-100 text-green-700');
    expect(getSectionBadgeClasses('fixed')).toBe('bg-orange-100 text-orange-700');
  });
});

// =============================================================================
// renderInlineCode
// =============================================================================

describe('renderInlineCode', () => {
  test('returns plain text when no backticks present', () => {
    const result = renderInlineCode('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  test('returns empty array for empty string', () => {
    const result = renderInlineCode('');
    expect(result).toEqual(['']);
  });

  test('renders single code span', () => {
    const result = renderInlineCode('Use `getRoute()` to fetch');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('Use ');
    // Middle element should be a React element (code tag)
    expect(typeof result[1]).toBe('object');
    expect(result[2]).toBe(' to fetch');
  });

  test('renders multiple code spans', () => {
    const result = renderInlineCode('From `src/` to `dist/` directory');
    expect(result.length).toBeGreaterThanOrEqual(3);
    // Should contain two code elements
    const codeElements = result.filter(r => typeof r === 'object');
    expect(codeElements).toHaveLength(2);
  });

  test('handles text starting with code span', () => {
    const result = renderInlineCode('`GET /api/routes` returns JSON');
    const codeElements = result.filter(r => typeof r === 'object');
    expect(codeElements).toHaveLength(1);
  });
});

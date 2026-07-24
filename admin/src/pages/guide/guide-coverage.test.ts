import { describe, expect, test } from 'vitest';
import { analyticsItems, navigationItems, resourceItems } from '@/components/layout/nav-items';
import { GUIDE_SECTION_IDS, GUIDE_SECTIONS } from './guide-registry';

/**
 * Coverage parity guard: every page reachable from the sidebar must be
 * documented by at least one User Guide section (via its `covers` list).
 * Ship a new sidebar page without guide coverage → this fails CI.
 */
describe('user guide coverage parity', () => {
  const sidebarHrefs = [
    ...navigationItems.map(i => i.href),
    ...analyticsItems.map(i => i.href),
    ...resourceItems.map(i => i.href),
  ].filter(href => href !== '/guide'); // the guide need not document itself

  const covered = new Set(GUIDE_SECTIONS.flatMap(s => s.covers));

  test.each(sidebarHrefs)('sidebar page %s is covered by a guide section', href => {
    expect(covered.has(href)).toBe(true);
  });

  test('every covers entry points at a real sidebar page (no stale coverage)', () => {
    const valid = new Set(sidebarHrefs);
    for (const section of GUIDE_SECTIONS) {
      for (const href of section.covers) {
        expect(valid.has(href), `${section.id} covers unknown page ${href}`).toBe(true);
      }
    }
  });

  test('section ids are unique, kebab-case, and searchable', () => {
    const ids = GUIDE_SECTIONS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of GUIDE_SECTIONS) {
      expect(section.id).toMatch(/^[a-z][a-z-]*[a-z]$/);
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.keywords.length).toBeGreaterThan(0);
    }
  });

  test('the id union and the registry cover exactly the same sections', () => {
    // GUIDE_SECTION_IDS is the literal union that types guide.tsx's component
    // map — every id must appear in the registry exactly once, and vice versa.
    expect(GUIDE_SECTIONS.map(s => s.id).sort()).toEqual([...GUIDE_SECTION_IDS].sort());
  });

  test('the sidebar Resources group leads with the User Guide, above the Changelog', () => {
    const hrefs = resourceItems.map(i => i.href);
    expect(hrefs[0]).toBe('/guide');
    expect(hrefs.indexOf('/guide')).toBeLessThan(hrefs.indexOf('/changelog'));
  });
});

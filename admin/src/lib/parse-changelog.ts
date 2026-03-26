import type { ReactNode } from 'react';
import { createElement } from 'react';

export interface ChangelogItem {
  title: string;
  description: string;
  isBold: boolean;
}

export interface ChangelogSection {
  name: string;
  items: ChangelogItem[];
}

export interface ChangelogVersion {
  version: string;
  subtitle?: string;
  sections: ChangelogSection[];
}

// Regex patterns hoisted to module scope to avoid recompilation per line
const RE_VERSION = /^## v([\d.]+)/;
const RE_SECTION = /^### (.+)$/;
const RE_BOLD_DASH = /^\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/;
const RE_BOLD = /^\*\*(.+?)\*\*(.*)$/;

/**
 * Parse CHANGELOG.md raw text into structured version data.
 *
 * Supports two formats:
 *   Newer: ## v1.24.6 / ### Section / - **Item** — Description
 *   Older: ## v1.20.0 (2026-02-25) / **Subtitle** / - bullet items (no ### sections)
 *
 * Bullets without a preceding ### section are collected into a fallback "Overview" section.
 */
export function parseChangelog(raw: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  let current: ChangelogVersion | null = null;
  let currentSection: ChangelogSection | null = null;
  let expectSubtitle = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    // Skip empty lines and horizontal rules
    if (trimmed === '' || trimmed === '---') {
      continue;
    }

    // Version header: ## v1.24.6 or ## v1.21.0 (2026-03-02)
    const versionMatch = trimmed.match(RE_VERSION);
    if (versionMatch) {
      current = { version: versionMatch[1], sections: [] };
      versions.push(current);
      currentSection = null;
      expectSubtitle = true;
      continue;
    }

    // Subtitle: **bold text** (first non-empty line after version header)
    if (expectSubtitle && current) {
      expectSubtitle = false;
      if (trimmed.startsWith('**') && trimmed.endsWith('**') && !trimmed.startsWith('### ')) {
        current.subtitle = trimmed.slice(2, -2);
        continue;
      }
    }

    // Section header: ### Added, ### Fixed, etc.
    const sectionMatch = trimmed.match(RE_SECTION);
    if (sectionMatch && current) {
      currentSection = { name: sectionMatch[1], items: [] };
      current.sections.push(currentSection);
      expectSubtitle = false;
      continue;
    }

    // Item: - **Title** — Description (or plain bullet)
    if (trimmed.startsWith('- ') && current) {
      // Create fallback "Overview" section if no ### section is active
      if (!currentSection) {
        currentSection = { name: 'Overview', items: [] };
        current.sections.push(currentSection);
      }

      const itemText = trimmed.slice(2);
      const boldMatch = itemText.match(RE_BOLD_DASH);
      if (boldMatch) {
        currentSection.items.push({ title: boldMatch[1], description: boldMatch[2], isBold: true });
      } else {
        // No em-dash split — treat entire text as title
        const plainBold = itemText.match(RE_BOLD);
        if (plainBold) {
          currentSection.items.push({
            title: plainBold[1],
            description: plainBold[2].trim(),
            isBold: true,
          });
        } else {
          currentSection.items.push({ title: itemText, description: '', isBold: false });
        }
      }
      continue;
    }

    // Bold subheadings in older entries (e.g., **Feature:** or **Changes:**)
    // Treated as a new section within the version
    if (trimmed.startsWith('**') && trimmed.endsWith('**') && current) {
      const heading = trimmed.slice(2, -2).replace(/:$/, '');
      currentSection = { name: heading, items: [] };
      current.sections.push(currentSection);
      continue;
    }

    // Plain paragraph text inside a version (older entries without bullets)
    // Skip table rows, top-level headers, and intro text before any version
    if (current && !trimmed.startsWith('#') && !trimmed.startsWith('|')) {
      if (!currentSection) {
        currentSection = { name: 'Overview', items: [] };
        current.sections.push(currentSection);
      }
      currentSection.items.push({ title: trimmed, description: '', isBold: false });
      continue;
    }

    // Skip any other lines (# header, intro text before versions, table rows)
  }

  return versions;
}

/**
 * Section name → badge colour classes (Blocktree design system).
 */
const SECTION_BADGE_CLASSES: Record<string, string> = {
  added: 'bg-green-100 text-green-700',
  features: 'bg-green-100 text-green-700',
  fixed: 'bg-orange-100 text-orange-700',
  changed: 'bg-blue-100 text-blue-700',
  enhanced: 'bg-blue-100 text-blue-700',
  security: 'bg-red-100 text-red-700',
  dependencies: 'bg-charcoal-50 text-charcoal-700',
  dashboard: 'bg-blue-100 text-blue-600',
  api: 'bg-blue-100 text-blue-600',
  mcp: 'bg-blue-100 text-blue-600',
  tests: 'bg-charcoal-50 text-charcoal-600',
  configuration: 'bg-charcoal-50 text-charcoal-600',
  overview: 'bg-charcoal-50 text-charcoal-600',
};

const DEFAULT_BADGE_CLASSES = 'bg-charcoal-50 text-charcoal-600';

export function getSectionBadgeClasses(sectionName: string): string {
  return SECTION_BADGE_CLASSES[sectionName.toLowerCase()] ?? DEFAULT_BADGE_CLASSES;
}

/**
 * Render text with inline `code` spans as React elements.
 * Splits on backtick pairs and alternates between plain text and <code> elements.
 */
export function renderInlineCode(text: string): ReactNode[] {
  if (!text.includes('`')) {
    return [text];
  }

  const parts = text.split('`');
  const result: ReactNode[] = [];

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue;

    if (i % 2 === 0) {
      // Plain text
      result.push(parts[i]);
    } else {
      // Code span
      result.push(
        createElement(
          'code',
          {
            key: `code-${i}`,
            className: 'rounded bg-muted px-1.5 py-0.5 font-mono text-tiny',
          },
          parts[i],
        ),
      );
    }
  }

  return result;
}

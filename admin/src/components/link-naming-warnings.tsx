import type { LinkNamingIssue } from '@bifrost/shared';
import { TriangleAlert } from 'lucide-react';

/**
 * Advisory link-naming warnings under a link-path field (v1.38.0).
 *
 * Fed by `linkNamingIssues()` from `@bifrost/shared`, so the route dialog and
 * the QR editor say the same thing. Informational only: it never disables a
 * submit — a dated or file-shaped link is a habit to break, not an error.
 */
export function LinkNamingWarnings({
  issues,
}: {
  issues: readonly LinkNamingIssue[];
}): React.ReactElement | null {
  if (issues.length === 0) return null;
  return (
    <ul
      aria-label="Link naming suggestions"
      className="space-y-1 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2"
    >
      {issues.map(issue => (
        <li
          key={`${issue.code}:${issue.token}`}
          className="flex items-start gap-2 font-inter text-xs text-charcoal-700"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  );
}

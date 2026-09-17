import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// =============================================================================
// Query Keys
// =============================================================================

export const changelogKeys = {
  all: ['changelog'] as const,
  markdown: () => ['changelog', 'markdown'] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch the engineering changelog as Markdown.
 *
 * The document is served from the authenticated `GET /api/changelog` route —
 * it is deliberately NOT in the dashboard bundle any more, because the built
 * assets are served with no credential check. It only changes on deploy and is
 * large, so it is cached for the session rather than refetched on every visit.
 */
export function useChangelog() {
  return useQuery({
    queryKey: changelogKeys.markdown(),
    queryFn: () => api.changelog.get(),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

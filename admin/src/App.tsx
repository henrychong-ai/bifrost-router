import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { queryClient } from '@/lib/query-client';
import { AppLayout } from '@/components/layout';
import { FilterProvider } from '@/context';
import { CommandPaletteProvider } from '@/hooks';
import { CommandPalette } from '@/components/command-palette';
import {
  DashboardPage,
  RoutesPage,
  StoragePage,
  QrCodesPage,
  RedirectsPage,
  ViewsPage,
  DownloadsPage,
  ProxyPage,
  AuditPage,
  FeedbackPage,
  ChangelogPage,
  McpPage,
} from '@/pages';
import { Skeleton } from '@/components/ui/skeleton';

// Lazy-loaded: the guide is a big content chunk, split from the main bundle.
// Keep guide.tsx default-exported for React.lazy.
const GuidePage = lazy(() => import('@/pages/guide/guide'));

function GuideFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-5 w-full max-w-3xl" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <FilterProvider>
        <CommandPaletteProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<AppLayout />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/routes" element={<RoutesPage />} />
                <Route path="/storage" element={<StoragePage />} />
                <Route path="/qr-codes" element={<QrCodesPage />} />
                <Route path="/analytics/redirects" element={<RedirectsPage />} />
                <Route path="/analytics/views" element={<ViewsPage />} />
                <Route path="/analytics/downloads" element={<DownloadsPage />} />
                <Route path="/analytics/proxy" element={<ProxyPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/feedback" element={<FeedbackPage />} />
                <Route path="/integrations/mcp" element={<McpPage />} />
                <Route
                  path="/guide"
                  element={
                    <Suspense fallback={<GuideFallback />}>
                      <GuidePage />
                    </Suspense>
                  }
                />
                <Route path="/changelog" element={<ChangelogPage />} />
              </Route>
            </Routes>
            <CommandPalette />
          </BrowserRouter>
          <Toaster />
        </CommandPaletteProvider>
      </FilterProvider>
    </QueryClientProvider>
  );
}

export default App;

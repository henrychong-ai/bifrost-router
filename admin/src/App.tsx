import { lazy, Suspense, type ComponentType } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { queryClient } from '@/lib/query-client';
import { AppLayout } from '@/components/layout';
import { FilterProvider } from '@/context';
import { CommandPaletteProvider } from '@/hooks';
import { CommandPalette } from '@/components/command-palette';
import { Skeleton } from '@/components/ui/skeleton';

function lazyPage(loader: () => Promise<ComponentType>) {
  return lazy(async () => ({ default: await loader() }));
}

// Every page is a route-level chunk. The layout, providers, and command
// palette stay eager; page-only libraries and components load on navigation.
const DashboardPage = lazyPage(async () => (await import('@/pages/dashboard')).DashboardPage);
const RoutesPage = lazyPage(async () => (await import('@/pages/routes')).RoutesPage);
const StoragePage = lazyPage(async () => (await import('@/pages/storage')).StoragePage);
const QrCodesPage = lazyPage(async () => (await import('@/pages/qr-codes')).QrCodesPage);
const RedirectsPage = lazyPage(async () => (await import('@/pages/redirects')).RedirectsPage);
const ViewsPage = lazyPage(async () => (await import('@/pages/views')).ViewsPage);
const DownloadsPage = lazyPage(async () => (await import('@/pages/downloads')).DownloadsPage);
const ProxyPage = lazyPage(async () => (await import('@/pages/proxy')).ProxyPage);
const AuditPage = lazyPage(async () => (await import('@/pages/audit')).AuditPage);
const FeedbackPage = lazyPage(async () => (await import('@/pages/feedback')).FeedbackPage);
const McpPage = lazyPage(async () => (await import('@/pages/mcp')).McpPage);
const GuidePage = lazyPage(async () => (await import('@/pages/guide/guide')).default);
const ChangelogPage = lazyPage(async () => (await import('@/pages/changelog')).ChangelogPage);

function PageFallback() {
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
            <Suspense fallback={<PageFallback />}>
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
                  <Route path="/guide" element={<GuidePage />} />
                  <Route path="/changelog" element={<ChangelogPage />} />
                </Route>
              </Routes>
            </Suspense>
            <CommandPalette />
          </BrowserRouter>
          <Toaster />
        </CommandPaletteProvider>
      </FilterProvider>
    </QueryClientProvider>
  );
}

export default App;

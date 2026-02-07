import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { queryClient } from '@/lib/query-client';
import { AppLayout } from '@/components/layout';
import { FilterProvider } from '@/context';
import { CommandPaletteProvider } from '@/hooks';
import { CommandPalette } from '@/components/command-palette';
import { DashboardPage, RoutesPage, RedirectsPage, ViewsPage, DownloadsPage, ProxyPage, AuditPage } from '@/pages';

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
                <Route path="/analytics/redirects" element={<RedirectsPage />} />
                <Route path="/analytics/views" element={<ViewsPage />} />
                <Route path="/analytics/downloads" element={<DownloadsPage />} />
                <Route path="/analytics/proxy" element={<ProxyPage />} />
                <Route path="/audit" element={<AuditPage />} />
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

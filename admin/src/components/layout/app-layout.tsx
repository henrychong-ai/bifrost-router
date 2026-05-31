import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { MessageSquarePlus } from 'lucide-react';
import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar';
import { AppSidebar } from './app-sidebar';
import { TailscaleIdentity } from './tailscale-identity';
import { CommandPaletteTrigger } from '@/components/command-palette';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { FeedbackDialog } from '@/components/feedback-dialog';
import { openFeedbackDialog } from '@/lib/feedback-dialog';

export function AppLayout() {
  // Global Cmd+/ (Ctrl+/ on non-mac) opens the feedback dialog from anywhere —
  // including while another modal is open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        void openFeedbackDialog('shortcut');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex-1" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openFeedbackDialog('header')}
            title="Send feedback (⌘/)"
            aria-label="Send feedback"
          >
            <MessageSquarePlus className="size-4" />
            <span className="hidden sm:inline">Feedback</span>
          </Button>
          <CommandPaletteTrigger />
          <TailscaleIdentity />
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </SidebarInset>

      {/* Single shared feedback dialog — opened via openFeedbackDialog() from the
          header pill, the global ⌘/ shortcut, the sidebar link, or the feedback page. */}
      <FeedbackDialog />
    </SidebarProvider>
  );
}

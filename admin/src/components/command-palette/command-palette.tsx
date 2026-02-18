import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  LayoutDashboard,
  Route,
  ArrowUpRight,
  Eye,
  Download,
  Globe,
  ClipboardList,
  Plus,
  Search,
} from 'lucide-react';
import { useCommandPalette } from '@/hooks/use-command-palette';
import {
  useKeyboardShortcut,
  getModifierKey,
} from '@/hooks/use-keyboard-shortcuts';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';

interface CommandItemType {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut?: string;
  action: () => void;
  group: 'navigation' | 'analytics' | 'actions';
}

export function CommandPalette() {
  const { isOpen, close, toggle } = useCommandPalette();
  const navigate = useNavigate();

  useKeyboardShortcut('k', toggle, { modifiers: ['cmd'], ignoreInputs: false });

  const commands: CommandItemType[] = useMemo(
    () => [
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: LayoutDashboard,
        action: () => navigate('/'),
        group: 'navigation',
      },
      {
        id: 'routes',
        label: 'Routes',
        icon: Route,
        action: () => navigate('/routes'),
        group: 'navigation',
      },
      {
        id: 'audit',
        label: 'Audit',
        icon: ClipboardList,
        action: () => navigate('/audit'),
        group: 'navigation',
      },
      {
        id: 'redirects',
        label: 'Redirects',
        icon: ArrowUpRight,
        action: () => navigate('/analytics/redirects'),
        group: 'analytics',
      },
      {
        id: 'views',
        label: 'Views',
        icon: Eye,
        action: () => navigate('/analytics/views'),
        group: 'analytics',
      },
      {
        id: 'downloads',
        label: 'Downloads',
        icon: Download,
        action: () => navigate('/analytics/downloads'),
        group: 'analytics',
      },
      {
        id: 'proxy',
        label: 'Proxy',
        icon: Globe,
        action: () => navigate('/analytics/proxy'),
        group: 'analytics',
      },
      {
        id: 'create-route',
        label: 'Create New Route',
        icon: Plus,
        shortcut: 'N',
        action: () => {
          navigate('/routes');
          setTimeout(() => {
            const createButton = document.querySelector(
              '[data-create-route-trigger]',
            );
            if (createButton instanceof HTMLElement) {
              createButton.click();
            }
          }, 100);
        },
        group: 'actions',
      },
      {
        id: 'focus-search',
        label: 'Focus Search',
        icon: Search,
        shortcut: '/',
        action: () => {
          const searchInput = document.querySelector('[data-search-input]');
          if (searchInput instanceof HTMLInputElement) {
            searchInput.focus();
          }
        },
        group: 'actions',
      },
    ],
    [navigate],
  );

  const handleSelect = useCallback(
    (commandId: string) => {
      const command = commands.find(c => c.id === commandId);
      if (command) {
        close();
        command.action();
      }
    },
    [commands, close],
  );

  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          close();
        }
      };
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, close]);

  const navigationCommands = commands.filter(c => c.group === 'navigation');
  const analyticsCommands = commands.filter(c => c.group === 'analytics');
  const actionCommands = commands.filter(c => c.group === 'actions');

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && close()}>
      <DialogContent className="overflow-hidden p-0 max-w-lg">
        <Command className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4">
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Command.Input
              placeholder="Type a command or search..."
              className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden p-2">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </Command.Empty>

            {navigationCommands.length > 0 && (
              <Command.Group heading="Navigation" className="px-1 py-1.5">
                {navigationCommands.map(command => (
                  <CommandItem
                    key={command.id}
                    command={command}
                    onSelect={handleSelect}
                  />
                ))}
              </Command.Group>
            )}

            {analyticsCommands.length > 0 && (
              <Command.Group heading="Analytics" className="px-1 py-1.5">
                {analyticsCommands.map(command => (
                  <CommandItem
                    key={command.id}
                    command={command}
                    onSelect={handleSelect}
                  />
                ))}
              </Command.Group>
            )}

            {actionCommands.length > 0 && (
              <Command.Group heading="Actions" className="px-1 py-1.5">
                {actionCommands.map(command => (
                  <CommandItem
                    key={command.id}
                    command={command}
                    onSelect={handleSelect}
                  />
                ))}
              </Command.Group>
            )}
          </Command.List>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Navigate</span>
              <div className="flex gap-1">
                <Kbd size="sm">↑</Kbd>
                <Kbd size="sm">↓</Kbd>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span>Select</span>
              <Kbd size="sm">↵</Kbd>
            </div>
            <div className="flex items-center gap-2">
              <span>Close</span>
              <Kbd size="sm">Esc</Kbd>
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandItem({
  command,
  onSelect,
}: {
  command: CommandItemType;
  onSelect: (id: string) => void;
}) {
  const Icon = command.icon;

  return (
    <Command.Item
      value={command.id}
      onSelect={() => onSelect(command.id)}
      className="relative flex cursor-pointer select-none items-center rounded-md px-2 py-2 text-sm outline-none aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
      <span className="font-medium">{command.label}</span>
      {command.shortcut && (
        <Kbd size="sm" className="ml-auto">
          {command.shortcut}
        </Kbd>
      )}
    </Command.Item>
  );
}

export function CommandPaletteTrigger() {
  const { open } = useCommandPalette();
  const modKey = getModifierKey();

  return (
    <button
      onClick={open}
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Search</span>
      <div className="hidden sm:flex items-center gap-0.5 ml-1">
        <Kbd size="sm">{modKey}</Kbd>
        <Kbd size="sm">K</Kbd>
      </div>
    </button>
  );
}

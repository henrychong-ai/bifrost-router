import { cn } from '@/lib/utils';

interface KbdProps {
  children: React.ReactNode;
  className?: string;
  size?: 'sm' | 'md';
}

export function Kbd({ children, className, size = 'md' }: KbdProps) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex select-none items-center justify-center gap-1 rounded border font-mono font-medium',
        size === 'sm' &&
          'h-5 min-w-5 px-1 text-[10px] border-border bg-muted/50 text-muted-foreground',
        size === 'md' &&
          'h-6 min-w-6 px-1.5 text-[11px] border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

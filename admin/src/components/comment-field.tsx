import { MessageSquareText } from 'lucide-react';
import { COMMENT_MAX_LENGTH } from '@bifrost/shared';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Format a Unix-seconds timestamp as a coarse relative time (e.g. "3h ago").
 * Inlined here — the comment indicator only needs a compact, approximate hint.
 */
function formatRelativeTime(unixSeconds: number): string {
  const deltaSeconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (deltaSeconds < 60) return 'just now';
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Reusable free-text comment / note editor. Used by the storage upload/edit
 * dialogs so the field looks and behaves identically everywhere: multi-line
 * plain text, a hard character cap, and a live counter that recolours as it
 * approaches the limit.
 */
export function CommentTextarea({
  id = 'comments',
  value,
  onChange,
  disabled = false,
  label = 'Comments / Notes',
  placeholder = 'Optional note — e.g. why this exists, who to ask before changing it',
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
}): React.ReactElement {
  const length = value.length;
  const nearLimit = length >= COMMENT_MAX_LENGTH * 0.9;
  const atLimit = length >= COMMENT_MAX_LENGTH;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={COMMENT_MAX_LENGTH}
        rows={3}
        className="resize-y text-sm"
      />
      <span
        className={`self-end font-mono text-xs ${
          atLimit ? 'text-red-600' : nearLimit ? 'text-amber-600' : 'text-muted-foreground'
        }`}
      >
        {length}/{COMMENT_MAX_LENGTH}
      </span>
    </div>
  );
}

/**
 * At-a-glance note indicator for list rows (storage), mirroring the Cloudflare
 * DNS record-comment pattern: a small icon shown only when a comment exists,
 * with the full text on hover.
 */
export function CommentIndicator({
  comment,
  updatedBy,
  updatedAt,
  className,
}: {
  comment: string;
  updatedBy?: string | null;
  updatedAt?: number | null;
  className?: string;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={className ?? 'text-muted-foreground inline-flex'}
          aria-label="Has a comment"
          data-testid="comment-indicator"
        >
          <MessageSquareText className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="text-xs break-words whitespace-pre-wrap">{comment}</p>
        {(updatedBy || updatedAt) && (
          <p className="text-muted-foreground mt-1 text-[10px]">
            {updatedBy ? `edited by ${updatedBy}` : 'edited'}
            {updatedAt ? ` · ${formatRelativeTime(updatedAt)}` : ''}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

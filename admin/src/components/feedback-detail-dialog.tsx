import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  type FeedbackCaptureBundle,
  type FeedbackSeverity,
  type FeedbackStatus,
  type FeedbackType,
  type TriageFeedbackInput,
} from '@bifrost/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { useDeleteFeedback, useFeedbackItem, useTriageFeedback } from '@/hooks/use-feedback';

const PRIORITY_LABELS = ['none', 'urgent', 'high', 'medium', 'low'];

export function FeedbackDetailDialog({
  id,
  open,
  onOpenChange,
}: {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: item, isLoading } = useFeedbackItem(open ? id : null);
  const triage = useTriageFeedback();
  const del = useDeleteFeedback();

  const [patch, setPatch] = useState<TriageFeedbackInput>({});
  const [shots, setShots] = useState<string[]>([]);
  const [capture, setCapture] = useState<FeedbackCaptureBundle | null>(null);

  // Reset the working patch when a new item loads.
  useEffect(() => {
    setPatch({});
  }, [item?.id]);

  // Load attachments (screenshots + capture bundle) as object URLs.
  useEffect(() => {
    if (!open || !item) {
      setShots([]);
      setCapture(null);
      return;
    }
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      const loaded: string[] = [];
      for (const key of item.screenshotKeys) {
        try {
          const blob = await api.feedback.attachment(item.id, key);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          loaded.push(url);
        } catch {
          /* skip a broken attachment */
        }
      }
      if (!cancelled) setShots(loaded);
      if (item.captureKey) {
        try {
          const blob = await api.feedback.attachment(item.id, item.captureKey);
          const parsed = JSON.parse(await blob.text()) as FeedbackCaptureBundle;
          if (!cancelled) setCapture(parsed);
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach(u => URL.revokeObjectURL(u));
    };
  }, [open, item]);

  const field = <K extends keyof TriageFeedbackInput>(
    key: K,
  ): TriageFeedbackInput[K] | undefined => {
    if (key in patch) return patch[key];
    return item ? (item[key as keyof typeof item] as TriageFeedbackInput[K]) : undefined;
  };
  const set = <K extends keyof TriageFeedbackInput>(key: K, value: TriageFeedbackInput[K]) =>
    setPatch(p => ({ ...p, [key]: value }));

  const handleSave = async () => {
    if (!item) return;
    try {
      await triage.mutateAsync({ id: item.id, patch });
      toast.success(`Feedback ${item.shortId} updated`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    if (!window.confirm(`Delete feedback ${item.shortId}? This also removes its screenshots.`)) {
      return;
    }
    try {
      await del.mutateAsync(item.id);
      toast.success(`Feedback ${item.shortId} deleted`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-inter font-semibold text-blue-950">
            {item ? `${item.shortId} — ${item.title}` : 'Feedback'}
          </DialogTitle>
          <DialogDescription className="font-inter">
            {item ? `Submitted by ${item.submitterEmail ?? '—'} · ${item.createdAt}` : 'Loading…'}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !item ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            {/* Description + structured fields */}
            <div className="space-y-2">
              <p className="font-inter text-sm whitespace-pre-wrap">{item.description}</p>
              {item.steps && (
                <p className="font-inter text-sm">
                  <span className="font-medium">Steps:</span> {item.steps}
                </p>
              )}
              {item.expected && (
                <p className="font-inter text-sm">
                  <span className="font-medium">Expected:</span> {item.expected}
                </p>
              )}
              {item.actual && (
                <p className="font-inter text-sm">
                  <span className="font-medium">Actual:</span> {item.actual}
                </p>
              )}
            </div>

            {/* Screenshots */}
            {shots.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {shots.map(url => (
                  <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={url}
                      alt="screenshot"
                      className="h-28 rounded-sm border object-cover"
                    />
                  </a>
                ))}
              </div>
            )}

            {/* Context */}
            {item.context && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="mb-1 font-inter text-tiny font-semibold text-muted-foreground uppercase">
                  Context
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {item.context.url && (
                    <Badge variant="outline" className="font-mono text-tiny">
                      {item.context.route ?? item.context.url}
                    </Badge>
                  )}
                  {item.context.browser && (
                    <Badge variant="outline" className="text-tiny">
                      {item.context.browser}
                      {item.context.os ? ` / ${item.context.os}` : ''}
                    </Badge>
                  )}
                  {item.context.appVersion && (
                    <Badge variant="outline" className="text-tiny">
                      v{item.context.appVersion}
                    </Badge>
                  )}
                  {item.context.rayId && (
                    <Badge variant="outline" className="font-mono text-tiny">
                      ray {item.context.rayId}
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {/* Capture bundle */}
            {capture && (capture.console.length > 0 || capture.network.length > 0) && (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-inter text-sm font-medium">
                  Console &amp; network ({capture.console.length} log
                  {capture.console.length === 1 ? '' : 's'}, {capture.network.length} network)
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded-sm bg-muted/50 p-2 font-mono text-tiny">
                  {[
                    ...capture.console.map(e => `[${e.level}] ${e.message}`),
                    ...capture.network.map(e => `${e.status} ${e.method} ${e.url}`),
                  ].join('\n')}
                </pre>
              </details>
            )}

            {/* Triage controls */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-inter">Status</Label>
                <Select
                  value={field('status') as string | undefined}
                  onValueChange={v => set('status', v as FeedbackStatus)}
                >
                  <SelectTrigger className="font-inter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEEDBACK_STATUSES.map(s => (
                      <SelectItem key={s} value={s} className="font-inter">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Priority</Label>
                <Select
                  value={String(field('priority') ?? 0)}
                  onValueChange={v => set('priority', Number(v))}
                >
                  <SelectTrigger className="font-inter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_LABELS.map((label, i) => (
                      <SelectItem key={i} value={String(i)} className="font-inter">
                        {i} — {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Type</Label>
                <Select
                  value={field('type') as string | undefined}
                  onValueChange={v => set('type', v as FeedbackType)}
                >
                  <SelectTrigger className="font-inter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FEEDBACK_TYPES.map(t => (
                      <SelectItem key={t} value={t} className="font-inter">
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Severity</Label>
                <Select
                  value={(field('severity') as string | undefined) || undefined}
                  onValueChange={v => set('severity', v as FeedbackSeverity)}
                >
                  <SelectTrigger className="font-inter">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {FEEDBACK_SEVERITIES.map(s => (
                      <SelectItem key={s} value={s} className="font-inter">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Area</Label>
                <Input
                  value={(field('area') as string | null) ?? ''}
                  onChange={e => set('area', e.target.value)}
                  placeholder="routes, storage, …"
                  className="font-inter"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Assignee</Label>
                <Input
                  value={(field('assignee') as string | null) ?? ''}
                  onChange={e => set('assignee', e.target.value)}
                  placeholder="ai-agent, name…"
                  className="font-inter"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Labels</Label>
                <Input
                  value={(field('labels') as string | null) ?? ''}
                  onChange={e => set('labels', e.target.value)}
                  className="font-inter"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-inter">Linked PR</Label>
                <Input
                  value={(field('linkedPr') as string | null) ?? ''}
                  onChange={e => set('linkedPr', e.target.value)}
                  className="font-inter"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="font-inter">Triage notes</Label>
              <Textarea
                value={(field('triageNotes') as string | null) ?? ''}
                onChange={e => set('triageNotes', e.target.value)}
                rows={3}
                className="font-inter"
              />
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={handleDelete}
            disabled={!item || del.isPending}
            className="font-inter text-red-600 hover:text-red-700"
          >
            <Trash2 className="mr-1.5 size-3.5" />
            Delete
          </Button>
          <div className="flex gap-2">
            {item?.linkedPr && /^https?:\/\//i.test(item.linkedPr) ? (
              <Button asChild variant="outline" className="font-inter">
                <a href={item.linkedPr} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 size-3.5" />
                  PR
                </a>
              </Button>
            ) : (
              item?.linkedPr && (
                <span className="font-inter text-sm text-muted-foreground">{item.linkedPr}</span>
              )
            )}
            <Button
              type="button"
              onClick={handleSave}
              disabled={!item || triage.isPending}
              className="bg-blue-950 font-inter hover:bg-blue-900"
            >
              {triage.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

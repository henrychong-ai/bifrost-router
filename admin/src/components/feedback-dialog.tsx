import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Bug,
  HelpCircle,
  Lightbulb,
  type LucideIcon,
  MessageSquare,
  Paperclip,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  FEEDBACK_MAX_SCREENSHOTS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_TYPES,
  type FeedbackSeverity,
  type FeedbackType,
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
import { cn } from '@/lib/utils';
import { useSubmitFeedback } from '@/hooks/use-feedback';
import { buildFeedbackContext, getCaptureBundle } from '@/lib/capture';
import {
  FEEDBACK_OPEN_EVENT,
  type FeedbackOpenDetail,
  setFeedbackDialogOpen,
} from '@/lib/feedback-dialog';

const TYPE_META: Record<FeedbackType, { label: string; icon: LucideIcon; placeholder: string }> = {
  bug: {
    label: 'Bug',
    icon: Bug,
    placeholder: 'What went wrong? What did you expect to happen instead?',
  },
  feature: {
    label: 'Feature',
    icon: Lightbulb,
    placeholder: 'What would you like to see, and what problem would it solve?',
  },
  question: { label: 'Question', icon: HelpCircle, placeholder: 'What would you like to know?' },
  other: { label: 'Other', icon: MessageSquare, placeholder: "Tell us what's on your mind." },
};

const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp';

interface Attachment {
  blob: Blob;
  url: string;
  /** The auto-captured page screenshot (vs a manually attached file). */
  auto: boolean;
  name: string;
}

const ACCEPTED_IMAGE_TYPE_SET = new Set(ACCEPTED_IMAGE_TYPES.split(','));

/**
 * Build an Attachment from a Blob/File: reject anything whose MIME type is not
 * in the accepted-image set, then assert the generated object URL uses the
 * `blob:` scheme before storing it. Defense-in-depth — the file input's
 * `accept=` is only a picker hint, not validation. Returns null if rejected.
 */
function makeAttachment(blob: Blob, auto: boolean, name: string): Attachment | null {
  if (!ACCEPTED_IMAGE_TYPE_SET.has(blob.type)) return null;
  const url = URL.createObjectURL(blob);
  if (!url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
    return null;
  }
  return { blob, url, auto, name };
}

export function FeedbackDialog() {
  const location = useLocation();
  const submit = useSubmitFeedback();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<Attachment[]>([]);

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<FeedbackSeverity | ''>('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  const [submitterName, setSubmitterName] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const reset = useCallback(() => {
    setType('bug');
    setTitle('');
    setDescription('');
    setSeverity('');
    setSubmitterEmail('');
    setSubmitterName('');
    setAttachments(prev => {
      prev.forEach(a => URL.revokeObjectURL(a.url));
      return [];
    });
  }, []);

  // Open on the global event (header button / in-dialog button / shortcut).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<FeedbackOpenDetail>).detail;
      reset();
      if (detail?.screenshot) {
        const blob = detail.screenshot;
        const screenshot = makeAttachment(blob, true, 'page-screenshot.png');
        if (screenshot) setAttachments([screenshot]);
      }
      setType('bug');
      setOpen(true);
    };
    window.addEventListener(FEEDBACK_OPEN_EVENT, handler);
    return () => window.removeEventListener(FEEDBACK_OPEN_EVENT, handler);
  }, [reset]);

  // Keep a ref of the latest attachments so the unmount cleanup revokes the
  // current set (not a stale closure).
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Revoke any outstanding object URLs on unmount.
  useEffect(() => {
    return () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.url);
    };
  }, []);

  // Keep the re-entrancy guard synced to the dialog's real open state, and
  // release it on unmount so the guard can't wedge `true` across a remount.
  useEffect(() => {
    setFeedbackDialogOpen(open);
    return () => setFeedbackDialogOpen(false);
  }, [open]);

  const removeAttachment = (idx: number) => {
    setAttachments(prev => {
      const next = [...prev];
      const [removed] = next.splice(idx, 1);
      if (removed) URL.revokeObjectURL(removed.url);
      return next;
    });
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setAttachments(prev => {
      const room = FEEDBACK_MAX_SCREENSHOTS - prev.length;
      const added = files
        .slice(0, Math.max(room, 0))
        .map(f => makeAttachment(f, false, f.name))
        .filter((a): a is Attachment => a !== null);
      return [...prev, ...added];
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !submit.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const fd = new FormData();
    fd.append('type', type);
    fd.append('title', title.trim());
    fd.append('description', description.trim());
    if (severity) fd.append('severity', severity);
    if (submitterEmail.trim()) fd.append('submitterEmail', submitterEmail.trim());
    if (submitterName.trim()) fd.append('submitterName', submitterName.trim());
    fd.append('context', JSON.stringify(buildFeedbackContext(location.pathname)));
    fd.append('capture', JSON.stringify(getCaptureBundle()));
    attachments.slice(0, FEEDBACK_MAX_SCREENSHOTS).forEach((a, i) => {
      const ext =
        a.blob.type === 'image/jpeg' ? 'jpg' : a.blob.type === 'image/webp' ? 'webp' : 'png';
      fd.append('screenshot', a.blob, a.name || `screenshot-${i}.${ext}`);
    });

    try {
      const item = await submit.mutateAsync(fd);
      toast.success(`Thanks — feedback ${item.shortId} logged`);
      setOpen(false);
      reset();
    } catch (err) {
      toast.error(
        `Couldn't send feedback: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const placeholder = useMemo(() => TYPE_META[type].placeholder, [type]);

  return (
    <Dialog
      open={open}
      onOpenChange={o => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      {/* z-[60] stacks the feedback dialog above other open modals. */}
      <DialogContent className="z-[60] max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-inter font-semibold text-blue-950">
            Send feedback
          </DialogTitle>
          <DialogDescription className="font-inter">
            Report a bug, request a feature, or ask a question. We attach a screenshot of this page,
            recent console/network activity, and your browser details to help us debug.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type — segmented selector */}
          <div className="space-y-1.5">
            <Label className="font-inter">Type</Label>
            <div className="grid grid-cols-4 gap-2">
              {FEEDBACK_TYPES.map(t => {
                const meta = TYPE_META[t];
                const Icon = meta.icon;
                const active = type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    aria-pressed={active}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-md border p-2 font-inter text-tiny transition-colors',
                      active
                        ? 'border-blue-950 bg-blue-950 text-white'
                        : 'border-input bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <Icon className="size-4" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="feedback-title" className="font-inter">
              Title
            </Label>
            <Input
              id="feedback-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={200}
              placeholder="A short summary"
              className="font-inter"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="feedback-description" className="font-inter">
              Description
            </Label>
            <Textarea
              id="feedback-description"
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={5000}
              rows={5}
              placeholder={placeholder}
              className="font-inter"
            />
          </div>

          {/* Severity (optional) */}
          <div className="space-y-1.5">
            <Label className="font-inter">Severity (optional)</Label>
            <Select
              value={severity || undefined}
              onValueChange={v => setSeverity(v as FeedbackSeverity)}
            >
              <SelectTrigger className="font-inter">
                <SelectValue placeholder="How badly is it affecting you?" />
              </SelectTrigger>
              {/* Above the feedback dialog's own z-[60] content (Select defaults to z-50). */}
              <SelectContent className="z-[70]">
                {FEEDBACK_SEVERITIES.map(s => (
                  <SelectItem key={s} value={s} className="font-inter capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Optional submitter metadata (free text — NOT an identity claim) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="feedback-submitter-name" className="font-inter">
                Your name (optional)
              </Label>
              <Input
                id="feedback-submitter-name"
                value={submitterName}
                onChange={e => setSubmitterName(e.target.value)}
                maxLength={320}
                placeholder="Name"
                className="font-inter"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="feedback-submitter-email" className="font-inter">
                Your email (optional)
              </Label>
              <Input
                id="feedback-submitter-email"
                type="email"
                value={submitterEmail}
                onChange={e => setSubmitterEmail(e.target.value)}
                maxLength={320}
                placeholder="you@example.com"
                className="font-inter"
              />
            </div>
          </div>

          {/* Attachments */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="font-inter">
                Screenshots ({attachments.length}/{FEEDBACK_MAX_SCREENSHOTS})
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={attachments.length >= FEEDBACK_MAX_SCREENSHOTS}
                onClick={() => fileInputRef.current?.click()}
                className="font-inter"
              >
                <Paperclip className="mr-1.5 size-3.5" />
                Attach
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES}
                multiple
                hidden
                onChange={onPickFiles}
              />
            </div>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div key={a.url} className="group relative">
                    <img
                      src={a.url}
                      alt={a.auto ? 'Page screenshot' : a.name}
                      className="size-16 rounded-sm border object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="absolute -top-1.5 -right-1.5 rounded-full bg-blue-950 p-0.5 text-white opacity-90"
                      aria-label="Remove screenshot"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="font-inter"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-blue-950 font-inter hover:bg-blue-900"
            >
              {submit.isPending ? 'Sending…' : 'Send feedback'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

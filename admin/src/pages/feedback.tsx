import { useState } from 'react';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  type FeedbackItem,
  type FeedbackStatus,
  type FeedbackType,
} from '@bifrost/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFeedbackList } from '@/hooks/use-feedback';
import { openFeedbackDialog } from '@/lib/feedback-dialog';
import { FeedbackDetailDialog } from '@/components/feedback-detail-dialog';

const STATUS_COLORS: Record<FeedbackStatus, string> = {
  new: 'bg-blue-100 text-blue-800 border-blue-200',
  triaged: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-200',
  resolved: 'bg-green-100 text-green-800 border-green-200',
  wontfix: 'bg-stone-100 text-stone-800 border-stone-200',
  duplicate: 'bg-stone-100 text-stone-800 border-stone-200',
};

function StatusBadge({ status }: { status: FeedbackStatus }) {
  return (
    <Badge variant="outline" className={`${STATUS_COLORS[status]} font-inter`}>
      {status.replace('_', ' ')}
    </Badge>
  );
}

function TriageQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState<FeedbackStatus | 'all'>('all');
  const [type, setType] = useState<FeedbackType | 'all'>('all');
  const { data, isLoading } = useFeedbackList({
    status: status === 'all' ? undefined : status,
    type: type === 'all' ? undefined : type,
  });

  const items: FeedbackItem[] = data?.feedback ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select value={status} onValueChange={v => setStatus(v as FeedbackStatus | 'all')}>
          <SelectTrigger className="w-40 font-inter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="font-inter">
              All statuses
            </SelectItem>
            {FEEDBACK_STATUSES.map(s => (
              <SelectItem key={s} value={s} className="font-inter">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={v => setType(v as FeedbackType | 'all')}>
          <SelectTrigger className="w-40 font-inter">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="font-inter">
              All types
            </SelectItem>
            {FEEDBACK_TYPES.map(t => (
              <SelectItem key={t} value={t} className="font-inter">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-10 text-center font-inter text-sm text-muted-foreground">
          No feedback matches these filters.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="font-inter">Ref</TableHead>
                <TableHead className="font-inter">Title</TableHead>
                <TableHead className="font-inter">Type</TableHead>
                <TableHead className="font-inter">Priority</TableHead>
                <TableHead className="font-inter">Status</TableHead>
                <TableHead className="font-inter">Submitter</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(it => (
                <TableRow
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(it.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(it.id);
                    }
                  }}
                  className="cursor-pointer"
                >
                  <TableCell className="font-mono text-tiny">{it.shortId}</TableCell>
                  <TableCell className="max-w-xs truncate font-inter">{it.title}</TableCell>
                  <TableCell className="font-inter">{it.type}</TableCell>
                  <TableCell className="font-inter">{it.priority}</TableCell>
                  <TableCell>
                    <StatusBadge status={it.status} />
                  </TableCell>
                  <TableCell className="font-inter text-tiny text-muted-foreground">
                    {it.submitterEmail ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function FeedbackPage() {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const openDetail = (id: string) => {
    setDetailId(id);
    setDetailOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-inter text-huge font-bold text-blue-950">Feedback</h1>
          <p className="font-inter text-sm text-muted-foreground">
            Report a bug, request a feature, or ask a question.
          </p>
        </div>
        <Button
          onClick={() => void openFeedbackDialog('feedback-page')}
          className="bg-blue-950 font-inter hover:bg-blue-900"
        >
          <MessageSquarePlus className="mr-1.5 size-4" />
          Send feedback
        </Button>
      </div>

      <TriageQueue onOpen={openDetail} />

      <FeedbackDetailDialog id={detailId} open={detailOpen} onOpenChange={setDetailOpen} />
    </div>
  );
}

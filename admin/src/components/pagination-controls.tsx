import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PAGE_SIZE_OPTIONS } from '@/lib/constants';

interface PaginationControlsProps {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  onOffsetChange: (offset: number) => void;
  onLimitChange: (limit: number) => void;
}

export function PaginationControls({
  offset,
  limit,
  total,
  hasMore,
  onOffsetChange,
  onLimitChange,
}: PaginationControlsProps) {
  if (total === 0) return null;

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  if (offset >= total && total > 0) {
    const lastValidPage = Math.max(0, totalPages - 1);
    onOffsetChange(lastValidPage * limit);
  }

  return (
    <div className="mt-4 flex items-center justify-between border-t border-border/30 pt-4">
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">
          Showing {offset + 1} - {Math.min(offset + limit, total)} of {total}
        </span>
        <span className="text-sm text-muted-foreground">
          Page {currentPage} of {totalPages}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Select value={String(limit)} onValueChange={value => onLimitChange(Number(value))}>
          <SelectTrigger className="w-[70px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map(size => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          disabled={offset === 0}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOffsetChange(offset + limit)}
          disabled={!hasMore}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PAGE_SIZE_OPTIONS, persistPageSize } from '@/lib/constants';
import { ChevronLeft, ChevronRight } from 'lucide-react';

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
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + limit, total);

  const handleLimitChange = (value: string) => {
    const newLimit = Number(value);
    persistPageSize(newLimit);
    onLimitChange(newLimit);
  };

  return (
    <div className="flex items-center justify-between pt-4">
      <div className="text-sm text-muted-foreground font-gilroy">
        Showing {start}-{end} of {total}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground font-gilroy">Per page</span>
          <Select value={String(limit)} onValueChange={handleLimitChange}>
            <SelectTrigger className="w-20 h-8 font-gilroy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map(size => (
                <SelectItem key={size} value={String(size)} className="font-gilroy">
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={offset === 0}
            onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={!hasMore}
            onClick={() => onOffsetChange(offset + limit)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

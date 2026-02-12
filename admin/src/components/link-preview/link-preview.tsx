import { ExternalLink, Loader2 } from 'lucide-react';
import { useLinkPreview } from '@/hooks/use-link-preview';

interface LinkPreviewProps {
  url: string;
  enabled?: boolean;
}

export function LinkPreview({ url, enabled = true }: LinkPreviewProps) {
  const { data, isLoading, error } = useLinkPreview(url, { enabled });

  const isValidUrl = url.startsWith('http://') || url.startsWith('https://');

  if (!isValidUrl || !enabled) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Loading preview...</span>
      </div>
    );
  }

  if (error || !data) {
    return null;
  }

  const hasContent = data.title || data.description || data.image;

  if (!hasContent) {
    return null;
  }

  return (
    <div className="mt-2 rounded-lg border bg-muted/30 overflow-hidden">
      <div className="flex">
        {data.image && (
          <div className="shrink-0 w-24 h-20 overflow-hidden bg-muted">
            <img
              src={data.image}
              alt=""
              className="h-full w-full object-cover"
              onError={e => {
                e.currentTarget.parentElement!.style.display = 'none';
              }}
            />
          </div>
        )}
        <div className="flex-1 p-2.5 min-w-0">
          {data.title && <h4 className="font-medium text-sm truncate">{data.title}</h4>}
          {data.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{data.description}</p>
          )}
          <div className="flex items-center gap-1 mt-1.5 text-xs text-muted-foreground">
            <ExternalLink className="h-3 w-3" />
            <span className="truncate font-mono">{data.siteName || new URL(url).hostname}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

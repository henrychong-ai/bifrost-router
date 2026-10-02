import { useQuery } from '@tanstack/react-query';
import { metadataApi, type OpenGraphData } from '@/lib/api-client';
import { useDebounce } from './use-debounce';

interface UseLinkPreviewOptions {
  enabled?: boolean;
  debounceMs?: number;
}

export function useLinkPreview(url: string, options: UseLinkPreviewOptions = {}) {
  const { enabled = true, debounceMs = 500 } = options;

  const debouncedUrl = useDebounce(url, debounceMs);

  const isValidUrl = debouncedUrl.startsWith('http://') || debouncedUrl.startsWith('https://');

  return useQuery<OpenGraphData>({
    queryKey: ['link-preview', debouncedUrl],
    queryFn: () => metadataApi.getOpenGraph(debouncedUrl),
    enabled: enabled && isValidUrl && debouncedUrl.length > 0,
    staleTime: 1000 * 60 * 60, // 1 hour
    gcTime: 1000 * 60 * 60, // 1 hour
    retry: false,
  });
}

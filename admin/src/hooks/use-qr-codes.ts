import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api, type QrQueryParams } from '@/lib/api-client';

// =============================================================================
// Query Keys
// =============================================================================

export const qrKeys = {
  all: ['qr'] as const,
  list: (params?: QrQueryParams) => ['qr', { ...params }] as const,
  detail: (id: string) => ['qr', 'detail', id] as const,
};

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch QR codes with server-side filtering + pagination (mirrors useRoutes).
 * `options.enabled` gates the fetch (v1.58.0 — the routes-page Save-as-QR
 * dedup guard only needs the list while its dialog is open).
 */
export function useQrCodes(params?: QrQueryParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qrKeys.list(params),
    queryFn: () => api.qr.list(params),
    placeholderData: keepPreviousData,
    enabled: options?.enabled ?? true,
  });
}

// =============================================================================
// Mutations — invalidate the list; pages own the toasts (routes-page idiom)
// =============================================================================

export function useCreateQr() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, domain }: { input: Record<string, unknown>; domain?: string }) =>
      api.qr.create(input, domain),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qrKeys.all }),
  });
}

export function useUpdateQr() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
      domain,
    }: {
      id: string;
      input: Record<string, unknown>;
      domain?: string;
    }) => api.qr.update(id, input, domain),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qrKeys.all }),
  });
}

export function useDeleteQr() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, domain }: { id: string; domain?: string }) => api.qr.delete(id, domain),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qrKeys.all }),
  });
}

import type { QRCode } from '@bifrost/shared';
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, type QrQueryParams } from '@/lib/api-client';
import { type PendingQrStore, pendingQrs, type QrListPage } from '@/lib/qr-pending';

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
 * One list page, with codes created in this session merged in until the
 * server lists them (see lib/qr-pending.ts). The merge happens here,
 * in the fetch, so no cached list is ever patched and marked fresh.
 */
export async function fetchQrList(
  params: QrQueryParams | undefined,
  store: PendingQrStore = pendingQrs,
): Promise<QrListPage> {
  return store.merge(params, await api.qr.list(params));
}

/**
 * Fetch QR codes with server-side filtering + pagination (mirrors useRoutes).
 * `options.enabled` gates the fetch (the routes-page Save-as-QR
 * dedup guard only needs the list while its dialog is open).
 */
export function useQrCodes(params?: QrQueryParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: qrKeys.list(params),
    queryFn: () => fetchQrList(params),
    placeholderData: keepPreviousData,
    enabled: options?.enabled ?? true,
  });
}

// =============================================================================
// Mutations — invalidate the list; pages own the toasts (routes-page idiom).
// The option factories are exported so tests can run them without a renderer.
// =============================================================================

export function createQrMutationOptions(
  queryClient: QueryClient,
  store: PendingQrStore = pendingQrs,
) {
  return {
    mutationFn: ({ input, domain }: { input: Record<string, unknown>; domain: string }) =>
      api.qr.create(input, domain),
    onSuccess: async (created: QRCode) => {
      // Before the refetch, so the refetched lists include it
      store.remember(created);
      await queryClient.invalidateQueries({ queryKey: qrKeys.all });
    },
  };
}

export function updateQrMutationOptions(
  queryClient: QueryClient,
  store: PendingQrStore = pendingQrs,
) {
  return {
    mutationFn: ({
      id,
      input,
      domain,
    }: {
      id: string;
      input: Record<string, unknown>;
      domain: string;
    }) => api.qr.update(id, input, domain),
    onSuccess: async (updated: QRCode) => {
      store.update(updated);
      await queryClient.invalidateQueries({ queryKey: qrKeys.all });
    },
  };
}

export function deleteQrMutationOptions(
  queryClient: QueryClient,
  store: PendingQrStore = pendingQrs,
) {
  return {
    mutationFn: ({ id, domain }: { id: string; domain: string }) => api.qr.delete(id, domain),
    onSuccess: async (_result: void, { id, domain }: { id: string; domain: string }) => {
      // A deleted code must not come back from the pending store
      store.forget(domain, id);
      await queryClient.invalidateQueries({ queryKey: qrKeys.all });
    },
  };
}

export function useCreateQr() {
  return useMutation(createQrMutationOptions(useQueryClient()));
}

export function useUpdateQr() {
  return useMutation(updateQrMutationOptions(useQueryClient()));
}

export function useDeleteQr() {
  return useMutation(deleteQrMutationOptions(useQueryClient()));
}

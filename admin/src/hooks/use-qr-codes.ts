import type { QRCode } from '@bifrost/shared';
import {
  hashKey,
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { api, type QrQueryParams } from '@/lib/api-client';
import { isQrNotFoundError } from '@/lib/api-error';
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
 * One RAW server list page, for the cache. Its rows feed the store of latest
 * known versions (lib/qr-pending.ts); the store is applied when the page is
 * read, in `useQrCodes`'s `select`, never here (v1.38.0).
 */
export async function fetchQrList(
  params: QrQueryParams | undefined,
  store: PendingQrStore = pendingQrs,
): Promise<QrListPage> {
  const page = await api.qr.list(params);
  store.ingest(page);
  return page;
}

/**
 * Fetch QR codes with server-side filtering + pagination (mirrors useRoutes).
 * `options.enabled` gates the fetch (the routes-page Save-as-QR dedup guard
 * and the QR editor's duplicate-link check only need the list while open).
 *
 * The cache holds raw server pages; `select` shows each through the store's
 * current view (v1.38.0). The view is the `useSyncExternalStore` snapshot and
 * a new object whenever the store changes, so `select` changes with it and
 * React Query re-runs it on every page this hook reads: a cached page
 * revisited within its staleTime, or an inactive one mounted again, shows the
 * latest versions and tombstones without a refetch.
 */
export function useQrCodes(params?: QrQueryParams, options?: { enabled?: boolean }) {
  const view = useSyncExternalStore(pendingQrs.subscribe, pendingQrs.getSnapshot);
  // Callers pass a new params object on every render; the projection must
  // change only when the params' VALUE does (the query key's hash), or React
  // Query re-runs `select` on every render. (React's "store information from
  // previous renders" pattern: a changed value replaces the kept params during
  // render, before anything commits.)
  const [stableParams, setStableParams] = useState(params);
  if (hashKey(qrKeys.list(params)) !== hashKey(qrKeys.list(stableParams))) {
    setStableParams(params);
  }
  const select = useCallback(
    (page: QrListPage) => view.project(stableParams, page),
    [view, stableParams],
  );
  return useQuery({
    queryKey: qrKeys.list(stableParams),
    queryFn: () => fetchQrList(stableParams),
    select,
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
      // Before the refetch, so the refetched lists include it (KV listing can
      // lag behind a successful write); supersedes a tombstone for the id
      store.remember(created);
      await queryClient.invalidateQueries({ queryKey: qrKeys.all });
    },
  };
}

/**
 * A write to one code. `createdAt` names the incarnation the request was made
 * for (v1.38.0): a QR_NOT_FOUND tombstones that incarnation, so a stale row of
 * it stays hidden and a code re-created with the same id never is. Absent
 * only for an unreadable record, which names none.
 */
interface QrWrite {
  id: string;
  domain: string;
  createdAt?: number | undefined;
}

export function updateQrMutationOptions(
  queryClient: QueryClient,
  store: PendingQrStore = pendingQrs,
) {
  return {
    mutationFn: ({ id, input, domain }: QrWrite & { input: Record<string, unknown> }) =>
      api.qr.update(id, input, domain),
    onSuccess: async (updated: QRCode) => {
      // A listing that still holds the previous version must show the edit
      store.observeOwn(updated);
      await queryClient.invalidateQueries({ queryKey: qrKeys.all });
    },
    onError: async (error: unknown, { id, domain, createdAt }: QrWrite) => {
      // Gone on the server: hide it in every listing, cached ones included,
      // and refresh, as the delete path does. A QR_RECORD_INVALID is no
      // deletion: the code exists, and the page shows the server's message
      if (isQrNotFoundError(error)) {
        store.markDeleted(domain, id, createdAt);
        await queryClient.invalidateQueries({ queryKey: qrKeys.all });
      }
    },
  };
}

export function deleteQrMutationOptions(
  queryClient: QueryClient,
  store: PendingQrStore = pendingQrs,
) {
  return {
    mutationFn: ({ id, domain }: QrWrite) => api.qr.delete(id, domain),
    onSuccess: async (
      result: { createdAt?: number | undefined } | undefined,
      { id, domain, createdAt }: QrWrite,
    ) => {
      // The incarnation the server removed must not come back from a stale
      // listing: the answer names it (the dialog may have shown an older
      // one); an answer without it (from an older Worker) falls back to the
      // request's
      store.markDeleted(domain, id, result?.createdAt ?? createdAt);
      await queryClient.invalidateQueries({ queryKey: qrKeys.all });
    },
    onError: async (error: unknown, { id, domain, createdAt }: QrWrite) => {
      // Already deleted elsewhere: drop it and refresh, as a success would
      if (isQrNotFoundError(error)) {
        store.markDeleted(domain, id, createdAt);
        await queryClient.invalidateQueries({ queryKey: qrKeys.all });
      }
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

import { r2ObjectId, routeR2ObjectId } from '@bifrost/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { R2MetadataUpdate, StorageListParams } from '@/lib/api-client';
import { api } from '@/lib/api-client';
import type { RouteWithDomain } from '@/lib/schemas';
import { routeKeys, usePendingRouteView } from './use-routes';

// =============================================================================
// Query Keys
// =============================================================================

export const storageKeys = {
  all: ['storage'] as const,
  buckets: ['storage', 'buckets'] as const,
  list: (bucket: string, params?: StorageListParams) => ['storage', bucket, params ?? {}] as const,
  meta: (bucket: string, key: string) => ['storage', bucket, 'meta', key] as const,
};

// =============================================================================
// Queries
// =============================================================================

export function useStorageBuckets() {
  return useQuery({
    queryKey: storageKeys.buckets,
    queryFn: () => api.storage.listBuckets(),
  });
}

export function useStorageObjects(bucket: string, params?: StorageListParams) {
  return useQuery({
    queryKey: storageKeys.list(bucket, params),
    queryFn: () => api.storage.listObjects(bucket, params),
    placeholderData: keepPreviousData,
    enabled: !!bucket,
  });
}

export function useObjectMeta(bucket: string, key: string) {
  return useQuery({
    queryKey: storageKeys.meta(bucket, key),
    queryFn: () => api.storage.getObjectMeta(bucket, key),
    enabled: !!bucket && !!key,
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function useUploadObject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      bucket,
      file,
      key,
      options,
    }: {
      bucket: string;
      file: File;
      key: string;
      options?: { overwrite?: boolean };
    }) => api.storage.uploadObject(bucket, file, key, options),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

export function useDeleteObject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bucket, key }: { bucket: string; key: string }) =>
      api.storage.deleteObject(bucket, key),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

export function useRenameObject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bucket, oldKey, newKey }: { bucket: string; oldKey: string; newKey: string }) =>
      api.storage.renameObject(bucket, oldKey, newKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

export function useMoveObject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      bucket,
      key,
      destinationBucket,
      destinationKey,
    }: {
      bucket: string;
      key: string;
      destinationBucket: string;
      destinationKey?: string;
    }) => api.storage.moveObject(bucket, key, destinationBucket, destinationKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

export function useUpdateObjectMetadata() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      bucket,
      key,
      metadata,
    }: {
      bucket: string;
      key: string;
      metadata: R2MetadataUpdate;
    }) => api.storage.updateObjectMetadata(bucket, key, metadata),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

/**
 * The routes serving one R2 object (Storage's "Associated Routes"), shown
 * through the pending-route store as the listings are (v1.41.1): a route this
 * session saved shows its answer (so "View in Routes" opens the editor on the
 * saved `updatedAt`), one it deleted or moved away is hidden, and one whose
 * saved answer no longer serves the object (its target, bucket or type
 * changed) is dropped by the Worker's own match (`routeR2ObjectId`). A route
 * that newly serves it shows on the refetch.
 */
export function useRoutesByTarget(bucket: string, target: string) {
  const view = usePendingRouteView();
  const select = useCallback(
    (rows: RouteWithDomain[]) => {
      const object = r2ObjectId(bucket, target);
      return view.projectRows(rows, route => routeR2ObjectId(route) === object);
    },
    [view, bucket, target],
  );
  return useQuery({
    queryKey: routeKeys.byTarget(bucket, target),
    queryFn: () => api.routes.byTarget(bucket, target),
    select,
    enabled: !!bucket && !!target,
  });
}

export function usePurgeCache() {
  return useMutation({
    mutationFn: ({ bucket, key }: { bucket: string; key: string }) =>
      api.storage.purgeCache(bucket, key),
  });
}

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { StorageListParams } from '@/lib/api-client';

export const storageKeys = {
  all: ['storage'] as const,
  buckets: () => ['storage', 'buckets'] as const,
  objects: (bucket: string, params: StorageListParams) =>
    ['storage', 'objects', bucket, params] as const,
};

export function useStorageBuckets() {
  return useQuery({
    queryKey: storageKeys.buckets(),
    queryFn: () => api.storage.listBuckets(),
  });
}

export function useStorageObjects(bucket: string, params: StorageListParams = {}) {
  return useQuery({
    queryKey: storageKeys.objects(bucket, params),
    queryFn: () => api.storage.listObjects(bucket, params),
    enabled: !!bucket,
    placeholderData: keepPreviousData,
  });
}

export function useUploadObject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      bucket,
      key,
      file,
      overwrite,
    }: {
      bucket: string;
      key: string;
      file: File;
      overwrite?: boolean;
    }) => api.storage.uploadObject(bucket, key, file, overwrite),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

export function useDeleteObject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bucket, key }: { bucket: string; key: string }) =>
      api.storage.deleteObject(bucket, key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

export function useRenameObject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bucket, oldKey, newKey }: { bucket: string; oldKey: string; newKey: string }) =>
      api.storage.renameObject(bucket, oldKey, newKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: storageKeys.all });
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
      queryClient.invalidateQueries({ queryKey: storageKeys.all });
    },
  });
}

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedbackListParams, TriageFeedbackInput } from '@bifrost/shared';
import { api } from '@/lib/api-client';

export const feedbackKeys = {
  all: ['feedback'] as const,
  list: (params?: FeedbackListParams) => ['feedback', 'list', { ...params }] as const,
  detail: (id: string) => ['feedback', 'detail', id] as const,
};

/** List feedback (the single admin sees all). */
export function useFeedbackList(params?: FeedbackListParams) {
  return useQuery({
    queryKey: feedbackKeys.list(params),
    queryFn: () => api.feedback.list(params),
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single feedback item (triage detail view). */
export function useFeedbackItem(id: string | null) {
  return useQuery({
    queryKey: feedbackKeys.detail(id ?? ''),
    queryFn: () => api.feedback.get(id as string),
    enabled: !!id,
  });
}

export function useSubmitFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) => api.feedback.submit(formData),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedbackKeys.all }),
  });
}

export function useTriageFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: TriageFeedbackInput }) =>
      api.feedback.triage(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedbackKeys.all }),
  });
}

export function useDeleteFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.feedback.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedbackKeys.all }),
  });
}

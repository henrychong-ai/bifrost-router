import {
  FEEDBACK_PRIORITIES,
  type FeedbackListParams,
  type FeedbackSort,
  type FeedbackStatus,
  type FeedbackType,
} from '@bifrost/shared';

/**
 * The list query for the triage queue's controls. `all` sends no filter; a
 * priority is sent only when it is a level on the scale; the default order is
 * left implicit, so the default request is the one earlier releases sent.
 */
export function feedbackListParams(controls: {
  status: FeedbackStatus | 'all';
  type: FeedbackType | 'all';
  priority: string;
  sort: FeedbackSort;
}): FeedbackListParams {
  const level = FEEDBACK_PRIORITIES.find(p => String(p.value) === controls.priority);
  return {
    ...(controls.status === 'all' ? {} : { status: controls.status }),
    ...(controls.type === 'all' ? {} : { type: controls.type }),
    ...(level ? { priority: level.value } : {}),
    ...(controls.sort === 'oldest' ? { sort: 'oldest' as const } : {}),
  };
}

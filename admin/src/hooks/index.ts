// Route hooks
export {
  routeKeys,
  useRoutes,
  useRoute,
  useSearchRoutes,
  usePrefetchAllDomainRoutes,
  useCreateRoute,
  useUpdateRoute,
  useDeleteRoute,
  useToggleRoute,
  useMigrateRoute,
  useTransferRoute,
} from './use-routes';

// Analytics hooks
export {
  analyticsKeys,
  useAnalyticsSummary,
  useClicks,
  useViews,
  useSlugStats,
  useDownloads,
  useDownloadStats,
  useProxyRequests,
  useProxyStats,
  useAuditLogs,
} from './use-analytics';

// Tailscale identity hooks
export {
  tailscaleKeys,
  useTailscaleIdentity,
  type TailscaleIdentity,
} from './use-tailscale-identity';

// Backup hooks
export {
  backupKeys,
  useBackupHealth,
  type BackupHealthResponse,
} from './use-backup-health';

// Link preview hooks
export { useLinkPreview } from './use-link-preview';

// Storage hooks
export {
  storageKeys,
  useStorageBuckets,
  useStorageObjects,
  useObjectMeta,
  useUploadObject,
  useDeleteObject,
  useRenameObject,
  useMoveObject,
  useUpdateObjectMetadata,
  useRoutesByTarget,
  usePurgeCache,
} from './use-storage';

// Utility hooks
export { useDebounce } from './use-debounce';
export { useKeyboardShortcut, getModifierKey } from './use-keyboard-shortcuts';

// Command palette
export {
  CommandPaletteProvider,
  useCommandPalette,
} from './use-command-palette';

// Feedback hooks
export {
  feedbackKeys,
  useFeedbackList,
  useFeedbackItem,
  useSubmitFeedback,
  useTriageFeedback,
  useDeleteFeedback,
} from './use-feedback';

// QR code hooks (v1.30.0 — ported from upstream v1.54.0)
export { qrKeys, useQrCodes, useCreateQr, useUpdateQr, useDeleteQr } from './use-qr-codes';

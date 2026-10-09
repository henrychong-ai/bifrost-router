// Route hooks

// Command palette
export { CommandPaletteProvider } from './command-palette-provider';

// Analytics hooks
export {
  analyticsKeys,
  useAnalyticsSummary,
  useAuditLogs,
  useClicks,
  useDownloadStats,
  useDownloads,
  useProxyRequests,
  useProxyStats,
  useSlugStats,
  useViews,
} from './use-analytics';
// Backup hooks
export {
  type BackupHealthResponse,
  backupKeys,
  useBackupHealth,
} from './use-backup-health';
// Changelog hooks
export { changelogKeys, useChangelog } from './use-changelog';
export { useCommandPalette } from './use-command-palette';
// Utility hooks
export { useDebounce } from './use-debounce';
// Feedback hooks
export {
  feedbackKeys,
  useDeleteFeedback,
  useFeedbackItem,
  useFeedbackList,
  useSubmitFeedback,
  useTriageFeedback,
} from './use-feedback';
export { getModifierKey, useKeyboardShortcut } from './use-keyboard-shortcuts';
// Link preview hooks
export { useLinkPreview } from './use-link-preview';
// QR code hooks (v1.30.0)
export { qrKeys, useCreateQr, useDeleteQr, useQrCodes, useUpdateQr } from './use-qr-codes';
export {
  MIN_ROUTE_SEARCH_LENGTH,
  routeKeys,
  useCreateRoute,
  useDeleteRoute,
  useMigrateRoute,
  usePendingRouteAdmission,
  usePendingRouteView,
  usePrefetchAllDomainRoutes,
  useRouteExpiry,
  useRoutes,
  useSearchRoutes,
  useToggleRoute,
  useTransferRoute,
  useUpdateRoute,
} from './use-routes';
// Storage hooks
export {
  storageKeys,
  useDeleteObject,
  useMoveObject,
  useObjectMeta,
  usePurgeCache,
  useRenameObject,
  useRoutesByTarget,
  useStorageBuckets,
  useStorageObjects,
  useUpdateObjectMetadata,
  useUploadObject,
} from './use-storage';
// Tailscale identity hooks
export {
  type TailscaleIdentity,
  tailscaleKeys,
  useTailscaleIdentity,
} from './use-tailscale-identity';

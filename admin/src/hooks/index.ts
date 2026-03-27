// Route hooks
export {
  routeKeys,
  useRoutes,
  usePrefetchAllDomainRoutes,
  useRoute,
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

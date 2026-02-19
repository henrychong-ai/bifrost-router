// Route hooks
export {
  routeKeys,
  useRoutes,
  useRoute,
  useCreateRoute,
  useUpdateRoute,
  useDeleteRoute,
  useToggleRoute,
  useMigrateRoute,
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
  useUploadObject,
  useDeleteObject,
  useRenameObject,
} from './use-storage';

// Utility hooks
export { useDebounce } from './use-debounce';
export { useKeyboardShortcut, getModifierKey } from './use-keyboard-shortcuts';

// Command palette
export {
  CommandPaletteProvider,
  useCommandPalette,
} from './use-command-palette';

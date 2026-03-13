import { useState, useRef, useEffect, useCallback } from 'react';
import {
  useStorageBuckets,
  useStorageObjects,
  useUploadObject,
  useDeleteObject,
  useRenameObject,
  useMoveObject,
  useUpdateObjectMetadata,
  useRoutesByTarget,
  usePurgeCache,
} from '@/hooks';
import { storageApi } from '@/lib/api-client';
import type { StorageObject, StorageListParams } from '@/lib/api-client';
import { getR2ObjectUrl } from '@/lib/constants';
import { formatBytes } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Folder,
  File,
  Upload,
  Trash2,
  Pencil,
  Download,
  MoreHorizontal,
  ChevronRight,
  HardDrive,
  ShieldAlert,
  Info,
  ArrowRightLeft,
  Globe,
  RefreshCw,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB

function getBasename(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
}

function getContentTypeLabel(contentType?: string): string {
  if (!contentType) return '-';
  const map: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/json': 'JSON',
    'text/html': 'HTML',
    'text/css': 'CSS',
    'text/plain': 'Text',
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/gif': 'GIF',
    'image/svg+xml': 'SVG',
    'image/webp': 'WebP',
    'video/mp4': 'MP4',
    'application/zip': 'ZIP',
    'application/javascript': 'JS',
    'text/javascript': 'JS',
  };
  return map[contentType] || contentType.split('/').pop() || contentType;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function validateObjectKey(key: string): string | null {
  if (!key) return 'Key is required';
  if (key.includes('//')) return 'Key must not contain double slashes';
  if (key.startsWith('/')) return 'Key must not start with a slash';
  if (key.endsWith('/')) return 'Key must not end with a slash';
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(key))
    return 'Key may only contain letters, numbers, /, -, _, and .';
  return null;
}

function showPurgeCacheToast(result: { purged: number; failed: number; urls: string[] }) {
  if (result.purged === 0 && result.failed === 0) {
    if (result.urls.length > 0) {
      toast.warning(
        `Found ${result.urls.length} cache ${result.urls.length === 1 ? 'URL' : 'URLs'} but purge not configured — set CLOUDFLARE_API_TOKEN Worker secret`,
      );
    } else {
      toast.info('No cache entries to purge');
    }
  } else if (result.failed > 0) {
    toast.warning(
      `Purged ${result.purged}, failed ${result.failed} cache ${result.failed === 1 ? 'entry' : 'entries'}`,
    );
  } else {
    toast.success(`Purged ${result.purged} cache ${result.purged === 1 ? 'entry' : 'entries'}`);
  }
}

// =============================================================================
// Upload Dialog
// =============================================================================

function UploadDialog({
  open,
  onOpenChange,
  bucket,
  prefix,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucket: string;
  prefix: string;
}) {
  const upload = useUploadObject();
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const keyError = key ? validateObjectKey(key) : null;

  const isSubmitDisabled = !file || !key || !!keyError || upload.isPending;

  const disabledReason = upload.isPending
    ? 'Upload in progress'
    : !file
      ? 'No file selected'
      : !key
        ? 'Object key is required'
        : keyError
          ? keyError
          : null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (selected.size > MAX_UPLOAD_SIZE) {
      toast.error('File exceeds 100MB limit');
      return;
    }
    setFile(selected);
    if (!key) {
      setKey(prefix + selected.name);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !key) return;

    try {
      await upload.mutateAsync({
        bucket,
        file,
        key,
        overwrite,
      });
      toast.success(`Uploaded ${getBasename(key)}`);
      onOpenChange(false);
      setFile(null);
      setKey('');
      setOverwrite(false);
    } catch (err) {
      const status =
        err instanceof Error && 'status' in err ? (err as { status: number }).status : 0;
      if (status === 413) {
        toast.error('File too large for upload');
      } else if (status === 400) {
        toast.error(`Validation error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } else {
        toast.error(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-gilroy font-semibold text-blue-950">Upload File</DialogTitle>
          <DialogDescription className="font-gilroy">
            Upload a file to <code className="font-mono text-blue-600">{bucket}</code>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label className="font-gilroy font-medium text-charcoal-700">File</Label>
            <Input
              ref={fileInputRef}
              type="file"
              onChange={handleFileChange}
              className="font-gilroy"
            />
            {file && (
              <p className="font-gilroy text-tiny text-muted-foreground">
                {file.name} ({formatBytes(file.size)})
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="upload-key" className="font-gilroy font-medium text-charcoal-700">
                Object Key
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 cursor-help text-charcoal-400" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-64">
                  The full path to the object within the bucket. Use forward slashes for folders,
                  e.g. images/logos/logo.png
                </TooltipContent>
              </Tooltip>
            </div>
            <Input
              id="upload-key"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder={`${prefix}filename.ext`}
              required
              className="font-mono"
            />
            {key && validateObjectKey(key) ? (
              <p className="font-gilroy text-tiny text-destructive">{validateObjectKey(key)}</p>
            ) : (
              <p className="font-gilroy text-tiny text-muted-foreground">
                Full path within the bucket
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="overwrite" className="font-gilroy font-medium text-charcoal-700">
                Overwrite
              </Label>
              <p className="font-gilroy text-tiny text-muted-foreground">
                Replace existing file if it exists
              </p>
            </div>
            <Switch id="overwrite" checked={overwrite} onCheckedChange={setOverwrite} />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="font-gilroy"
            >
              Cancel
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="submit"
                    disabled={isSubmitDisabled}
                    className="bg-blue-950 font-gilroy hover:bg-blue-900"
                  >
                    {upload.isPending ? 'Uploading...' : 'Upload'}
                  </Button>
                </span>
              </TooltipTrigger>
              {disabledReason && <TooltipContent>{disabledReason}</TooltipContent>}
            </Tooltip>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Storage Edit Dialog (unified rename + metadata + replace + associated routes)
// =============================================================================

function StorageEditDialog({
  open,
  onOpenChange,
  bucket,
  object,
  readOnly,
  allowedBuckets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucket: string;
  object: StorageObject;
  readOnly: boolean;
  allowedBuckets: string[];
}) {
  const rename = useRenameObject();
  const updateMeta = useUpdateObjectMetadata();
  const upload = useUploadObject();
  const purgeCacheMutation = usePurgeCache();

  // File preview
  const fileUrl = getR2ObjectUrl(bucket, object.key);
  const objectContentType = object.httpMetadata?.contentType;
  const isImage = objectContentType?.startsWith('image/');
  const isPdf = objectContentType === 'application/pdf';

  // Rename state
  const [newKey, setNewKey] = useState(object.key);
  const keyChanged = newKey !== object.key;
  const keyError = newKey ? validateObjectKey(newKey) : null;

  // Metadata state
  const [contentType, setContentType] = useState(object.httpMetadata?.contentType || '');
  const [cacheControl, setCacheControl] = useState(object.httpMetadata?.cacheControl || '');
  const [contentDisposition, setContentDisposition] = useState(
    object.httpMetadata?.contentDisposition || '',
  );

  // Replace file state
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // Move state
  const [moveOpen, setMoveOpen] = useState(false);

  // Associated routes
  const { data: associatedRoutes, isLoading: routesLoading } = useRoutesByTarget(
    bucket,
    object.key,
  );

  // Reset state when object changes
  useEffect(() => {
    setNewKey(object.key);
    setContentType(object.httpMetadata?.contentType || '');
    setCacheControl(object.httpMetadata?.cacheControl || '');
    setContentDisposition(object.httpMetadata?.contentDisposition || '');
    setReplaceFile(null);
  }, [object]);

  const handleRename = async () => {
    if (!keyChanged || keyError) return;
    try {
      await rename.mutateAsync({ bucket, oldKey: object.key, newKey });
      toast.success(`Renamed to ${getBasename(newKey)}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Rename failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleMetadataSave = async () => {
    const metadata = {
      contentType,
      cacheControl,
      contentDisposition,
    };

    try {
      await updateMeta.mutateAsync({ bucket, key: object.key, metadata });
      toast.success('Metadata updated');
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleReplace = async () => {
    if (!replaceFile) return;
    try {
      await upload.mutateAsync({
        bucket,
        file: replaceFile,
        key: object.key,
        overwrite: true,
      });
      toast.success(`Replaced ${getBasename(object.key)}`);
      setReplaceFile(null);
    } catch (err) {
      toast.error(`Replace failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleReplaceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (selected.size > MAX_UPLOAD_SIZE) {
      toast.error('File exceeds 100MB limit');
      return;
    }
    setReplaceFile(selected);
  };

  const handlePurgeCache = async () => {
    try {
      const result = await purgeCacheMutation.mutateAsync({ bucket, key: object.key });
      showPurgeCacheToast(result);
    } catch (err) {
      toast.error(`Purge failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const targetBuckets = allowedBuckets.filter(b => b !== bucket);

  return (
    <>
      <Dialog open={open && !moveOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-gilroy font-semibold text-blue-950">
              Edit Object
            </DialogTitle>
            <DialogDescription className="font-gilroy">
              <code className="font-mono text-blue-600">{getBasename(object.key)}</code> in{' '}
              <code className="font-mono text-blue-600">{bucket}</code>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* File Preview */}
            {isImage && fileUrl && (
              <div className="rounded-lg border border-charcoal-100 overflow-hidden bg-muted/30">
                <img
                  src={fileUrl}
                  alt={getBasename(object.key)}
                  className="max-h-[200px] w-full object-contain"
                  onError={e => {
                    e.currentTarget.parentElement!.style.display = 'none';
                  }}
                />
              </div>
            )}
            {isPdf && fileUrl && (
              <div className="rounded-lg border border-charcoal-100 overflow-hidden bg-muted/30">
                <object
                  data={fileUrl}
                  type="application/pdf"
                  title={getBasename(object.key)}
                  className="h-[250px] w-full"
                >
                  <p className="p-4 text-center text-sm text-muted-foreground">
                    Unable to preview PDF.{' '}
                    <a
                      href={fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline"
                    >
                      Open in browser
                    </a>
                  </p>
                </object>
              </div>
            )}

            {fileUrl && (
              <a
                href={fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-blue-600"
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate font-mono">{fileUrl.replace('https://', '')}</span>
              </a>
            )}

            {/* Object Info */}
            <div className="space-y-2">
              <h4 className="font-gilroy text-small font-semibold text-charcoal-700">
                Object Info
              </h4>
              <div className="rounded-lg border border-charcoal-100 bg-charcoal-50/50 p-3">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-gilroy text-tiny">
                  <dt className="text-charcoal-500">Key</dt>
                  <dd className="truncate font-mono text-charcoal-700">{object.key}</dd>
                  <dt className="text-charcoal-500">Bucket</dt>
                  <dd className="font-mono text-charcoal-700">{bucket}</dd>
                  <dt className="text-charcoal-500">Size</dt>
                  <dd className="text-charcoal-700">{formatBytes(object.size)}</dd>
                  <dt className="text-charcoal-500">Content-Type</dt>
                  <dd className="font-mono text-charcoal-700">
                    {object.httpMetadata?.contentType || '-'}
                  </dd>
                  <dt className="text-charcoal-500">Uploaded</dt>
                  <dd className="text-charcoal-700">{formatDate(object.uploaded)}</dd>
                  <dt className="text-charcoal-500">ETag</dt>
                  <dd className="truncate font-mono text-charcoal-700">{object.etag}</dd>
                </dl>
              </div>
            </div>

            <div className="border-t border-charcoal-100" />

            {/* Associated Routes */}
            <div className="space-y-2">
              <h4 className="font-gilroy text-small font-semibold text-charcoal-700">
                Associated Routes
              </h4>
              {routesLoading ? (
                <Skeleton className="h-8 w-full" />
              ) : associatedRoutes && associatedRoutes.length > 0 ? (
                <div className="space-y-1.5">
                  {associatedRoutes.map(route => (
                    <div
                      key={`${route.domain}:${route.path}`}
                      className="flex items-center gap-2 rounded-md border border-charcoal-100 bg-charcoal-50/50 px-3 py-2"
                    >
                      <Globe className="h-3.5 w-3.5 text-charcoal-400" />
                      <Badge variant="outline" className="font-mono text-tiny">
                        {route.domain}
                      </Badge>
                      <span className="font-mono text-tiny text-charcoal-700">{route.path}</span>
                      <Badge variant="secondary" className="ml-auto font-gilroy text-tiny">
                        {route.type}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-gilroy text-tiny text-muted-foreground">
                  No routes serve this file
                </p>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={handlePurgeCache}
                disabled={purgeCacheMutation.isPending}
                className="font-gilroy"
              >
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
                {purgeCacheMutation.isPending ? 'Purging...' : 'Purge Cache'}
              </Button>
            </div>

            {!readOnly && (
              <>
                <div className="border-t border-charcoal-100" />

                {/* Replace File */}
                <div className="space-y-2">
                  <h4 className="font-gilroy text-small font-semibold text-charcoal-700">
                    Replace File
                  </h4>
                  <p className="font-gilroy text-tiny text-muted-foreground">
                    Upload a new file keeping the same key. The URL will remain the same.
                  </p>
                  <Input
                    ref={replaceInputRef}
                    type="file"
                    onChange={handleReplaceFileChange}
                    className="font-gilroy"
                  />
                  {replaceFile && (
                    <p className="font-gilroy text-tiny text-charcoal-600">
                      {replaceFile.name} ({formatBytes(replaceFile.size)})
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleReplace}
                    disabled={!replaceFile || upload.isPending}
                    className="font-gilroy"
                  >
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    {upload.isPending ? 'Replacing...' : 'Replace'}
                  </Button>
                </div>

                <div className="border-t border-charcoal-100" />

                {/* Rename */}
                <div className="space-y-2">
                  <h4 className="font-gilroy text-small font-semibold text-charcoal-700">Rename</h4>
                  <Input
                    value={newKey}
                    onChange={e => setNewKey(e.target.value)}
                    className="font-mono"
                  />
                  {keyError && <p className="font-gilroy text-tiny text-destructive">{keyError}</p>}
                  {keyChanged && !keyError && (
                    <p className="font-gilroy text-tiny text-amber-600">
                      Key will change from{' '}
                      <code className="font-mono">{getBasename(object.key)}</code> to{' '}
                      <code className="font-mono">{getBasename(newKey)}</code>
                    </p>
                  )}
                  <Button
                    size="sm"
                    onClick={handleRename}
                    disabled={!keyChanged || !!keyError || rename.isPending}
                    className="bg-blue-950 font-gilroy hover:bg-blue-900"
                  >
                    {rename.isPending ? 'Renaming...' : 'Rename'}
                  </Button>
                </div>

                {/* Move to Bucket */}
                {targetBuckets.length > 0 && (
                  <>
                    <div className="border-t border-charcoal-100" />
                    <div className="space-y-2">
                      <h4 className="font-gilroy text-small font-semibold text-charcoal-700">
                        Move to Bucket
                      </h4>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setMoveOpen(true)}
                        className="font-gilroy"
                      >
                        <ArrowRightLeft className="mr-2 h-3.5 w-3.5" />
                        Move to another bucket
                      </Button>
                    </div>
                  </>
                )}

                <div className="border-t border-charcoal-100" />

                {/* HTTP Metadata */}
                <div className="space-y-3">
                  <h4 className="font-gilroy text-small font-semibold text-charcoal-700">
                    HTTP Metadata
                  </h4>
                  <div className="space-y-2">
                    <Label
                      htmlFor="edit-content-type"
                      className="font-gilroy text-tiny font-medium text-charcoal-600"
                    >
                      Content-Type
                    </Label>
                    <Input
                      id="edit-content-type"
                      value={contentType}
                      onChange={e => setContentType(e.target.value)}
                      placeholder="application/pdf"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label
                      htmlFor="edit-cache-control"
                      className="font-gilroy text-tiny font-medium text-charcoal-600"
                    >
                      Cache-Control
                    </Label>
                    <Input
                      id="edit-cache-control"
                      value={cacheControl}
                      onChange={e => setCacheControl(e.target.value)}
                      placeholder="max-age=3600"
                      className="font-mono"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label
                      htmlFor="edit-content-disposition"
                      className="font-gilroy text-tiny font-medium text-charcoal-600"
                    >
                      Content-Disposition
                    </Label>
                    <Input
                      id="edit-content-disposition"
                      value={contentDisposition}
                      onChange={e => setContentDisposition(e.target.value)}
                      placeholder="attachment; filename=file.pdf"
                      className="font-mono"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={handleMetadataSave}
                    disabled={updateMeta.isPending}
                    className="bg-blue-950 font-gilroy hover:bg-blue-900"
                  >
                    {updateMeta.isPending ? 'Saving...' : 'Save Metadata'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Move Dialog (opened from within edit dialog) */}
      {moveOpen && (
        <MoveDialog
          open={moveOpen}
          onOpenChange={isOpen => {
            setMoveOpen(isOpen);
            if (!isOpen) onOpenChange(false);
          }}
          bucket={bucket}
          objectKey={object.key}
          allowedBuckets={allowedBuckets}
        />
      )}
    </>
  );
}

// =============================================================================
// Move Dialog
// =============================================================================

function MoveDialog({
  open,
  onOpenChange,
  bucket,
  objectKey,
  allowedBuckets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucket: string;
  objectKey: string;
  allowedBuckets: string[];
}) {
  const move = useMoveObject();
  const targetBuckets = allowedBuckets.filter(b => b !== bucket);
  const [destinationBucket, setDestinationBucket] = useState(targetBuckets[0] || '');
  const [destinationKey, setDestinationKey] = useState(objectKey);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!destinationBucket) return;

    try {
      await move.mutateAsync({
        bucket,
        key: objectKey,
        destinationBucket,
        destinationKey: destinationKey !== objectKey ? destinationKey : undefined,
      });
      toast.success(`Moved to ${destinationBucket}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Move failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-gilroy font-semibold text-blue-950">
            Move to Bucket
          </DialogTitle>
          <DialogDescription className="font-gilroy">
            Move <code className="font-mono text-blue-600">{getBasename(objectKey)}</code> from{' '}
            <code className="font-mono text-blue-600">{bucket}</code> to another bucket.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dest-bucket" className="font-gilroy font-medium text-charcoal-700">
              Destination Bucket
            </Label>
            <Select value={destinationBucket} onValueChange={setDestinationBucket}>
              <SelectTrigger id="dest-bucket" className="font-mono">
                <SelectValue placeholder="Select bucket" />
              </SelectTrigger>
              <SelectContent>
                {targetBuckets.map(b => (
                  <SelectItem key={b} value={b} className="font-mono">
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dest-key" className="font-gilroy font-medium text-charcoal-700">
              Destination Key
            </Label>
            <Input
              id="dest-key"
              value={destinationKey}
              onChange={e => setDestinationKey(e.target.value)}
              required
              className="font-mono"
            />
            <p className="font-gilroy text-tiny text-muted-foreground">
              Optionally change the key in the destination bucket.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="font-gilroy"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!destinationBucket || move.isPending}
              className="bg-blue-950 font-gilroy hover:bg-blue-900"
            >
              {move.isPending ? 'Moving...' : 'Move'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Storage Page
// =============================================================================

export function StoragePage() {
  const { data: buckets, isLoading: bucketsLoading } = useStorageBuckets();
  const [selectedBucket, setSelectedBucket] = useState('');
  const [prefix, setPrefix] = useState('');

  // Set default bucket once loaded
  useEffect(() => {
    if (buckets && buckets.length > 0 && !selectedBucket) {
      setSelectedBucket(buckets[0].name);
    }
  }, [buckets, selectedBucket]);

  const readOnly = buckets?.find(b => b.name === selectedBucket)?.access === 'read-only';
  const writableBuckets = (buckets || []).filter(b => b.access !== 'read-only').map(b => b.name);

  const params: StorageListParams = {
    prefix: prefix || undefined,
    delimiter: '/',
    limit: 100,
  };

  const { data, isLoading, error } = useStorageObjects(selectedBucket, params);
  const deleteObject = useDeleteObject();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StorageObject | null>(null);
  const [editTarget, setEditTarget] = useState<StorageObject | null>(null);
  const [prefixSearch, setPrefixSearch] = useState('');
  const prefixInputRef = useRef<HTMLInputElement>(null);

  const handlePrefixSearch = useCallback(() => {
    setPrefix(prefixSearch);
  }, [prefixSearch]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;
      const isDialogOpen = uploadOpen || !!deleteTarget || !!editTarget;

      if (isInputFocused || isDialogOpen) return;

      if (e.key === 'u' && !readOnly) {
        e.preventDefault();
        setUploadOpen(true);
      }

      if (e.key === '/') {
        e.preventDefault();
        prefixInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [uploadOpen, deleteTarget, editTarget, readOnly]);

  const navigateToPrefix = (newPrefix: string) => {
    setPrefix(newPrefix);
    setPrefixSearch(newPrefix);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteObject.mutateAsync({
        bucket: selectedBucket,
        key: deleteTarget.key,
      });
      toast.success(`Deleted ${getBasename(deleteTarget.key)}`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Build breadcrumb segments from prefix
  const breadcrumbs = prefix
    ? prefix
        .split('/')
        .filter(Boolean)
        .map((segment, i, arr) => ({
          label: segment,
          prefix: arr.slice(0, i + 1).join('/') + '/',
        }))
    : [];

  if (bucketsLoading) {
    return (
      <div className="space-y-6">
        <h1 className="font-gilroy text-huge font-bold text-blue-950">Storage</h1>
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (!buckets || buckets.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="font-gilroy text-huge font-bold text-blue-950">Storage</h1>
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
              <ShieldAlert className="h-10 w-10" />
              <p className="font-gilroy">No storage buckets available.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="font-gilroy text-huge font-bold text-blue-950">Storage</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="font-gilroy text-destructive">Failed to load objects: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-fade-in flex items-center justify-between">
        <div className="flex flex-1 items-center gap-4">
          <h1 className="font-gilroy text-huge font-bold text-blue-950">Storage</h1>
          <div className="gradient-accent-bar h-1 flex-1 rounded-full opacity-30" />
        </div>
        {!readOnly && (
          <Button
            onClick={() => setUploadOpen(true)}
            className="ml-4 bg-blue-950 font-gilroy hover:bg-blue-900"
          >
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        )}
      </div>

      {/* Bucket selector + read-only badge */}
      <div className="animate-stagger-init animate-fade-in-up stagger-1 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="font-gilroy text-small text-charcoal-600">Bucket</label>
          <Select
            value={selectedBucket}
            onValueChange={v => {
              setSelectedBucket(v);
              setPrefix('');
              setPrefixSearch('');
            }}
          >
            <SelectTrigger className="w-56 font-mono">
              <SelectValue placeholder="Select bucket" />
            </SelectTrigger>
            <SelectContent>
              {buckets.map(b => (
                <SelectItem key={b.name} value={b.name} className="font-mono text-small">
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="font-gilroy text-small text-charcoal-600">
            Prefix filter{' '}
            <kbd className="ml-1 rounded-sm border border-charcoal-200 bg-charcoal-50 px-1 font-mono text-tiny text-charcoal-500">
              /
            </kbd>
          </label>
          <form
            className="flex gap-1.5"
            onSubmit={e => {
              e.preventDefault();
              handlePrefixSearch();
            }}
          >
            <Input
              ref={prefixInputRef}
              value={prefixSearch}
              onChange={e => setPrefixSearch(e.target.value)}
              placeholder="e.g. images/logos/"
              className="w-56 font-mono"
            />
            <Button type="submit" variant="outline" size="sm" className="font-gilroy">
              Go
            </Button>
          </form>
        </div>
        {readOnly && (
          <Badge
            variant="outline"
            className="border-amber-300 bg-amber-50 font-gilroy text-amber-700"
          >
            <ShieldAlert className="mr-1 h-3 w-3" />
            Read-only
          </Badge>
        )}
      </div>

      {/* Breadcrumb nav */}
      <div className="animate-stagger-init animate-fade-in-up stagger-2 flex items-center gap-1 font-gilroy text-small text-charcoal-600">
        <button
          onClick={() => navigateToPrefix('')}
          className="flex items-center gap-1 transition-colors hover:text-blue-600"
        >
          <HardDrive className="size-3.5" />
          {selectedBucket}
        </button>
        {breadcrumbs.map(crumb => (
          <span key={crumb.prefix} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-charcoal-400" />
            <button
              onClick={() => navigateToPrefix(crumb.prefix)}
              className="transition-colors hover:text-blue-600"
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>

      {/* File table */}
      <Card className="animate-stagger-init animate-fade-in-up stagger-3 border-border/50">
        <CardHeader>
          <CardTitle className="font-gilroy font-semibold text-blue-950">Objects</CardTitle>
          <CardDescription className="font-gilroy">
            {isLoading
              ? 'Loading...'
              : `${(data?.delimitedPrefixes.length ?? 0) + (data?.objects.length ?? 0)} items${prefix ? ` in ${prefix}` : ''}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-charcoal-100 bg-muted/30">
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Name
                  </TableHead>
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Size
                  </TableHead>
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Type
                  </TableHead>
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Uploaded
                  </TableHead>
                  <TableHead className="w-[70px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Folder rows */}
                {data?.delimitedPrefixes.map(folderPrefix => {
                  const folderName = folderPrefix.replace(prefix, '').replace(/\/$/, '');
                  return (
                    <TableRow
                      key={folderPrefix}
                      className="cursor-pointer transition-colors hover:bg-gold-50/50"
                      onClick={() => navigateToPrefix(folderPrefix)}
                    >
                      <TableCell className="font-gilroy text-small font-medium text-blue-600">
                        <span className="flex items-center gap-2">
                          <Folder className="h-4 w-4 text-gold-500" />
                          {folderName}/
                        </span>
                      </TableCell>
                      <TableCell className="text-small text-charcoal-400">-</TableCell>
                      <TableCell className="text-small text-charcoal-400">Folder</TableCell>
                      <TableCell className="text-small text-charcoal-400">-</TableCell>
                      <TableCell />
                    </TableRow>
                  );
                })}

                {/* File rows */}
                {data?.objects.map(obj => (
                  <TableRow
                    key={obj.key}
                    className="cursor-pointer transition-colors hover:bg-gold-50/50"
                    onClick={() => setEditTarget(obj)}
                  >
                    <TableCell className="font-mono text-small font-medium text-charcoal-700">
                      <span className="flex items-center gap-2">
                        <File className="h-4 w-4 text-charcoal-400" />
                        {getBasename(obj.key)}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-small text-charcoal-600">
                      {formatBytes(obj.size)}
                    </TableCell>
                    <TableCell className="font-gilroy text-small text-charcoal-600">
                      {getContentTypeLabel(obj.httpMetadata?.contentType)}
                    </TableCell>
                    <TableCell className="font-gilroy text-small text-charcoal-600">
                      {formatDate(obj.uploaded)}
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="hover:bg-blue-50">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {getR2ObjectUrl(selectedBucket, obj.key) && (
                            <DropdownMenuItem asChild className="font-gilroy">
                              <a
                                href={getR2ObjectUrl(selectedBucket, obj.key)!}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Open in Browser
                              </a>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="font-gilroy"
                            onClick={async () => {
                              try {
                                const response = await storageApi.downloadObject(
                                  selectedBucket,
                                  obj.key,
                                );
                                const url = URL.createObjectURL(response);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = getBasename(obj.key);
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                                URL.revokeObjectURL(url);
                              } catch (err) {
                                toast.error(
                                  `Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                                );
                              }
                            }}
                          >
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setEditTarget(obj)}
                            className="font-gilroy"
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="font-gilroy"
                            onClick={async () => {
                              try {
                                const result = await storageApi.purgeCache(selectedBucket, obj.key);
                                showPurgeCacheToast(result);
                              } catch (err) {
                                toast.error(
                                  `Purge failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                                );
                              }
                            }}
                          >
                            <RotateCcw className="mr-2 h-4 w-4" />
                            Purge Cache
                          </DropdownMenuItem>
                          {!readOnly && (
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(obj)}
                              className="font-gilroy text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}

                {/* Empty state */}
                {data?.delimitedPrefixes.length === 0 && data?.objects.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center">
                      <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <HardDrive className="h-10 w-10" />
                        <p className="font-gilroy">No objects in this location</p>
                        {!readOnly && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setUploadOpen(true)}
                            className="font-gilroy"
                          >
                            <Upload className="mr-2 h-4 w-4" />
                            Upload a file
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}

          {data?.truncated && (
            <p className="mt-4 text-center font-gilroy text-tiny text-muted-foreground">
              Showing {(data.delimitedPrefixes.length ?? 0) + (data.objects.length ?? 0)} of many
              objects. Use a more specific prefix to narrow results.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        bucket={selectedBucket}
        prefix={prefix}
      />

      {/* Storage Edit Dialog */}
      {editTarget && (
        <StorageEditDialog
          open={!!editTarget}
          onOpenChange={() => setEditTarget(null)}
          bucket={selectedBucket}
          object={editTarget}
          readOnly={!!readOnly}
          allowedBuckets={writableBuckets}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-gilroy font-semibold text-blue-950">
              Delete Object
            </AlertDialogTitle>
            <AlertDialogDescription className="font-gilroy">
              Are you sure you want to delete{' '}
              <code className="font-mono text-blue-600">{deleteTarget?.key}</code> from{' '}
              <code className="font-mono text-blue-600">{selectedBucket}</code>? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-gilroy">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteObject.isPending}
              className="bg-destructive font-gilroy text-white hover:bg-destructive/90"
            >
              {deleteObject.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

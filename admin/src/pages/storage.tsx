import { useState, useRef, useCallback } from 'react';
import {
  useStorageBuckets,
  useStorageObjects,
  useUploadObject,
  useDeleteObject,
  useRenameObject,
} from '@/hooks';
import { formatBytes } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Upload,
  Trash2,
  MoreHorizontal,
  Folder,
  FileIcon,
  ChevronRight,
  Pencil,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';

const READ_ONLY_BUCKETS = ['bifrost-backups'];

export function StoragePage() {
  const { data: buckets, isLoading: bucketsLoading } = useStorageBuckets();

  const [selectedBucket, setSelectedBucket] = useState('');
  const [prefix, setPrefix] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [renameDialog, setRenameDialog] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Auto-select first bucket when loaded
  const activeBucket = selectedBucket || buckets?.[0]?.name || '';
  const isReadOnly = READ_ONLY_BUCKETS.includes(activeBucket);

  const {
    data: objectsData,
    isLoading: objectsLoading,
    isFetching: objectsFetching,
  } = useStorageObjects(activeBucket, {
    prefix: prefix || undefined,
    cursor,
    limit: 100,
    delimiter: '/',
  });

  const uploadMutation = useUploadObject();
  const deleteMutation = useDeleteObject();
  const renameMutation = useRenameObject();

  // Breadcrumb segments from prefix
  const prefixSegments = prefix ? prefix.split('/').filter(Boolean) : [];

  const navigateToPrefix = useCallback((newPrefix: string) => {
    setPrefix(newPrefix);
    setCursor(undefined);
  }, []);

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await deleteMutation.mutateAsync({ bucket: activeBucket, key: deleteConfirm });
      toast.success(`Deleted ${deleteConfirm}`);
      setDeleteConfirm(null);
    } catch (err) {
      toast.error(`Failed to delete: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleRename = async () => {
    if (!renameDialog || !renameValue) return;
    try {
      await renameMutation.mutateAsync({
        bucket: activeBucket,
        oldKey: renameDialog,
        newKey: renameValue,
      });
      toast.success(`Renamed to ${renameValue}`);
      setRenameDialog(null);
      setRenameValue('');
    } catch (err) {
      toast.error(`Failed to rename: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  if (bucketsLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">Storage</h1>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 flex-1">
          <h1 className="text-huge font-gilroy font-bold text-blue-950">Storage</h1>
          <div className="h-1 flex-1 rounded-full gradient-accent-bar opacity-30" />
        </div>
        {!isReadOnly && (
          <Button
            className="font-gilroy bg-blue-950 hover:bg-blue-900 ml-4"
            onClick={() => setUploadDialogOpen(true)}
          >
            <Upload className="h-4 w-4 mr-2" />
            Upload
          </Button>
        )}
      </div>

      {/* Bucket selector */}
      <div className="flex items-center gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">Bucket</label>
          <Select
            value={activeBucket}
            onValueChange={value => {
              setSelectedBucket(value);
              setPrefix('');
              setCursor(undefined);
            }}
          >
            <SelectTrigger className="w-64 font-mono">
              <SelectValue placeholder="Select bucket" />
            </SelectTrigger>
            <SelectContent>
              {buckets?.map(b => (
                <SelectItem key={b.name} value={b.name} className="font-mono text-small">
                  <span className="flex items-center gap-2">
                    {b.name}
                    {b.access === 'read-only' && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        read-only
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isReadOnly && (
          <Badge variant="secondary" className="mt-6 font-gilroy">
            Read-only
          </Badge>
        )}
      </div>

      {/* Breadcrumbs */}
      {prefix && (
        <div className="flex items-center gap-1 text-sm font-gilroy text-charcoal-600">
          <button className="hover:text-blue-600 font-medium" onClick={() => navigateToPrefix('')}>
            /
          </button>
          {prefixSegments.map((segment, i) => {
            const segmentPrefix = prefixSegments.slice(0, i + 1).join('/') + '/';
            return (
              <span key={segmentPrefix} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3" />
                <button
                  className="hover:text-blue-600 font-medium"
                  onClick={() => navigateToPrefix(segmentPrefix)}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Objects table */}
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="font-gilroy font-semibold text-blue-950">Objects</CardTitle>
          <CardDescription className="font-gilroy">
            {objectsLoading
              ? 'Loading...'
              : `${(objectsData?.delimitedPrefixes?.length || 0) + (objectsData?.objects?.length || 0)} items${prefix ? ` in ${prefix}` : ''}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {objectsLoading ? (
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow className="border-charcoal-100 bg-muted/30">
                    <TableHead className="font-gilroy font-semibold text-charcoal-700">
                      Key
                    </TableHead>
                    <TableHead className="font-gilroy font-semibold text-charcoal-700 w-24">
                      Size
                    </TableHead>
                    <TableHead className="font-gilroy font-semibold text-charcoal-700 w-40">
                      Content-Type
                    </TableHead>
                    <TableHead className="font-gilroy font-semibold text-charcoal-700 w-44">
                      Uploaded
                    </TableHead>
                    <TableHead className="w-[70px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Folder prefixes */}
                  {objectsData?.delimitedPrefixes?.map(p => (
                    <TableRow
                      key={p}
                      className="hover:bg-gold-50/50 transition-colors cursor-pointer"
                      onClick={() => navigateToPrefix(p)}
                    >
                      <TableCell className="font-mono text-small font-medium text-blue-600">
                        <span className="flex items-center gap-2">
                          <Folder className="h-4 w-4 text-gold-500" />
                          {p.replace(prefix, '')}
                        </span>
                      </TableCell>
                      <TableCell className="text-small text-charcoal-400">--</TableCell>
                      <TableCell className="text-small text-charcoal-400">--</TableCell>
                      <TableCell className="text-small text-charcoal-400">--</TableCell>
                      <TableCell />
                    </TableRow>
                  ))}

                  {/* Objects */}
                  {objectsData?.objects?.map(obj => (
                    <TableRow key={obj.key} className="hover:bg-gold-50/50 transition-colors">
                      <TableCell className="font-mono text-small font-medium text-charcoal-700">
                        <span className="flex items-center gap-2">
                          <FileIcon className="h-4 w-4 text-charcoal-400" />
                          {obj.key.replace(prefix, '')}
                        </span>
                      </TableCell>
                      <TableCell className="text-small text-charcoal-600 font-mono">
                        {formatBytes(obj.size)}
                      </TableCell>
                      <TableCell className="text-small text-charcoal-600 font-mono">
                        {obj.httpMetadata?.contentType || '--'}
                      </TableCell>
                      <TableCell className="text-small text-charcoal-600">
                        {new Date(obj.uploaded).toLocaleDateString('en-GB', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        {!isReadOnly && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="hover:bg-blue-50">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  setRenameDialog(obj.key);
                                  setRenameValue(obj.key);
                                }}
                                className="font-gilroy"
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setDeleteConfirm(obj.key)}
                                className="text-destructive font-gilroy"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}

                  {(objectsData?.delimitedPrefixes?.length || 0) === 0 &&
                    (objectsData?.objects?.length || 0) === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-muted-foreground font-gilroy"
                        >
                          No objects found
                        </TableCell>
                      </TableRow>
                    )}
                </TableBody>
              </Table>

              {/* Load More (cursor pagination) */}
              {objectsData?.truncated && objectsData.cursor && (
                <div className="flex justify-center pt-4">
                  <Button
                    variant="outline"
                    className="font-gilroy"
                    disabled={objectsFetching}
                    onClick={() => setCursor(objectsData.cursor)}
                  >
                    {objectsFetching && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Load More
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Upload Dialog */}
      <UploadDialog
        open={uploadDialogOpen}
        onOpenChange={setUploadDialogOpen}
        bucket={activeBucket}
        prefix={prefix}
        uploadMutation={uploadMutation}
      />

      {/* Delete Confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-gilroy font-semibold text-blue-950">
              Delete Object
            </DialogTitle>
            <DialogDescription className="font-gilroy">
              Are you sure you want to delete{' '}
              <code className="font-mono text-blue-600">{deleteConfirm}</code>? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirm(null)}
              className="font-gilroy"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="font-gilroy"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog
        open={!!renameDialog}
        onOpenChange={() => {
          setRenameDialog(null);
          setRenameValue('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-gilroy font-semibold text-blue-950">
              Rename Object
            </DialogTitle>
            <DialogDescription className="font-gilroy">
              Rename <code className="font-mono text-blue-600">{renameDialog}</code>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="font-gilroy font-medium text-charcoal-700">New Key</Label>
            <Input
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenameDialog(null);
                setRenameValue('');
              }}
              className="font-gilroy"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={renameMutation.isPending || !renameValue || renameValue === renameDialog}
              className="font-gilroy bg-blue-950 hover:bg-blue-900"
            >
              {renameMutation.isPending ? 'Renaming...' : 'Rename'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  bucket,
  prefix,
  uploadMutation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucket: string;
  prefix: string;
  uploadMutation: ReturnType<typeof useUploadObject>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [key, setKey] = useState('');

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    if (file) {
      setKey(prefix + file.name);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile || !key) return;
    try {
      await uploadMutation.mutateAsync({ bucket, key, file: selectedFile });
      toast.success(`Uploaded ${key}`);
      onOpenChange(false);
      setSelectedFile(null);
      setKey('');
    } catch (err) {
      toast.error(`Failed to upload: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={val => {
        onOpenChange(val);
        if (!val) {
          setSelectedFile(null);
          setKey('');
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-gilroy font-semibold text-blue-950">Upload File</DialogTitle>
          <DialogDescription className="font-gilroy">
            Upload a file to <code className="font-mono">{bucket}</code>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="font-gilroy font-medium text-charcoal-700">File</Label>
            <input
              ref={fileInputRef}
              type="file"
              onChange={handleFileSelect}
              className="block w-full text-sm text-charcoal-600 font-gilroy
                file:mr-4 file:py-2 file:px-4
                file:rounded-md file:border-0
                file:text-sm file:font-medium file:font-gilroy
                file:bg-blue-50 file:text-blue-700
                hover:file:bg-blue-100"
            />
          </div>
          <div className="space-y-2">
            <Label className="font-gilroy font-medium text-charcoal-700">Object Key</Label>
            <Input
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="path/to/file.txt"
              className="font-mono"
            />
            <p className="text-tiny text-muted-foreground font-gilroy">
              Full path within the bucket
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="font-gilroy">
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={uploadMutation.isPending || !selectedFile || !key}
            className="font-gilroy bg-blue-950 hover:bg-blue-900"
          >
            {uploadMutation.isPending ? 'Uploading...' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

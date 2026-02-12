import { useState, useMemo } from 'react';
import {
  useRoutes,
  useCreateRoute,
  useUpdateRoute,
  useDeleteRoute,
  useToggleRoute,
  useMigrateRoute,
  useDebounce,
} from '@/hooks';
import { useRoutesFilters, SUPPORTED_DOMAINS, type SupportedDomain } from '@/context';
import type { Route, CreateRouteInput, UpdateRouteInput, R2BucketName } from '@/lib/schemas';
import { R2_BUCKETS } from '@/lib/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LinkPreview } from '@/components/link-preview';
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
  DialogTrigger,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Power,
  PowerOff,
  ExternalLink,
  Search,
  X,
  Info,
} from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { toast } from 'sonner';

function RouteTypeBadge({ type }: { type: Route['type'] }) {
  const styles: Record<Route['type'], string> = {
    redirect: 'bg-blue-100 text-blue-700 border-blue-200',
    proxy: 'bg-gold-100 text-gold-700 border-gold-200',
    r2: 'bg-charcoal-100 text-charcoal-700 border-charcoal-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-tiny font-gilroy font-medium border ${styles[type]}`}
    >
      {type}
    </span>
  );
}

type RouteFormProps =
  | {
      mode: 'create';
      route?: undefined;
      onSubmit: (data: CreateRouteInput, domain: string) => void;
      onCancel: () => void;
      isSubmitting: boolean;
    }
  | {
      mode: 'edit';
      route: Route;
      onSubmit: (data: UpdateRouteInput, pathChanged: boolean, newPath?: string) => void;
      onCancel: () => void;
      isSubmitting: boolean;
    };

function RouteForm(props: RouteFormProps) {
  const { mode, route, onSubmit, onCancel, isSubmitting } = props;

  const [formData, setFormData] = useState({
    path: route?.path || '',
    type: route?.type || 'redirect',
    target: route?.target || '',
    statusCode: route?.statusCode || 302,
    preserveQuery: route?.preserveQuery ?? true,
    preservePath: route?.preservePath ?? false,
    cacheControl: route?.cacheControl || '',
    hostHeader: route?.hostHeader || '',
    forceDownload: route?.forceDownload ?? false,
    bucket: (route?.bucket || 'files') as R2BucketName,
    enabled: route?.enabled ?? true,
    domain: 'henrychong.com' as SupportedDomain, // Default to henrychong.com
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const baseData = {
      type: formData.type as Route['type'],
      target: formData.target,
      statusCode:
        formData.type === 'redirect' ? (formData.statusCode as 301 | 302 | 307 | 308) : undefined,
      preserveQuery: formData.preserveQuery,
      preservePath: formData.preservePath,
      cacheControl: formData.cacheControl || undefined,
      hostHeader: formData.type === 'proxy' ? formData.hostHeader || undefined : undefined,
      forceDownload: formData.type === 'r2' ? formData.forceDownload : undefined,
      bucket: formData.type === 'r2' ? formData.bucket : undefined,
      enabled: formData.enabled,
    };

    if (mode === 'create') {
      onSubmit({ ...baseData, path: formData.path } as CreateRouteInput, formData.domain);
    } else {
      const pathChanged = formData.path !== route.path;
      onSubmit(baseData as UpdateRouteInput, pathChanged, pathChanged ? formData.path : undefined);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Domain selector - only for create mode */}
      {!route && (
        <div className="space-y-2">
          <Label htmlFor="domain" className="font-gilroy font-medium text-charcoal-700">
            Domain
          </Label>
          <Select
            value={formData.domain}
            onValueChange={value => setFormData({ ...formData, domain: value as SupportedDomain })}
          >
            <SelectTrigger className="font-mono">
              <SelectValue placeholder="Select domain" />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_DOMAINS.map(domain => (
                <SelectItem key={domain} value={domain} className="font-mono text-small">
                  {domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-tiny text-muted-foreground font-gilroy">
            Domain where this route will be created
          </p>
        </div>
      )}

      {/* Path field - shown in both create and edit modes */}
      <div className="space-y-2">
        <Label htmlFor="path" className="font-gilroy font-medium text-charcoal-700">
          Path
        </Label>
        <Input
          id="path"
          value={formData.path}
          onChange={e => setFormData({ ...formData, path: e.target.value })}
          placeholder="/example"
          required
          className="font-mono"
        />
        {mode === 'create' && (
          <p className="text-tiny text-muted-foreground font-gilroy">Must start with /</p>
        )}
        {mode === 'edit' && formData.path !== route.path && (
          <p className="text-tiny text-amber-600 font-gilroy">
            ⚠️ Changing the path will migrate this route
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="type" className="font-gilroy font-medium text-charcoal-700">
          Type
        </Label>
        <Select
          value={formData.type}
          onValueChange={value => setFormData({ ...formData, type: value as Route['type'] })}
        >
          <SelectTrigger className="font-gilroy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="redirect" className="font-gilroy">
              Redirect
            </SelectItem>
            <SelectItem value="proxy" className="font-gilroy">
              Proxy
            </SelectItem>
            <SelectItem value="r2" className="font-gilroy">
              R2
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <Label htmlFor="target" className="font-gilroy font-medium text-charcoal-700">
            Target
          </Label>
          {formData.type === 'r2' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <p>
                  Enter the file path within the selected R2 bucket. This is the object key — just
                  the filename or folder path, not a URL.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Examples:
                  <br />• <code>bio.pdf</code> — file in bucket root
                  <br />• <code>images/header.jpg</code> — file in subfolder
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <Input
          id="target"
          value={formData.target}
          onChange={e => setFormData({ ...formData, target: e.target.value })}
          placeholder={formData.type === 'r2' ? 'bio.pdf' : 'https://example.com'}
          required
          className="font-mono"
        />
        {(formData.type === 'redirect' || formData.type === 'proxy') && (
          <LinkPreview url={formData.target} enabled={formData.target.length > 0} />
        )}
      </div>

      {formData.type === 'redirect' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="statusCode" className="font-gilroy font-medium text-charcoal-700">
              Status Code
            </Label>
            <Select
              value={String(formData.statusCode)}
              onValueChange={value =>
                setFormData({ ...formData, statusCode: Number(value) as 301 | 302 | 307 | 308 })
              }
            >
              <SelectTrigger className="font-gilroy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="301" className="font-gilroy">
                  301 (Permanent)
                </SelectItem>
                <SelectItem value="302" className="font-gilroy">
                  302 (Temporary)
                </SelectItem>
                <SelectItem value="307" className="font-gilroy">
                  307 (Temporary, preserve method)
                </SelectItem>
                <SelectItem value="308" className="font-gilroy">
                  308 (Permanent, preserve method)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-charcoal-200 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="preserveQuery" className="font-gilroy font-medium text-charcoal-700">
                Preserve Query String
              </Label>
              <p className="text-tiny text-muted-foreground font-gilroy">
                Pass query parameters to the target URL
              </p>
            </div>
            <Switch
              id="preserveQuery"
              checked={formData.preserveQuery}
              onCheckedChange={checked => setFormData({ ...formData, preserveQuery: checked })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-charcoal-200 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="preservePath" className="font-gilroy font-medium text-charcoal-700">
                Preserve Path
              </Label>
              <p className="text-tiny text-muted-foreground font-gilroy">
                Append the URL path to the target (for wildcard routes)
              </p>
            </div>
            <Switch
              id="preservePath"
              checked={formData.preservePath}
              onCheckedChange={checked => setFormData({ ...formData, preservePath: checked })}
            />
          </div>
        </>
      )}

      {formData.type === 'r2' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="bucket" className="font-gilroy font-medium text-charcoal-700">
              R2 Bucket
            </Label>
            <Select
              value={formData.bucket}
              onValueChange={value => setFormData({ ...formData, bucket: value as R2BucketName })}
            >
              <SelectTrigger className="font-mono">
                <SelectValue placeholder="Select bucket" />
              </SelectTrigger>
              <SelectContent>
                {R2_BUCKETS.map(bucket => (
                  <SelectItem key={bucket} value={bucket} className="font-mono text-small">
                    {bucket}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-tiny text-muted-foreground font-gilroy">
              R2 bucket to serve files from
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-charcoal-200 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="forceDownload" className="font-gilroy font-medium text-charcoal-700">
                Force Download
              </Label>
              <p className="text-tiny text-muted-foreground font-gilroy">
                Force browser to download file instead of displaying inline
              </p>
            </div>
            <Switch
              id="forceDownload"
              checked={formData.forceDownload}
              onCheckedChange={checked => setFormData({ ...formData, forceDownload: checked })}
            />
          </div>
        </>
      )}

      {formData.type === 'proxy' && (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            <Label htmlFor="hostHeader" className="font-gilroy font-medium text-charcoal-700">
              Host Header (optional)
            </Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                Override the Host header sent to the origin. Use when proxying to CDNs like Webflow
                that use Host-based virtual hosting.
              </TooltipContent>
            </Tooltip>
          </div>
          <Input
            id="hostHeader"
            value={formData.hostHeader}
            onChange={e => setFormData({ ...formData, hostHeader: e.target.value })}
            placeholder="example.com"
            className="font-mono"
          />
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <Label htmlFor="cacheControl" className="font-gilroy font-medium text-charcoal-700">
            Cache-Control (optional)
          </Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              Controls how long browsers remember this content. Leave blank unless you have a
              specific reason to change it.
            </TooltipContent>
          </Tooltip>
        </div>
        <Input
          id="cacheControl"
          value={formData.cacheControl}
          onChange={e => setFormData({ ...formData, cacheControl: e.target.value })}
          placeholder="max-age=3600"
          className="font-mono"
        />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} className="font-gilroy">
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="font-gilroy bg-blue-950 hover:bg-blue-900"
        >
          {isSubmitting ? 'Saving...' : route ? 'Update' : 'Create'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RoutesPage() {
  // Filter state from context (persists during navigation)
  const { filters, setFilters } = useRoutesFilters();
  const debouncedSearch = useDebounce(filters.search || '', 300);

  // Fetch routes for the selected domain (server-side filtering)
  const { data: routes, isLoading, error } = useRoutes(filters.domain);
  const createRoute = useCreateRoute();
  const updateRoute = useUpdateRoute();
  const deleteRoute = useDeleteRoute();
  const toggleRoute = useToggleRoute();
  const migrateRoute = useMigrateRoute();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editRoute, setEditRoute] = useState<Route | null>(null);
  const [deleteConfirmRoute, setDeleteConfirmRoute] = useState<Route | null>(null);
  const [migrationConfirm, setMigrationConfirm] = useState<{
    route: Route;
    newPath: string;
    updates: UpdateRouteInput;
  } | null>(null);

  // Filter and sort routes (client-side)
  const filteredRoutes = useMemo(() => {
    if (!routes) return [];

    let result = [...routes];

    // Filter by search (path)
    if (debouncedSearch) {
      const searchLower = debouncedSearch.toLowerCase();
      result = result.filter(route => route.path.toLowerCase().includes(searchLower));
    }

    // Filter by type
    if (filters.type) {
      result = result.filter(route => route.type === filters.type);
    }

    // Filter by enabled status
    if (filters.enabled !== undefined) {
      result = result.filter(route => (route.enabled !== false) === filters.enabled);
    }

    // Sort by createdAt descending (newest first)
    result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return result;
  }, [routes, debouncedSearch, filters.type, filters.enabled]);

  // Check if any filters are active
  const hasActiveFilters = !!(
    filters.domain ||
    filters.search ||
    filters.type ||
    filters.enabled !== undefined
  );

  const handleResetFilters = () => {
    setFilters({});
  };

  const handleCreate = async (data: CreateRouteInput, domain: string) => {
    try {
      await createRoute.mutateAsync({ data, domain });
      toast.success(`Route created successfully on ${domain}`);
      setCreateDialogOpen(false);
    } catch (err) {
      toast.error(
        `Failed to create route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const handleUpdate = async (data: UpdateRouteInput, pathChanged: boolean, newPath?: string) => {
    if (!editRoute) return;

    if (pathChanged && newPath) {
      // Show confirmation dialog instead of immediately updating
      setMigrationConfirm({
        route: editRoute,
        newPath,
        updates: data,
      });
      return;
    }

    // Normal update (no path change)
    try {
      await updateRoute.mutateAsync({
        path: editRoute.path,
        data,
        domain: editRoute.domain ?? filters.domain,
      });
      toast.success('Route updated successfully');
      setEditRoute(null);
    } catch (err) {
      toast.error(
        `Failed to update route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirmRoute) return;
    try {
      // Pass domain from route when in all-domains view to ensure correct mutation
      await deleteRoute.mutateAsync({
        path: deleteConfirmRoute.path,
        domain: deleteConfirmRoute.domain ?? filters.domain,
      });
      toast.success('Route deleted successfully');
      setDeleteConfirmRoute(null);
    } catch (err) {
      toast.error(
        `Failed to delete route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const handleToggle = async (route: Route) => {
    try {
      // Pass domain from route when in all-domains view to ensure correct mutation
      await toggleRoute.mutateAsync({
        path: route.path,
        enabled: !route.enabled,
        domain: route.domain ?? filters.domain,
      });
      toast.success(`Route ${route.enabled ? 'disabled' : 'enabled'}`);
    } catch (err) {
      toast.error(
        `Failed to toggle route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const handleConfirmMigration = async () => {
    if (!migrationConfirm) return;

    const { route, newPath } = migrationConfirm;
    const domain = route.domain ?? filters.domain;

    try {
      // Migrate the route to new path (preserves all config)
      await migrateRoute.mutateAsync({
        oldPath: route.path,
        newPath,
        domain,
      });

      setMigrationConfirm(null);
      setEditRoute(null);
      toast.success(`Route migrated from ${route.path} to ${newPath}`);
    } catch (err) {
      toast.error(
        `Failed to migrate route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-gilroy font-bold text-blue-950">Routes</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive font-gilroy">Failed to load routes: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 flex-1">
          <h1 className="text-huge font-gilroy font-bold text-blue-950">Routes</h1>
          <div className="h-1 flex-1 rounded-full gradient-accent-bar opacity-30" />
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="font-gilroy bg-blue-950 hover:bg-blue-900 ml-4">
              <Plus className="h-4 w-4 mr-2" />
              New Route
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-gilroy font-semibold text-blue-950">
                Create Route
              </DialogTitle>
              <DialogDescription className="font-gilroy">
                Add a new route to the edge router.
              </DialogDescription>
            </DialogHeader>
            <RouteForm
              mode="create"
              onSubmit={handleCreate}
              onCancel={() => setCreateDialogOpen(false)}
              isSubmitting={createRoute.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Domain Filter */}
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">Domain</label>
          <Select
            value={filters.domain || 'all'}
            onValueChange={value =>
              setFilters({
                ...filters,
                domain: value === 'all' ? undefined : (value as typeof filters.domain),
              })
            }
          >
            <SelectTrigger className="w-48 font-gilroy">
              <SelectValue placeholder="All domains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-gilroy">
                All domains
              </SelectItem>
              {SUPPORTED_DOMAINS.map(domain => (
                <SelectItem
                  key={domain}
                  value={domain}
                  className="font-gilroy font-mono text-small"
                >
                  {domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Search Input */}
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">Path</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" />
            <Input
              type="text"
              placeholder="Search paths..."
              value={filters.search || ''}
              onChange={e => setFilters({ ...filters, search: e.target.value || undefined })}
              className="pl-8 w-48 font-gilroy"
            />
          </div>
        </div>

        {/* Type Filter */}
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">Type</label>
          <Select
            value={filters.type || 'all'}
            onValueChange={value =>
              setFilters({
                ...filters,
                type: value === 'all' ? undefined : (value as 'redirect' | 'proxy' | 'r2'),
              })
            }
          >
            <SelectTrigger className="w-32 font-gilroy">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-gilroy">
                All types
              </SelectItem>
              <SelectItem value="redirect" className="font-gilroy">
                Redirect
              </SelectItem>
              <SelectItem value="proxy" className="font-gilroy">
                Proxy
              </SelectItem>
              <SelectItem value="r2" className="font-gilroy">
                R2
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Enabled Filter */}
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">Status</label>
          <Select
            value={filters.enabled === undefined ? 'all' : filters.enabled ? 'active' : 'disabled'}
            onValueChange={value =>
              setFilters({
                ...filters,
                enabled: value === 'all' ? undefined : value === 'active',
              })
            }
          >
            <SelectTrigger className="w-32 font-gilroy">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-gilroy">
                All
              </SelectItem>
              <SelectItem value="active" className="font-gilroy">
                Active
              </SelectItem>
              <SelectItem value="disabled" className="font-gilroy">
                Disabled
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Reset Button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleResetFilters}
            className="font-gilroy text-charcoal-500 hover:text-charcoal-700"
          >
            <X className="h-4 w-4 mr-1" />
            Reset
          </Button>
        )}
      </div>

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="font-gilroy font-semibold text-blue-950">All Routes</CardTitle>
          <CardDescription className="font-gilroy">
            {isLoading
              ? 'Loading...'
              : `Showing ${filteredRoutes.length} of ${routes?.length || 0} routes${hasActiveFilters ? ' (filtered)' : ''}`}
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
                  {!filters.domain && (
                    <TableHead className="font-gilroy font-semibold text-charcoal-700">
                      Domain
                    </TableHead>
                  )}
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Path
                  </TableHead>
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Type
                  </TableHead>
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Target
                  </TableHead>
                  <TableHead className="font-gilroy font-semibold text-charcoal-700">
                    Status
                  </TableHead>
                  <TableHead className="w-[70px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRoutes.map(route => (
                  <TableRow
                    key={route.domain ? `${route.domain}:${route.path}` : route.path}
                    className="hover:bg-gold-50/50 transition-colors cursor-pointer"
                    onClick={() => setEditRoute(route)}
                  >
                    {!filters.domain && (
                      <TableCell className="font-mono text-small text-charcoal-600">
                        {route.domain || '-'}
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-small font-medium text-blue-600">
                      {route.path}
                    </TableCell>
                    <TableCell>
                      <RouteTypeBadge type={route.type} />
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate font-mono text-small text-charcoal-600">
                      {route.target}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-tiny font-gilroy font-medium border ${
                          route.enabled !== false
                            ? 'bg-green-100 text-green-700 border-green-200'
                            : 'bg-charcoal-100 text-charcoal-500 border-charcoal-200'
                        }`}
                      >
                        {route.enabled !== false ? 'Active' : 'Disabled'}
                      </span>
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="hover:bg-blue-50">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {route.type === 'redirect' && (
                            <DropdownMenuItem asChild className="font-gilroy">
                              <a href={route.target} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Open Target
                              </a>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setEditRoute(route)}
                            className="font-gilroy"
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleToggle(route)}
                            className="font-gilroy"
                          >
                            {route.enabled !== false ? (
                              <>
                                <PowerOff className="h-4 w-4 mr-2" />
                                Disable
                              </>
                            ) : (
                              <>
                                <Power className="h-4 w-4 mr-2" />
                                Enable
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setDeleteConfirmRoute(route)}
                            className="text-destructive font-gilroy"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredRoutes.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={filters.domain ? 5 : 6}
                      className="text-center text-muted-foreground font-gilroy"
                    >
                      {hasActiveFilters
                        ? 'No routes match the current filters'
                        : 'No routes configured'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editRoute} onOpenChange={() => setEditRoute(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-gilroy font-semibold text-blue-950">
              Edit Route
            </DialogTitle>
            <DialogDescription className="font-gilroy">
              Update route configuration for{' '}
              <code className="font-mono text-blue-600">{editRoute?.path}</code>
            </DialogDescription>
          </DialogHeader>
          {editRoute && (
            <RouteForm
              mode="edit"
              route={editRoute}
              onSubmit={handleUpdate}
              onCancel={() => setEditRoute(null)}
              isSubmitting={updateRoute.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmRoute} onOpenChange={() => setDeleteConfirmRoute(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-gilroy font-semibold text-blue-950">
              Delete Route
            </DialogTitle>
            <DialogDescription className="font-gilroy">
              Are you sure you want to delete the route{' '}
              <code className="font-mono text-blue-600">{deleteConfirmRoute?.path}</code>? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmRoute(null)}
              className="font-gilroy"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteRoute.isPending}
              className="font-gilroy"
            >
              {deleteRoute.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Migration Confirmation Dialog */}
      <AlertDialog open={!!migrationConfirm} onOpenChange={() => setMigrationConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-gilroy">Confirm Path Change</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  You are changing the path from{' '}
                  <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">
                    {migrationConfirm?.route.path}
                  </code>{' '}
                  to{' '}
                  <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">
                    {migrationConfirm?.newPath}
                  </code>
                </p>
                <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-amber-800">
                  <p className="font-medium">⚠️ Important:</p>
                  <ul className="list-disc list-inside mt-1 text-sm space-y-1">
                    <li>
                      The old path will <strong>stop working immediately</strong>
                    </li>
                    <li>Any existing bookmarks or links will break</li>
                    <li>The route's creation date and settings will be preserved</li>
                  </ul>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-gilroy">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmMigration}
              className="bg-blue-600 hover:bg-blue-700 font-gilroy"
              disabled={migrateRoute.isPending || updateRoute.isPending}
            >
              {migrateRoute.isPending ? 'Migrating...' : 'Migrate Route'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

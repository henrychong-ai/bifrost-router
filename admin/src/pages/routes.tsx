import {
  getContentTypeFromKey,
  LINK_NAMING_HINT,
  linkNamingIssues,
  QRDesignSchema,
  renderQrSvg,
} from '@bifrost/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Copy,
  ExternalLink,
  HardDrive,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  QrCode,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CredentialTargetDialog } from '@/components/credential-target-dialog';
import { FieldHint, InfoHint } from '@/components/field-hint';
import { LinkNamingWarnings } from '@/components/link-naming-warnings';
import { LinkPreview } from '@/components/link-preview';
import { PaginationControls } from '@/components/pagination-controls';
import { QrPreview } from '@/components/qr-preview';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SUPPORTED_DOMAINS, type SupportedDomain, useRoutesFilters } from '@/context';
import {
  routeKeys,
  useCreateQr,
  useCreateRoute,
  useDebounce,
  useDeleteRoute,
  useMigrateRoute,
  usePendingRouteAdmission,
  usePendingRouteView,
  usePrefetchAllDomainRoutes,
  useQrCodes,
  useRoutes,
  useToggleRoute,
  useTransferRoute,
  useUpdateRoute,
} from '@/hooks';
import { isRouteSourceChanged } from '@/lib/api-error';
import { getPersistedPageSize, getR2ObjectUrl, persistPageSize } from '@/lib/constants';
import { credentialTargetParametersFromError } from '@/lib/credential-target';
import { navEditRoute, useClearNavigationState } from '@/lib/navigation-state';
import type { QrPageNavState } from '@/lib/qr-page-domain';
import {
  type RouteFormValues,
  routeEditPatch,
  routeFormValues,
  routeTargetProblem,
  toUpdateRouteInput,
  unappliedPatchFields,
  unsupportedPatchFields,
} from '@/lib/route-patch';
import { keyOfInput, keyOfStored, pendingRoutes, type RouteList } from '@/lib/route-pending';
import { requireWriteDomain } from '@/lib/route-write-domain';
import type { CreateRouteInput, InvalidRouteRow, Route, UpdateRouteInput } from '@/lib/schemas';
import { isR2BucketName, isRedirectStatusCode, R2_BUCKETS } from '@/lib/schemas';
import { downloadPng, downloadSvg } from '@/lib/svg-to-png';
import { copyToClipboard } from '@/lib/utils';
import {
  applyUtm,
  parseUtm,
  UTM_FIELD_HELP,
  UTM_KEYS,
  type UtmKey,
  type UtmValues,
  uppercaseUtmKeys,
} from '@/lib/utm';

/** What the dashboard says when a route changed since its dialog opened (v1.40.0). */
const ROUTE_CHANGED_TOAST =
  'This route changed since you opened it, so nothing was saved. It has been reloaded: open it again to edit.';

/**
 * The toast for a save or migration whose route this session's own write
 * answered with another version (or removed) while its dialog was open
 * (v1.41.1): nothing is sent.
 */
const ROUTE_CHANGED_WHILE_OPEN_TOAST =
  'This route changed while it was open. Reopen it to edit the current version.';

function RouteTypeBadge({ type }: { type: Route['type'] }) {
  const styles: Record<Route['type'], string> = {
    redirect: 'bg-blue-100 text-blue-700 border-blue-200',
    proxy: 'bg-gold-100 text-gold-700 border-gold-200',
    r2: 'bg-charcoal-100 text-charcoal-700 border-charcoal-200',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-tiny font-inter font-medium border ${styles[type]}`}
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
      allDomainRoutes?: Map<string, Route[]>;
    }
  | {
      mode: 'edit';
      route: Route;
      onSubmit: (data: UpdateRouteInput, pathChanged: boolean, newPath?: string) => void;
      onCancel: () => void;
      isSubmitting: boolean;
      allowedDomains?: string[];
      onTransfer?: (toDomain: string) => void;
      allDomainRoutes?: Map<string, Route[]>;
    };

function RouteForm(props: RouteFormProps) {
  const { mode, route, onSubmit, onCancel, isSubmitting } = props;
  const allDomainRoutes = props.allDomainRoutes;
  const onTransfer = mode === 'edit' ? props.onTransfer : undefined;
  const allowedDomains = mode === 'edit' ? (props.allowedDomains ?? []) : [];
  const navigate = useNavigate();

  // What the form shows when it opens (v1.38.0): a stored route's values as
  // displayed (an unset Force Download off, an unset or unknown bucket
  // `files`, an unknown status code 302), else the create defaults. An edit
  // sends only the fields whose final value differs from these
  // (routeEditPatch), so an untouched field is never sent, whatever the
  // stored record holds.
  const [opened] = useState<RouteFormValues>(() =>
    route
      ? routeFormValues(route)
      : {
          type: 'redirect',
          target: '',
          statusCode: 302,
          preserveQuery: true,
          preservePath: false,
          cacheControl: '',
          hostHeader: '',
          forceDownload: false,
          bucket: 'files',
          enabled: true,
        },
  );
  const [formData, setFormData] = useState({
    ...opened,
    path: route?.path || '',
    domain: 'example.com' as SupportedDomain, // Default to example.com
  });

  // UTM tracking (v1.38.0; redirect targets only, dashboard only). A proxy
  // replaces the target's query with the visitor's whenever the visitor sends
  // one, so tags in a proxy target would not reliably reach the upstream; an
  // r2 target is an object key. Overrides survive target edits; untouched
  // values always derive from the current URL.
  const [utmEdits, setUtmEdits] = useState<UtmValues>({});
  const parsedUtm = useMemo(() => parseUtm(formData.target), [formData.target]);
  // Target keys with capitals: applyUtm saves them lowercased, like an edit.
  const convertedUtmKeys = useMemo(() => uppercaseUtmKeys(formData.target), [formData.target]);
  // The target as the user left it: the text changed, a UTM field was
  // edited, or the TYPE changed (v1.38.0: the target then serves another kind
  // of route, so it is checked for it). Only then is the composed target
  // saved and checked; an untouched stored target (capitals in its UTM
  // values included) is never rewritten.
  const targetTouched =
    mode === 'create' ||
    formData.target !== route.target ||
    formData.type !== route.type ||
    Object.keys(utmEdits).length > 0;
  const finalTarget = useMemo(() => {
    // An untouched stored target is saved as it is, so one that is not a URL
    // does not block editing other fields
    if (!targetTouched) return route?.target ?? formData.target;
    if (formData.type === 'r2') return formData.target;
    if (!parsedUtm) return null;
    return formData.type === 'redirect' ? applyUtm(formData.target, utmEdits) : formData.target;
  }, [formData.type, formData.target, parsedUtm, utmEdits, targetTouched, route]);
  // What keeps a touched target from being saved for its type: a redirect
  // needs an absolute URL, a proxy an http(s) URL, an r2 route an object key
  const targetError = !targetTouched
    ? null
    : finalTarget === null
      ? 'Enter a valid absolute target URL before saving.'
      : routeTargetProblem(formData.type, finalTarget);
  // An edit's dirty fields, and any stored value no write accepts that they
  // would send (a status code or bucket kept through a type change)
  const editPatch =
    mode === 'edit' && finalTarget !== null
      ? routeEditPatch(opened, { ...formData, target: finalTarget })
      : {};
  const unsupported = unsupportedPatchFields(editPatch);
  // Keys that will carry a value in the saved target (edited or kept from it).
  const activeUtmKeys = UTM_KEYS.filter(key => (utmEdits[key] ?? parsedUtm?.[key] ?? '').trim());
  const utmFieldStatus = (key: UtmKey) => {
    const edit = utmEdits[key];
    if (edit !== undefined) {
      return edit.trim()
        ? 'Edited: replaces every occurrence of this key in the target.'
        : 'Cleared: removes every occurrence of this key from the target.';
    }
    return convertedUtmKeys.includes(key)
      ? 'Converted to lowercase once you edit the target or a UTM field: then replaces every occurrence of this key.'
      : 'From the target: left byte-identical unless you edit this field.';
  };

  // Advisory link naming (v1.38.0), r2 links only: a redirect or proxy names
  // a destination, while an r2 link stands in for a document whose file changes
  const namingIssues =
    formData.type === 'r2' && formData.path ? linkNamingIssues(formData.path, formData.target) : [];

  // Duplicate target detection across all accessible domains
  const duplicateTargets = useMemo(() => {
    if (!finalTarget || !allDomainRoutes) return [];
    const targetLower = finalTarget.toLowerCase();
    const matches: { domain: string; path: string }[] = [];
    for (const [domain, domainRoutes] of allDomainRoutes) {
      for (const r of domainRoutes) {
        if (r.target.toLowerCase() === targetLower) {
          if (mode === 'edit' && r.path === route?.path && domain === route?.domain) continue;
          matches.push({ domain, path: r.path });
        }
      }
    }
    return matches;
  }, [finalTarget, allDomainRoutes, mode, route]);

  // R2 file preview
  const r2PreviewUrl =
    formData.type === 'r2' && formData.target
      ? getR2ObjectUrl(formData.bucket, formData.target)
      : null;
  const r2ContentType =
    formData.type === 'r2' && formData.target ? getContentTypeFromKey(formData.target) : null;
  const isR2Image = r2ContentType?.startsWith('image/') ?? false;
  const isR2Pdf = r2ContentType === 'application/pdf';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // A target the type cannot serve: nothing is saved, the alert says why
    if (finalTarget === null || targetError !== null) return;

    if (mode === 'create') {
      onSubmit(
        {
          path: formData.path,
          type: formData.type,
          target: finalTarget,
          statusCode:
            formData.type === 'redirect' && isRedirectStatusCode(formData.statusCode)
              ? formData.statusCode
              : undefined,
          preserveQuery: formData.preserveQuery,
          preservePath: formData.preservePath,
          cacheControl: formData.cacheControl || undefined,
          hostHeader: formData.type === 'proxy' ? formData.hostHeader || undefined : undefined,
          forceDownload: formData.type === 'r2' ? formData.forceDownload : undefined,
          bucket:
            formData.type === 'r2' && isR2BucketName(formData.bucket) ? formData.bucket : undefined,
          enabled: formData.enabled,
        },
        formData.domain,
      );
    } else {
      const pathChanged = formData.path !== route.path;
      // Only the fields that changed since the dialog opened (v1.38.0): an
      // untouched field written under older limits (an over-cap target) is
      // never re-sent and refused; a value no write accepts is never sent
      const updates = toUpdateRouteInput(editPatch);
      if (updates === null) return;
      onSubmit(updates, pathChanged, pathChanged ? formData.path : undefined);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Route Preview */}
      {(formData.type === 'redirect' || formData.type === 'proxy') && (
        <LinkPreview url={finalTarget ?? ''} enabled={!!finalTarget} />
      )}
      {isR2Image && r2PreviewUrl && (
        <div className="overflow-hidden rounded-lg border border-charcoal-100 bg-muted/30">
          <img
            src={r2PreviewUrl}
            alt={formData.target}
            className="max-h-[200px] w-full object-contain"
            onError={e => {
              e.currentTarget.parentElement!.style.display = 'none';
            }}
          />
        </div>
      )}
      {isR2Pdf && r2PreviewUrl && (
        <div className="overflow-hidden rounded-lg border border-charcoal-100 bg-muted/30">
          <object
            data={r2PreviewUrl}
            type="application/pdf"
            title={formData.target}
            className="h-[250px] w-full"
          >
            <p className="p-4 text-center text-sm text-muted-foreground">
              Unable to preview PDF.{' '}
              <a
                href={r2PreviewUrl}
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
      {/* Target link */}
      {formData.type === 'r2' && r2PreviewUrl && (
        <div className="flex items-center gap-4">
          <a
            href={r2PreviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-blue-600"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{r2PreviewUrl.replace('https://', '')}</span>
          </a>
          <button
            type="button"
            onClick={() => void copyToClipboard(r2PreviewUrl)}
            className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-blue-50 hover:text-blue-600"
            title="Copy file URL"
          >
            <Copy className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              onCancel();
              void navigate(
                `/storage?bucket=${encodeURIComponent(formData.bucket)}&open=${encodeURIComponent(formData.target)}`,
              );
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-inter font-medium text-blue-700 transition-colors hover:bg-blue-100 hover:text-blue-950 whitespace-nowrap"
          >
            <HardDrive className="h-3 w-3 shrink-0" />
            View in Storage
          </button>
        </div>
      )}
      {(formData.type === 'redirect' || formData.type === 'proxy') && formData.target && (
        <div className="flex items-center gap-1.5">
          <a
            href={formData.target}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-blue-600"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">
              {formData.target.replace(/^https?:\/\//, '')}
            </span>
          </a>
          <button
            type="button"
            onClick={() => void copyToClipboard(formData.target)}
            className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-blue-50 hover:text-blue-600"
            title="Copy target URL"
          >
            <Copy className="size-3" />
          </button>
        </div>
      )}

      {/* Domain selector - only for create mode */}
      {!route && (
        <div className="space-y-2">
          <Label htmlFor="domain" className="font-inter font-medium text-charcoal-700">
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
          <p className="text-tiny text-muted-foreground font-inter">
            Domain where this route will be created
          </p>
        </div>
      )}

      {/* Domain display in edit mode */}
      {mode === 'edit' && route?.domain && (
        <div className="space-y-2">
          <Label className="font-inter font-medium text-charcoal-700">Domain</Label>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-charcoal-200 bg-charcoal-50 px-2.5 py-0.5 font-mono text-tiny font-medium text-charcoal-700">
              {route.domain}
            </span>
          </div>
        </div>
      )}

      {/* Transfer to domain dropdown - edit mode only */}
      {mode === 'edit' && route?.domain && allowedDomains.length > 1 && onTransfer && (
        <div className="space-y-2">
          <Label className="font-inter font-medium text-charcoal-700">Transfer to Domain</Label>
          <Select value="" onValueChange={value => onTransfer(value)}>
            <SelectTrigger className="font-mono">
              <SelectValue placeholder="Select domain to transfer..." />
            </SelectTrigger>
            <SelectContent>
              {allowedDomains
                .filter(d => d !== route.domain)
                .map(d => (
                  <SelectItem key={d} value={d} className="font-mono text-small">
                    {d}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <p className="text-tiny text-muted-foreground font-inter">
            Move this route to a different domain (path stays the same)
          </p>
        </div>
      )}

      {/* Path field - shown in both create and edit modes */}
      <div className="space-y-2">
        <Label htmlFor="path" className="font-inter font-medium text-charcoal-700">
          Path
        </Label>
        <Input
          id="path"
          value={formData.path}
          onChange={e => setFormData({ ...formData, path: e.target.value.toLowerCase() })}
          placeholder="/my-route"
          required
          className="font-mono"
        />
        {mode === 'create' && (
          <p className="text-tiny text-muted-foreground font-inter">
            Must start with / — lowercased automatically; use hyphens not spaces (kebab-case)
          </p>
        )}
        {formData.type === 'r2' && (
          <p className="text-tiny text-muted-foreground font-inter">{LINK_NAMING_HINT}</p>
        )}
        {mode === 'edit' && formData.path !== route.path && (
          <p className="text-tiny text-amber-600 font-inter">
            Changing the path will migrate this route
          </p>
        )}
        <LinkNamingWarnings issues={namingIssues} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="type" className="font-inter font-medium text-charcoal-700">
          Type
        </Label>
        <Select
          value={formData.type}
          onValueChange={value => setFormData({ ...formData, type: value as Route['type'] })}
        >
          <SelectTrigger className="font-inter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="redirect" className="font-inter">
              Redirect
            </SelectItem>
            <SelectItem value="proxy" className="font-inter">
              Proxy
            </SelectItem>
            <SelectItem value="r2" className="font-inter">
              R2
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <Label htmlFor="target" className="font-inter font-medium text-charcoal-700">
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
          aria-invalid={!!formData.target && targetError !== null}
          aria-describedby={formData.type === 'redirect' ? 'target-utm-help' : undefined}
          className="font-mono"
        />
        {formData.type === 'redirect' && (
          <p id="target-utm-help" className="text-xs text-muted-foreground">
            Changing the target refreshes untouched UTM fields. Edited fields keep overriding the
            new target until you choose “Reset to target URL's values”.
          </p>
        )}
        {!!formData.target && targetError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {targetError}
            {formData.type === 'redirect' && ' Your UTM edits are kept.'}
          </p>
        )}
        {duplicateTargets.length > 0 && (
          <div className="flex items-start gap-2 rounded-sm bg-blue-50 px-3 py-2">
            <Info className="mt-0.5 size-3.5 shrink-0 text-blue-600" />
            <p className="font-inter text-xs text-charcoal-700">
              Also targets:{' '}
              {duplicateTargets.slice(0, 3).map((m, i) => (
                <span key={`${m.domain}:${m.path}`}>
                  {i > 0 && ', '}
                  <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-tiny">
                    {m.path}
                  </code>
                  {m.domain !== formData.domain && (
                    <span className="text-charcoal-500"> on {m.domain}</span>
                  )}
                </span>
              ))}
              {duplicateTargets.length > 3 && (
                <span className="text-charcoal-500">, +{duplicateTargets.length - 3} more</span>
              )}
            </p>
          </div>
        )}
      </div>

      {formData.type === 'redirect' && (
        <details className="group rounded-lg border border-charcoal-200">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg p-3 [&::-webkit-details-marker]:hidden">
            <div className="space-y-0.5">
              <span className="font-inter text-sm leading-none font-medium text-charcoal-700">
                UTM tracking
              </span>
              <p className="font-inter text-tiny text-muted-foreground">
                {activeUtmKeys.length > 0
                  ? `${activeUtmKeys.length} campaign ${activeUtmKeys.length === 1 ? 'tag' : 'tags'} set: ${activeUtmKeys
                      .map(key => UTM_FIELD_HELP[key].label.toLowerCase())
                      .join(', ')}`
                  : 'Optional campaign tags for analytics (source, medium, campaign)'}
              </p>
            </div>
            <ChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="space-y-3 border-t border-charcoal-200 p-3">
            <p className="font-inter text-tiny text-muted-foreground">
              UTM values are saved in lowercase so reports group consistently: typing is lowercased
              automatically, and capitals already in the target are converted. Always use
              kebab-case, lowercase words joined with hyphens, never underscores or spaces:{' '}
              <code className="rounded-sm bg-muted px-1 font-mono whitespace-nowrap">
                spring-launch-2026
              </code>
              , not{' '}
              <code className="rounded-sm bg-muted px-1 font-mono whitespace-nowrap">
                spring_launch_2026
              </code>{' '}
              or{' '}
              <code className="rounded-sm bg-muted px-1 font-mono whitespace-nowrap">
                Spring Launch
              </code>
              .
            </p>
            <p className="font-inter text-tiny text-muted-foreground">
              Values are trimmed. Only the final target below is saved. Parameters in the target win
              over the same names on the incoming short link. Other incoming parameters are
              forwarded only when Preserve Query String is on (the default).
            </p>
            {UTM_KEYS.map(key => (
              <div key={key} className="space-y-1">
                <FieldHint
                  htmlFor={key}
                  label={`${UTM_FIELD_HELP[key].label} (${key})`}
                  hint={UTM_FIELD_HELP[key].hint}
                />
                <Input
                  id={key}
                  value={utmEdits[key] ?? parsedUtm?.[key] ?? ''}
                  onChange={e => setUtmEdits({ ...utmEdits, [key]: e.target.value.toLowerCase() })}
                  aria-describedby={`${key}-help`}
                  className="font-mono"
                />
                <p id={`${key}-help`} className="text-xs text-muted-foreground">
                  {utmFieldStatus(key)}
                </p>
              </div>
            ))}
            <div className="flex items-center gap-1.5">
              <Button type="button" variant="outline" onClick={() => setUtmEdits({})}>
                Reset to target URL's values
              </Button>
              <InfoHint
                label="Reset to target URL's values"
                hint="Clears your edits in the five fields above and shows the UTM tags already in the Target URL again. The saved target then keeps the URL's own tags (in lowercase)."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="utm-preview">Final target</Label>
              <output
                id="utm-preview"
                className="block font-mono text-xs break-all"
                aria-live="polite"
              >
                {finalTarget ?? 'Enter a valid absolute target URL to preview.'}
              </output>
            </div>
          </div>
        </details>
      )}

      {formData.type === 'redirect' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="statusCode" className="font-inter font-medium text-charcoal-700">
              Status Code
            </Label>
            <Select
              value={String(formData.statusCode)}
              onValueChange={value => setFormData({ ...formData, statusCode: Number(value) })}
            >
              <SelectTrigger id="statusCode" className="font-inter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* A stored code no write accepts is shown as it is (v1.38.0) */}
                {!isRedirectStatusCode(opened.statusCode) && (
                  <SelectItem value={String(opened.statusCode)} disabled className="font-inter">
                    {opened.statusCode} (not supported — choose another)
                  </SelectItem>
                )}
                <SelectItem value="301" className="font-inter">
                  301 (Permanent)
                </SelectItem>
                <SelectItem value="302" className="font-inter">
                  302 (Temporary)
                </SelectItem>
                <SelectItem value="307" className="font-inter">
                  307 (Temporary, preserve method)
                </SelectItem>
                <SelectItem value="308" className="font-inter">
                  308 (Permanent, preserve method)
                </SelectItem>
              </SelectContent>
            </Select>
            {!isRedirectStatusCode(formData.statusCode) && (
              <p
                role={unsupported.includes('statusCode') ? 'alert' : undefined}
                className={`text-tiny font-inter ${unsupported.includes('statusCode') ? 'text-destructive' : 'text-amber-600'}`}
              >
                Stored as {formData.statusCode}, which is not supported: choose another to change
                it.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-charcoal-200 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="preserveQuery" className="font-inter font-medium text-charcoal-700">
                Preserve Query String
              </Label>
              <p className="text-tiny text-muted-foreground font-inter">
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
              <Label htmlFor="preservePath" className="font-inter font-medium text-charcoal-700">
                Preserve Path
              </Label>
              <p className="text-tiny text-muted-foreground font-inter">
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
            <Label htmlFor="bucket" className="font-inter font-medium text-charcoal-700">
              R2 Bucket
            </Label>
            <Select
              value={formData.bucket}
              onValueChange={value => setFormData({ ...formData, bucket: value })}
            >
              <SelectTrigger id="bucket" className="font-mono">
                <SelectValue placeholder="Select bucket" />
              </SelectTrigger>
              <SelectContent>
                {/* A stored bucket no write accepts is shown as it is (v1.38.0) */}
                {!isR2BucketName(opened.bucket) && (
                  <SelectItem value={opened.bucket} disabled className="font-mono text-small">
                    {opened.bucket} (not supported — choose another)
                  </SelectItem>
                )}
                {R2_BUCKETS.map(bucket => (
                  <SelectItem key={bucket} value={bucket} className="font-mono text-small">
                    {bucket}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-tiny text-muted-foreground font-inter">
              R2 bucket to serve files from
            </p>
            {!isR2BucketName(formData.bucket) && (
              <p
                role={unsupported.includes('bucket') ? 'alert' : undefined}
                className={`text-tiny font-inter ${unsupported.includes('bucket') ? 'text-destructive' : 'text-amber-600'}`}
              >
                Stored as {formData.bucket}, which is not supported: choose another to change it.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-charcoal-200 p-3">
            <div className="space-y-0.5">
              <Label htmlFor="forceDownload" className="font-inter font-medium text-charcoal-700">
                Force Download
              </Label>
              <p className="text-tiny text-muted-foreground font-inter">
                Force browser to download file instead of displaying inline
                {mode === 'edit' &&
                  route.forceDownload === undefined &&
                  !formData.forceDownload &&
                  ' (not set: decided by the file type)'}
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
            <Label htmlFor="hostHeader" className="font-inter font-medium text-charcoal-700">
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
          <Label htmlFor="cacheControl" className="font-inter font-medium text-charcoal-700">
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
        <Button type="button" variant="outline" onClick={onCancel} className="font-inter">
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            isSubmitting || finalTarget === null || targetError !== null || unsupported.length > 0
          }
          className="font-inter bg-blue-950 hover:bg-blue-900"
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
  const location = useLocation();
  const debouncedSearch = useDebounce(filters.search || '', 300);

  // Pagination state
  const [pageSize, setPageSize] = useState(getPersistedPageSize);
  const [offset, setOffset] = useState(0);

  // QR dialog (v1.30.0): per-row
  // preview/downloads + optional save-as-QR. Dedup guard: while the dialog is
  // open, look up the domain's url-type QRs for one already linking this
  // route — soft guard only (the API allows duplicates by design).
  const navigate = useNavigate();
  const [qrRoute, setQrRoute] = useState<(Route & { domain?: string }) | null>(null);
  const createQrMutation = useCreateQr();
  // The route's own domain, else the filtered one; never a guessed default.
  // With neither, the dialog says so and saves nothing.
  const qrGuardDomain = qrRoute ? qrRoute.domain || filters.domain : undefined;
  const { data: qrGuardList } = useQrCodes(
    { domain: qrGuardDomain, type: 'url', limit: 1000 },
    { enabled: !!qrRoute && !!qrGuardDomain },
  );
  const existingLinkedQr =
    qrRoute && qrGuardList
      ? qrGuardList.items.find(
          q => q.linkedRoute?.domain === qrGuardDomain && q.linkedRoute?.path === qrRoute.path,
        )
      : undefined;

  // Reset offset when search or filters change
  const handleFilterChange = useCallback(
    (newFilters: typeof filters) => {
      setFilters(newFilters);
      setOffset(0);
    },
    [setFilters],
  );

  // Fetch routes with server-side search and pagination
  const { data, isLoading, error } = useRoutes(filters.domain, {
    search: debouncedSearch || undefined,
    limit: pageSize,
    offset,
  });

  const routes = data?.routes;
  // Records that cannot be read (v1.38.0): listed flagged, Delete only. Their
  // type and state are unknown, so a type or status filter shows none
  const invalidRoutes: InvalidRouteRow[] =
    filters.type || filters.enabled !== undefined ? [] : (data?.invalidRoutes ?? []);
  const total = data?.total ?? 0;
  const hasMore = data?.hasMore ?? false;

  // Prefetch routes for all domains (for duplicate target detection)
  usePrefetchAllDomainRoutes(SUPPORTED_DOMAINS, filters.domain);

  // This session's own route writes (v1.41.1): what they answered is shown in
  // every listing (the entries' view), and a route with a write in flight
  // shows its write actions disabled (the writes in flight, on their own
  // snapshot, so a write starting or settling re-projects no listing). The
  // write hooks themselves refuse a write at a held route.
  const pendingView = usePendingRouteView();
  const admission = usePendingRouteAdmission();
  /**
   * Whether a write of this session at the route is in flight, from the
   * admission snapshot this render subscribed to (it re-renders the row when
   * the writes in flight change). A readable row is held at its path as a
   * write of it sends it (normalised as the Worker normalises it); `exact`:
   * an unreadable record's row, held by its exact stored key (its recovery
   * delete's).
   */
  const isWritePending = useCallback(
    (route: Pick<Route, 'path' | 'domain'>, options?: { exact?: boolean }) => {
      const domain = route.domain ?? filters.domain;
      if (domain === undefined) return false;
      return admission.isPending(
        options?.exact ? keyOfStored(domain, route.path) : keyOfInput(domain, route.path),
      );
    },
    [admission, filters.domain],
  );
  /**
   * Whether this session's own write answered at the route, since the
   * version a dialog was opened on, with another version or by removing it
   * (v1.41.1 review): the store's entry for its key is gone, or live with
   * another `updatedAt` (equality only, never order). The dialog then sends
   * nothing. Covers every way an editor opens, the navigation state of
   * Storage's "View in Routes" and the QR page's "View route" included. No
   * entry: the server's own precondition (`expectedUpdatedAt`) decides. The
   * entry is read at the opened route's stored key, and a `gone-unreadable`
   * one (an unreadable record removed by its exact key, which may equal a
   * readable route's) says nothing about a readable route, so it is ignored.
   */
  const changedWhileOpen = (route: Route) => {
    const domain = route.domain ?? filters.domain;
    const answer =
      domain === undefined ? undefined : pendingRoutes.answerAt(keyOfStored(domain, route.path));
    if (answer === undefined || answer.state === 'gone-unreadable') return false;
    return answer.state === 'gone' || answer.route.updatedAt !== route.updatedAt;
  };
  /**
   * The store's generation of a migration's destination key, captured when
   * its confirmation opens and compared at submit (equality only): it moves
   * when an own answer changes that key. The typed path is normalised once,
   * as the Worker will store it, so it is the key the migration's answer
   * bumps. `undefined` when the route has no domain yet (the write itself
   * then refuses).
   */
  const destinationGeneration = (route: Pick<Route, 'domain'>, path: string) => {
    const domain = route.domain ?? filters.domain;
    return domain === undefined ? undefined : pendingRoutes.generation(keyOfInput(domain, path));
  };

  // Build cross-domain routes map from TanStack Query cache: the raw
  // prefetches, each shown through the pending-route store as `useRoutes`
  // shows its own listing
  const queryClient = useQueryClient();
  const allDomainRoutes = useMemo(() => {
    const map = new Map<string, Route[]>();
    for (const domain of SUPPORTED_DOMAINS) {
      const cached = queryClient.getQueryData<RouteList>(routeKeys.list(domain, undefined, 1000));
      if (cached) map.set(domain, pendingView.project(cached, domain).routes);
    }
    const currentRoutes = data?.routes;
    if (filters.domain && currentRoutes && currentRoutes.length > 0 && !map.has(filters.domain)) {
      map.set(filters.domain, currentRoutes);
    }
    return map;
  }, [queryClient, filters.domain, data, pendingView]);

  const createRoute = useCreateRoute();
  const updateRoute = useUpdateRoute();
  const deleteRoute = useDeleteRoute();
  const toggleRoute = useToggleRoute();
  const migrateRoute = useMigrateRoute();
  const transferRoute = useTransferRoute();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  // The editor's route, as it opened: a save after this session's own write
  // answered another version there since (an editor opened from Storage while
  // that route's toggle ran) sends nothing (v1.41.1)
  const [editRoute, setEditRoute] = useState<Route | null>(null);
  // The route to delete: a readable route, or an unreadable record's row,
  // which is deleted by its EXACT key through the recovery (v1.38.0): its
  // listed path may not round-trip through the ordinary delete's normalising
  // (`/p?x` would delete `/p`, `/Promo` the valid `/promo`)
  const [deleteConfirmRoute, setDeleteConfirmRoute] = useState<{
    path: string;
    domain?: string | undefined;
    unreadable?: boolean;
  } | null>(null);
  // A route write refused because its TARGET carries a credential-named
  // parameter. The retry closes over the original submission and re-sends it
  // with the acknowledgement, so the operator confirms the exact write they
  // already made.
  const [credentialConfirm, setCredentialConfirm] = useState<{
    parameters: string[];
    verb: string;
    retry: () => Promise<void>;
  } | null>(null);
  const [credentialConfirmPending, setCredentialConfirmPending] = useState(false);
  const [transferTarget, setTransferTarget] = useState<{
    path: string;
    fromDomain: string;
    toDomain: string;
  } | null>(null);
  // The migration, with its destination key's generation when its
  // confirmation opened (v1.41.1)
  const [migrationConfirm, setMigrationConfirm] = useState<{
    route: Route;
    newPath: string;
    updates: UpdateRouteInput;
    destinationGeneration: number | undefined;
  } | null>(null);

  // Auto-open edit dialog from navigate state (e.g., storage "View in Routes"),
  // once per navigation: opened during render, and the history entry's state
  // cleared through the router after commit so a reload does not reopen it.
  // The state is read as unknown and validated (v1.38.0)
  const navRoute = navEditRoute(location.state);
  const [openedNavState, setOpenedNavState] = useState<unknown>(null);
  if (navRoute && location.state !== openedNavState) {
    setOpenedNavState(location.state);
    setEditRoute(navRoute);
  }
  useClearNavigationState(navRoute !== undefined);

  // Filter and sort routes (client-side for type/enabled, server handles search)
  const filteredRoutes = useMemo(() => {
    if (!routes) return [];

    let result = [...routes];

    // Filter by type (client-side supplement to server)
    if (filters.type) {
      result = result.filter(route => route.type === filters.type);
    }

    // Filter by enabled status (client-side supplement to server)
    if (filters.enabled !== undefined) {
      result = result.filter(route => (route.enabled !== false) === filters.enabled);
    }

    // The server orders a search by relevance (v1.38.0); otherwise newest first
    if (!debouncedSearch) result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    return result;
  }, [routes, filters.type, filters.enabled, debouncedSearch]);

  // Check if any filters are active
  const hasActiveFilters = !!(
    filters.domain ||
    filters.search ||
    filters.type ||
    filters.enabled !== undefined
  );

  const handleResetFilters = () => {
    handleFilterChange({});
  };

  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    persistPageSize(size);
    setOffset(0);
  };

  const handleCreate = async (
    input: CreateRouteInput,
    domain: string,
    acknowledgeCredentialTarget?: boolean,
  ) => {
    try {
      await createRoute.mutateAsync({ data: input, domain, acknowledgeCredentialTarget });
      toast.success(`Route created successfully on ${domain}`);
      setCreateDialogOpen(false);
      setCredentialConfirm(null);
    } catch (err) {
      const parameters = credentialTargetParametersFromError(err);
      if (parameters && !acknowledgeCredentialTarget) {
        setCredentialConfirm({
          parameters,
          verb: 'Create',
          retry: () => handleCreate(input, domain, true),
        });
        return;
      }
      setCredentialConfirm(null);
      toast.error(
        `Failed to create route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const handleUpdate = async (
    updates: UpdateRouteInput,
    pathChanged: boolean,
    newPath?: string,
    acknowledgeCredentialTarget?: boolean,
  ) => {
    if (!editRoute) return;
    // An own write answered at this route since the version the editor
    // opened (v1.41.1): nothing is sent, and the reopen edits the current one
    if (changedWhileOpen(editRoute)) {
      setEditRoute(null);
      setCredentialConfirm(null);
      toast.error(ROUTE_CHANGED_WHILE_OPEN_TOAST);
      return;
    }

    // Nothing changed: no request, no audit row, no new updatedAt (v1.38.0)
    if (!pathChanged && Object.keys(updates).length === 0) {
      toast.success('No changes to save');
      setEditRoute(null);
      return;
    }

    if (pathChanged && newPath) {
      // Show confirmation dialog instead of immediately updating
      setMigrationConfirm({
        route: editRoute,
        newPath,
        updates,
        destinationGeneration: destinationGeneration(editRoute, newPath),
      });
      return;
    }

    // Captured before the await: the retry re-sends the SAME write, and
    // `editRoute` may have been cleared by then.
    const target = editRoute;

    // Normal update (no path change)
    try {
      await updateRoute.mutateAsync({
        path: target.path,
        data: updates,
        domain: requireWriteDomain(target.domain, filters.domain),
        acknowledgeCredentialTarget,
        // The version this dialog edited (v1.40.0): a route changed since it
        // was loaded, by anyone, is refused (409) instead of overwritten
        expectedUpdatedAt: target.updatedAt,
      });
      toast.success('Route updated successfully');
      setEditRoute(null);
      setCredentialConfirm(null);
    } catch (err) {
      const parameters = credentialTargetParametersFromError(err);
      if (parameters && !acknowledgeCredentialTarget) {
        setCredentialConfirm({
          parameters,
          verb: 'Save',
          retry: () => handleUpdate(updates, false, undefined, true),
        });
        return;
      }
      setCredentialConfirm(null);
      if (isRouteSourceChanged(err)) {
        // v1.40.0: the route changed since this dialog loaded it. The hook
        // reloads it; closing the dialog makes the next edit start from the
        // current version, never resend the stale updatedAt
        setEditRoute(null);
        toast.error(ROUTE_CHANGED_TOAST);
        return;
      }
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
        domain: requireWriteDomain(deleteConfirmRoute.domain, filters.domain),
        ...(deleteConfirmRoute.unreadable ? { recoverInvalid: true } : {}),
      });
      toast.success('Route deleted successfully');
      setDeleteConfirmRoute(null);
    } catch (err) {
      toast.error(
        `Failed to delete route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  const handleToggle = async (route: Route, acknowledgeCredentialTarget?: boolean) => {
    // A write of this route already in flight refuses this one before any
    // request (useToggleRoute), and the toast below says so. A route stored
    // without `enabled` is active (the row says so): its next state is
    // disabled (v1.41.1 review), and the toast and confirmation follow it
    const enabled = route.enabled === false;
    try {
      // Pass domain from route when in all-domains view to ensure correct mutation
      await toggleRoute.mutateAsync({
        path: route.path,
        enabled,
        domain: requireWriteDomain(route.domain, filters.domain),
        acknowledgeCredentialTarget,
      });
      toast.success(`Route ${enabled ? 'enabled' : 'disabled'}`);
      setCredentialConfirm(null);
    } catch (err) {
      const parameters = credentialTargetParametersFromError(err);
      if (parameters && !acknowledgeCredentialTarget) {
        setCredentialConfirm({
          parameters,
          verb: enabled ? 'Enable' : 'Disable',
          retry: () => handleToggle(route, true),
        });
        return;
      }
      setCredentialConfirm(null);
      toast.error(
        `Failed to toggle route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  };

  /** Re-send the refused write with the operator's acknowledgement. */
  const handleConfirmCredentialTarget = async () => {
    if (!credentialConfirm) return;
    setCredentialConfirmPending(true);
    try {
      await credentialConfirm.retry();
    } finally {
      setCredentialConfirmPending(false);
    }
  };

  /**
   * A path change confirmed as a migration (v1.38.0): ONE request moves the
   * route and applies the rest of the edit in the same write at the new key
   * (KV takes one write per key per second, so a move and then an update of
   * the new key could lose the update). A credential refusal asks for the
   * confirmation BEFORE anything has moved; cancelling it leaves the route
   * where it was. "Moved, but other changes were not saved" is said only when
   * the server moved the route and its answer does not show the changes (an
   * older Worker that ignores them).
   */
  const handleConfirmMigration = async (
    plan: NonNullable<typeof migrationConfirm> | null = migrationConfirm,
    acknowledgeCredentialTarget?: boolean,
  ) => {
    if (!plan) return;
    const { route, newPath, updates } = plan;
    // An own write answered at the source since the version the editor
    // opened, or at the destination since the confirmation opened (v1.41.1):
    // nothing is sent
    if (
      changedWhileOpen(route) ||
      destinationGeneration(route, newPath) !== plan.destinationGeneration
    ) {
      setMigrationConfirm(null);
      setEditRoute(null);
      setCredentialConfirm(null);
      toast.error(ROUTE_CHANGED_WHILE_OPEN_TOAST);
      return;
    }

    let domain: string;
    try {
      domain = requireWriteDomain(route.domain, filters.domain);
    } catch (err) {
      setMigrationConfirm(null);
      toast.error(
        `Failed to migrate route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
      return;
    }

    let moved: Route;
    try {
      moved = await migrateRoute.mutateAsync({
        oldPath: route.path,
        newPath,
        domain,
        updates,
        acknowledgeCredentialTarget,
        // The version the dialog edited (v1.40.0), as for an edit
        expectedUpdatedAt: route.updatedAt,
      });
    } catch (err) {
      const parameters = credentialTargetParametersFromError(err);
      if (parameters && !acknowledgeCredentialTarget) {
        // Nothing has moved: the confirmation re-sends the same migration
        setCredentialConfirm({
          parameters,
          verb: 'Migrate',
          retry: () => handleConfirmMigration(plan, true),
        });
        return;
      }
      setCredentialConfirm(null);
      if (isRouteSourceChanged(err)) {
        // Nothing moved; the source is reloaded and the dialogs close (v1.40.0)
        setMigrationConfirm(null);
        setEditRoute(null);
        toast.error(ROUTE_CHANGED_TOAST);
        return;
      }
      toast.error(
        `Failed to migrate route: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
      return;
    }

    setCredentialConfirm(null);
    setMigrationConfirm(null);
    setEditRoute(null);
    if (Object.keys(updates).length === 0) {
      toast.success(`Route migrated from ${route.path} to ${moved.path}`);
      return;
    }
    const unapplied = unappliedPatchFields(updates, moved);
    if (unapplied.length === 0) {
      toast.success(`Route migrated from ${route.path} to ${moved.path} and updated`);
    } else {
      toast.error(
        `Route migrated from ${route.path} to ${moved.path}, but its other changes were not saved (${unapplied.join(', ')}): edit the route again to apply them`,
      );
    }
  };

  const handleTransferConfirm = async (acknowledgeCredentialTarget?: boolean) => {
    if (!transferTarget) return;
    const target = transferTarget;
    try {
      await transferRoute.mutateAsync({ ...target, acknowledgeCredentialTarget });
      toast.success(`Route transferred to ${target.toDomain}`);
      setTransferTarget(null);
      setEditRoute(null);
      setCredentialConfirm(null);
    } catch (err) {
      const parameters = credentialTargetParametersFromError(err);
      if (parameters && !acknowledgeCredentialTarget) {
        setCredentialConfirm({
          parameters,
          verb: 'Transfer',
          retry: () => handleTransferConfirm(true),
        });
        return;
      }
      setCredentialConfirm(null);
      toast.error(`Transfer failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-huge font-inter font-bold text-blue-950">Routes</h1>
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <p className="text-destructive font-inter">Failed to load routes: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 flex-1">
          <h1 className="text-huge font-inter font-bold text-blue-950">Routes</h1>
          <div className="h-1 flex-1 rounded-full gradient-accent-bar opacity-30" />
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button className="font-inter bg-blue-950 hover:bg-blue-900 ml-4">
              <Plus className="h-4 w-4 mr-2" />
              New Route
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-xl lg:max-w-2xl">
            <DialogHeader>
              <DialogTitle className="font-inter font-semibold text-blue-950">
                Create Route
              </DialogTitle>
              <DialogDescription className="font-inter">
                Add a new route to the edge router.
              </DialogDescription>
            </DialogHeader>
            <RouteForm
              mode="create"
              onSubmit={(input, routeDomain) => void handleCreate(input, routeDomain)}
              onCancel={() => setCreateDialogOpen(false)}
              isSubmitting={createRoute.isPending}
              allDomainRoutes={allDomainRoutes}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Domain Filter */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="routes-filter-domain" className="text-small font-inter text-charcoal-600">
            Domain
          </label>
          <Select
            value={filters.domain || 'all'}
            onValueChange={value =>
              handleFilterChange({
                ...filters,
                domain: value === 'all' ? undefined : (value as typeof filters.domain),
              })
            }
          >
            <SelectTrigger id="routes-filter-domain" className="w-48 font-inter">
              <SelectValue placeholder="All domains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-inter">
                All domains
              </SelectItem>
              {SUPPORTED_DOMAINS.map(domain => (
                <SelectItem key={domain} value={domain} className="font-inter font-mono text-small">
                  {domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Search Input */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <label
              htmlFor="routes-filter-search"
              className="text-small font-inter text-charcoal-600"
            >
              Search
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info
                  className="h-3.5 w-3.5 text-muted-foreground cursor-help"
                  aria-label="About route search"
                />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                Searches path, target, type, status code, bucket and host header. Words can be in
                any order; case and separators (spaces, hyphens, underscores, dots, slashes) are
                ignored. The domain is matched as typed (case-insensitive). Closest path matches
                come first.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" />
            <Input
              id="routes-filter-search"
              type="text"
              placeholder="Search routes..."
              value={filters.search || ''}
              onChange={e =>
                handleFilterChange({ ...filters, search: e.target.value || undefined })
              }
              className="pl-8 w-48 font-inter"
            />
          </div>
        </div>

        {/* Type Filter */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="routes-filter-type" className="text-small font-inter text-charcoal-600">
            Type
          </label>
          <Select
            value={filters.type || 'all'}
            onValueChange={value =>
              handleFilterChange({
                ...filters,
                type: value === 'all' ? undefined : (value as 'redirect' | 'proxy' | 'r2'),
              })
            }
          >
            <SelectTrigger id="routes-filter-type" className="w-32 font-inter">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-inter">
                All types
              </SelectItem>
              <SelectItem value="redirect" className="font-inter">
                Redirect
              </SelectItem>
              <SelectItem value="proxy" className="font-inter">
                Proxy
              </SelectItem>
              <SelectItem value="r2" className="font-inter">
                R2
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Enabled Filter */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="routes-filter-status" className="text-small font-inter text-charcoal-600">
            Status
          </label>
          <Select
            value={filters.enabled === undefined ? 'all' : filters.enabled ? 'active' : 'disabled'}
            onValueChange={value =>
              handleFilterChange({
                ...filters,
                enabled: value === 'all' ? undefined : value === 'active',
              })
            }
          >
            <SelectTrigger id="routes-filter-status" className="w-32 font-inter">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-inter">
                All
              </SelectItem>
              <SelectItem value="active" className="font-inter">
                Active
              </SelectItem>
              <SelectItem value="disabled" className="font-inter">
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
            className="font-inter text-charcoal-500 hover:text-charcoal-700"
          >
            <X className="h-4 w-4 mr-1" />
            Reset
          </Button>
        )}
      </div>

      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="font-inter font-semibold text-blue-950">All Routes</CardTitle>
          <CardDescription className="font-inter">
            {isLoading
              ? 'Loading...'
              : `Showing ${filteredRoutes.length} of ${total} routes${hasActiveFilters ? ' (filtered)' : ''}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-charcoal-100 bg-muted/30">
                  {!filters.domain && (
                    <TableHead className="font-inter font-semibold text-charcoal-700">
                      Domain
                    </TableHead>
                  )}
                  <TableHead className="font-inter font-semibold text-charcoal-700">Path</TableHead>
                  <TableHead className="font-inter font-semibold text-charcoal-700">Type</TableHead>
                  <TableHead className="font-inter font-semibold text-charcoal-700">
                    Target
                  </TableHead>
                  <TableHead className="font-inter font-semibold text-charcoal-700">
                    Status
                  </TableHead>
                  <TableHead className="w-[70px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRoutes.map(route => {
                  // A write of this route in flight: no other write until it settles
                  const pending = isWritePending(route);
                  return (
                    <TableRow
                      key={route.domain ? `${route.domain}:${route.path}` : route.path}
                      className="hover:bg-gold-50/50 transition-colors cursor-pointer"
                      aria-busy={pending || undefined}
                      onClick={() => {
                        if (!isWritePending(route)) setEditRoute(route);
                      }}
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
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-tiny font-inter font-medium border ${
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
                            <DropdownMenuItem
                              onClick={() =>
                                void copyToClipboard(
                                  `https://${route.domain ?? filters.domain}${route.path}`,
                                )
                              }
                              className="font-inter"
                            >
                              <Copy className="mr-2 size-4" />
                              Copy Link
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setQrRoute(route)}
                              className="font-inter"
                            >
                              <QrCode className="mr-2 size-4" />
                              QR Code
                            </DropdownMenuItem>
                            {route.type === 'redirect' && (
                              <DropdownMenuItem asChild className="font-inter">
                                <a href={route.target} target="_blank" rel="noopener noreferrer">
                                  <ExternalLink className="h-4 w-4 mr-2" />
                                  Open Target
                                </a>
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              disabled={pending}
                              onClick={() => {
                                if (!isWritePending(route)) setEditRoute(route);
                              }}
                              className="font-inter"
                            >
                              <Pencil className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={pending}
                              onClick={() => void handleToggle(route)}
                              className="font-inter"
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
                              disabled={pending}
                              onClick={() => {
                                if (!isWritePending(route)) setDeleteConfirmRoute(route);
                              }}
                              className="text-destructive font-inter"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {invalidRoutes.map(row => (
                  <TableRow
                    key={`invalid:${row.domain}:${row.path}`}
                    data-testid="unreadable-route"
                    className="bg-destructive/5"
                  >
                    {!filters.domain && (
                      <TableCell className="font-mono text-small text-charcoal-600">
                        {row.domain}
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-small font-medium text-charcoal-700">
                      {row.path}
                    </TableCell>
                    <TableCell colSpan={3}>
                      <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 font-inter text-tiny font-medium text-destructive">
                        Unreadable record
                      </span>
                      <span className="ml-2 font-inter text-tiny text-muted-foreground">
                        Stored in a shape that cannot be read and never served. Delete it and create
                        it again.
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:bg-destructive/10"
                        aria-label={`Delete unreadable record ${row.path}`}
                        disabled={isWritePending(row, { exact: true })}
                        onClick={() => setDeleteConfirmRoute({ ...row, unreadable: true })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredRoutes.length === 0 && invalidRoutes.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={filters.domain ? 5 : 6}
                      className="text-center text-muted-foreground font-inter"
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
          <PaginationControls
            offset={offset}
            limit={pageSize}
            total={total}
            hasMore={hasMore}
            onOffsetChange={setOffset}
            onLimitChange={handlePageSizeChange}
          />
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!qrRoute} onOpenChange={open => !open && setQrRoute(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-inter font-semibold text-blue-950">
              QR code for {qrRoute?.path}
            </DialogTitle>
            <DialogDescription className="font-inter">
              Encodes the short URL — re-point the route later and printed copies keep working.
            </DialogDescription>
          </DialogHeader>
          {qrRoute && !qrGuardDomain && (
            <p className="font-inter text-sm text-red-600">
              This route has no domain. Select its domain and try again.
            </p>
          )}
          {qrRoute &&
            qrGuardDomain &&
            (() => {
              const qrDomain = qrGuardDomain;
              const shortUrl = `https://${qrDomain}${qrRoute.path}`;
              const design = QRDesignSchema.parse({});
              return (
                <div className="flex flex-col items-center gap-4">
                  <QrPreview content={shortUrl} design={design} />
                  <p className="font-mono text-sm text-muted-foreground">{shortUrl}</p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        downloadSvg(renderQrSvg(shortUrl, design), qrRoute.path.slice(1) || 'qr')
                      }
                    >
                      Download SVG
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void downloadPng(
                          renderQrSvg(shortUrl, design),
                          design.size,
                          qrRoute.path.slice(1) || 'qr',
                        )
                      }
                    >
                      Download PNG
                    </Button>
                    {existingLinkedQr && (
                      <Button
                        onClick={() => {
                          setQrRoute(null);
                          void navigate('/qr-codes', {
                            state: { domain: qrDomain } satisfies QrPageNavState,
                          });
                        }}
                      >
                        View QR
                      </Button>
                    )}
                    {!existingLinkedQr && (
                      <Button
                        disabled={createQrMutation.isPending}
                        onClick={() =>
                          createQrMutation.mutate(
                            {
                              input: {
                                type: 'url',
                                payload: { url: shortUrl },
                                description: `Route ${qrRoute.path}`,
                                linkedRoute: { domain: qrDomain, path: qrRoute.path },
                              },
                              domain: qrDomain,
                            },
                            {
                              onSuccess: qr => {
                                toast.success(`Saved as QR code: ${qr.id}`);
                                setQrRoute(null);
                                void navigate('/qr-codes', {
                                  state: { domain: qr.domain } satisfies QrPageNavState,
                                });
                              },
                              onError: e =>
                                toast.error(e instanceof Error ? e.message : 'Save failed'),
                            },
                          )
                        }
                      >
                        Save as QR Code
                      </Button>
                    )}
                  </div>
                </div>
              );
            })()}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editRoute} onOpenChange={() => setEditRoute(null)}>
        <DialogContent className="sm:max-w-xl lg:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-inter font-semibold text-blue-950">Edit Route</DialogTitle>
            <DialogDescription className="font-inter">
              Update route configuration for{' '}
              <code className="font-mono text-blue-600">{editRoute?.path}</code>
            </DialogDescription>
            {editRoute && (
              <div className="flex items-center gap-1.5">
                <a
                  href={`https://${editRoute.domain ?? filters.domain}${editRoute.path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-blue-600"
                >
                  <ExternalLink className="size-3 shrink-0" />
                  <span className="truncate font-mono">
                    {editRoute.domain ?? filters.domain}
                    {editRoute.path}
                  </span>
                </a>
                <button
                  type="button"
                  onClick={() =>
                    void copyToClipboard(
                      `https://${editRoute.domain ?? filters.domain}${editRoute.path}`,
                    )
                  }
                  className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-blue-50 hover:text-blue-600"
                  title="Copy link"
                >
                  <Copy className="size-3" />
                </button>
              </div>
            )}
          </DialogHeader>
          {editRoute && (
            <RouteForm
              mode="edit"
              route={editRoute}
              onSubmit={(updates, pathChanged, newPath) =>
                void handleUpdate(updates, pathChanged, newPath)
              }
              onCancel={() => setEditRoute(null)}
              isSubmitting={updateRoute.isPending || isWritePending(editRoute)}
              allowedDomains={[...SUPPORTED_DOMAINS]}
              onTransfer={
                editRoute.domain
                  ? toDomain =>
                      setTransferTarget({
                        path: editRoute.path,
                        fromDomain: editRoute.domain!,
                        toDomain,
                      })
                  : undefined
              }
              allDomainRoutes={allDomainRoutes}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmRoute} onOpenChange={() => setDeleteConfirmRoute(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-inter font-semibold text-blue-950">
              Delete Route
            </DialogTitle>
            <DialogDescription className="font-inter">
              {deleteConfirmRoute?.unreadable ? (
                <>
                  Delete the unreadable record stored at exactly{' '}
                  <code className="font-mono text-blue-600">{deleteConfirmRoute.path}</code>? Only
                  that record is deleted; a route that can be read is never touched. This action
                  cannot be undone.
                </>
              ) : (
                <>
                  Are you sure you want to delete the route{' '}
                  <code className="font-mono text-blue-600">{deleteConfirmRoute?.path}</code>? This
                  action cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmRoute(null)}
              className="font-inter"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleteRoute.isPending}
              className="font-inter"
            >
              {deleteRoute.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CredentialTargetDialog
        parameters={credentialConfirm?.parameters ?? null}
        verb={credentialConfirm?.verb ?? 'Save'}
        pending={credentialConfirmPending}
        onConfirm={() => void handleConfirmCredentialTarget()}
        onCancel={() => setCredentialConfirm(null)}
      />

      {/* Migration Confirmation Dialog */}
      <AlertDialog open={!!migrationConfirm} onOpenChange={() => setMigrationConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-inter">Confirm Path Change</AlertDialogTitle>
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
                    {migrationConfirm && Object.keys(migrationConfirm.updates).length > 0 && (
                      <li>Your other changes are saved with the move, in the same write</li>
                    )}
                  </ul>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-inter">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleConfirmMigration(migrationConfirm)}
              className="bg-blue-600 hover:bg-blue-700 font-inter"
              disabled={migrateRoute.isPending}
            >
              {migrateRoute.isPending ? 'Migrating...' : 'Migrate Route'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Transfer Confirmation Dialog */}
      <AlertDialog open={!!transferTarget} onOpenChange={() => setTransferTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-inter font-semibold text-blue-950">
              Transfer Route
            </AlertDialogTitle>
            <AlertDialogDescription className="font-inter">
              Transfer route <code className="font-mono text-blue-600">{transferTarget?.path}</code>{' '}
              from <code className="font-mono text-blue-600">{transferTarget?.fromDomain}</code> to{' '}
              <code className="font-mono text-blue-600">{transferTarget?.toDomain}</code>?
              <br />
              <span className="text-amber-600">
                The path will remain the same on the new domain.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="font-inter">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleTransferConfirm()}
              disabled={transferRoute.isPending}
              className="bg-blue-950 font-inter hover:bg-blue-900"
            >
              {transferRoute.isPending ? 'Transferring...' : 'Transfer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * QR Codes page — plan Rev 3, Approach C-prime.
 *
 * List + create/edit/delete for the unified QR resource. All previews and
 * downloads render CLIENT-SIDE via the shared renderer (WYSIWYG with the
 * Worker by construction; serving stays authed-only per the locked decision).
 */

import {
  CreateQRInputSchema,
  deriveBrandForDomain,
  generateQrId,
  type InvalidQRRow,
  NEUTRAL_QR_DESIGN,
  normalizeQrId,
  normalizeQrIdInput,
  QR_BRAND_PRESETS,
  QR_LOGO_MAX_BYTES,
  QR_PAYLOAD_SCHEMAS,
  type QRCode,
  QRDesignSchema,
  type QRType,
  type QrBrandPreset,
  qrContrastRatio,
  renderQrSvg,
  serializePayload,
  UpdateQRInputSchema,
} from '@bifrost/shared';
import { Download, Pencil, Plus, QrCode as QrCodeIcon, Trash2 } from 'lucide-react';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ContextualHelp } from '@/components/contextual-help';
import { CredentialTargetDialog } from '@/components/credential-target-dialog';
import { FieldHint } from '@/components/field-hint';
import { PaginationControls } from '@/components/pagination-controls';
import { QrPreview } from '@/components/qr-preview';
import { QrRouteFields } from '@/components/qr-route-fields';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SUPPORTED_DOMAINS } from '@/context';
import {
  useCreateQr,
  useCreateRoute,
  useDebounce,
  useDeleteQr,
  useQrCodes,
  useRoutes,
  useUpdateQr,
} from '@/hooks';
import type { QrQueryParams } from '@/lib/api-client';
import { isQrNotFoundError, isUncertainAnswer, RouteExistsError } from '@/lib/api-error';
import { getPersistedPageSize, persistPageSize } from '@/lib/constants';
import { credentialTargetParametersFromError } from '@/lib/credential-target';
import { useClearNavigationState } from '@/lib/navigation-state';
import { computeLogoAspectRatio, fetchBrandLogo } from '@/lib/qr-brand-logo';
import {
  designFromState,
  linkedRouteFromState,
  linkedRouteUrl,
  payloadFromState,
  type QrFormState,
  qrEditPatch,
  stateFromQr,
  submittedPayload,
  suggestQrId,
  TUNNELED_EAP_METHODS,
  tagsFromState,
  WIFI_AUTH_TRIGGER_LABELS,
} from '@/lib/qr-form-state';
import { initialQrPageDomain, qrPageNavDomain } from '@/lib/qr-page-domain';
import { keyOfInput, type RouteStoreKey, RouteWritePendingError } from '@/lib/route-pending';
import { type CreateRouteInput, CreateRouteSchema, type Route } from '@/lib/schemas';
import { downloadPng, downloadSvg } from '@/lib/svg-to-png';

// =============================================================================
// Helpers
// =============================================================================

const TYPE_BADGE: Record<QRType, string> = {
  url: 'bg-blue-100 text-blue-800 border-blue-200',
  text: 'bg-slate-100 text-slate-800 border-slate-200',
  vcard: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  wifi: 'bg-amber-100 text-amber-800 border-amber-200',
};

function QrTypeBadge({ type }: { type: QRType }) {
  return (
    <Badge variant="outline" className={TYPE_BADGE[type]}>
      {type}
    </Badge>
  );
}

/**
 * The string a stored QR encodes for preview/download. Mirrors the Worker's
 * render-time resolution; the client assumes a linked route still exists (the
 * Worker re-checks — a stale link only affects the local preview).
 */
function qrContent(qr: QRCode): string {
  if (qr.linkedRoute) return `https://${qr.linkedRoute.domain}${qr.linkedRoute.path}`;
  return serializePayload(qr.type, qr.payload);
}

async function handleDownload(qr: QRCode, format: 'svg' | 'png'): Promise<void> {
  try {
    const svg = renderQrSvg(qrContent(qr), qr.design);
    if (format === 'svg') downloadSvg(svg, qr.id);
    else
      await downloadPng(svg, qr.design.size, qr.id, () =>
        toast.warning('Logo may be missing from the PNG — download SVG for guaranteed fidelity'),
      );
  } catch (error) {
    toast.error(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// Create/Edit form
// =============================================================================

// Pure form-state derivation lives in admin/src/lib/qr-form-state.ts —
// unit-tested there, incl. the stale-credential exclusions.

/** The design fields a brand preset (or neutral, for null) sets; its logo loads separately. */
function presetDesignPatch(preset: QrBrandPreset | null): Partial<QrFormState> {
  return preset
    ? { fg: preset.fg, bg: preset.bg, logoDataUri: '', logoAspectRatio: null }
    : { ...NEUTRAL_QR_DESIGN, logoDataUri: '', logoAspectRatio: null };
}

/** Where a preset logo load writes: the form's state, guarded by its apply token. */
interface PresetLogoTarget {
  /** The latest preset application; a load for an older one is ignored. */
  applyToken: { readonly current: number };
  setState: Dispatch<SetStateAction<QrFormState>>;
  setLogoPending: Dispatch<SetStateAction<number>>;
}

/**
 * Load a brand preset's logo into the form for the application holding
 * `token`. The logo arrives async via the same-origin storage API; failure
 * degrades to colors-only with a toast. The caller has already counted the
 * load as pending; it is uncounted here once settled.
 */
async function loadPresetLogo(
  preset: QrBrandPreset,
  logoAssetKey: string,
  token: number,
  target: PresetLogoTarget,
): Promise<void> {
  try {
    const logo = await fetchBrandLogo(logoAssetKey);
    if (target.applyToken.current !== token) return;
    target.setState(prev => ({
      ...prev,
      logoDataUri: logo.dataUri,
      logoAspectRatio: logo.aspectRatio,
    }));
  } catch {
    if (target.applyToken.current !== token) return;
    toast.warning(`${preset.label} logo unavailable — using colors only`);
  } finally {
    target.setLogoPending(n => Math.max(0, n - 1));
  }
}

interface QrFormProps {
  mode: 'create' | 'edit';
  domain: string;
  initial?: QRCode;
  submitting: boolean;
  /**
   * Save the code. A create receives the full input; an edit only the fields
   * that changed (`qrEditPatch`, v1.38.0), `{}` when nothing did. Resolves
   * `'saved'`, or `'not-saved'` when the dialog closed without saving (the
   * code was deleted elsewhere): a route this form created for the save is
   * then reported as kept. Rejects on any other failure.
   */
  onSubmit: (input: Record<string, unknown>) => Promise<QrSaveOutcome>;
}

/** How a save ended when it did not throw (see {@link QrFormProps.onSubmit}). */
type QrSaveOutcome = 'saved' | 'not-saved';

/** A save in progress: the code's input, and the route to create first, if any. */
interface QrSubmission {
  input: Record<string, unknown>;
  route?: CreateRouteInput | undefined;
}

function QrForm({ mode, domain, initial, submitting, onSubmit }: QrFormProps) {
  // Single-operator deployment (v1.30.0): the ADMIN_API_KEY grants full write
  // access, so the write-lock gate is a constant.
  const writeLocked = false;
  // Create mode starts in Auto on the target domain's preset (null: neutral);
  // edit mode starts in Custom (undefined). The form mounts per dialog open,
  // keyed by domain, so this start preset holds for its whole lifetime.
  const [startPreset] = useState(() => (initial ? undefined : deriveBrandForDomain(domain)));
  const [s, setS] = useState<QrFormState>(() => {
    const base = stateFromQr(initial);
    return startPreset === undefined ? base : { ...base, ...presetDesignPatch(startPreset) };
  });
  const set = (patch: Partial<QrFormState>) => setS(prev => ({ ...prev, ...patch }));
  const navigate = useNavigate();

  // Linked routes (v1.38.0): the domain's routes and url codes load only
  // while the code is linked, for the picker and the duplicate-link note
  const createRoute = useCreateRoute();
  const dynamic = s.type === 'url' && s.linkMode !== 'static';
  const routeQuery = useRoutes(domain, undefined, { enabled: dynamic });
  const qrQuery = useQrCodes({ domain, type: 'url', limit: 1000 }, { enabled: dynamic });
  const routes = routeQuery.error ? [] : (routeQuery.data?.routes ?? []);
  const link = linkedRouteFromState(s, domain);
  // The link as it would be saved differs from the stored one: only then is
  // the selection checked against the domain's routes (an untouched link is
  // never sent, so a route deleted since never blocks another edit)
  const linkChanged =
    mode === 'create' ||
    link?.domain !== initial?.linkedRoute?.domain ||
    link?.path !== initial?.linkedRoute?.path;
  const [createdRoute, setCreatedRoute] = useState<Route>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // The new route whose last create got no certain answer (v1.38.0): its
  // create may have landed, so a retry for the same path that meets "Route
  // already exists" reads the route back and links it when it holds the
  // values sent. Keyed as the Worker keys the path (`keyOfInput`, v1.41.1
  // review), so a retry at another spelling of the same route is marked too
  const uncertainRoute = useRef<RouteStoreKey | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [credentialConfirm, setCredentialConfirm] = useState<{
    parameters: string[];
    submission: QrSubmission;
  } | null>(null);
  const routeSelected =
    !!link &&
    (createdRoute?.path === link.path ||
      routes.some(route => (!route.domain || route.domain === domain) && route.path === link.path));
  const linkUsable =
    !dynamic || (!!link && (!linkChanged || s.linkMode !== 'existing' || routeSelected));
  const duplicate = link
    ? qrQuery.data?.items.find(
        qr =>
          qr.id !== initial?.id &&
          qr.linkedRoute?.domain === domain &&
          qr.linkedRoute.path === link.path,
      )
    : undefined;

  // Guard against stale async logo fetches: only the latest preset application
  // may write its logo into the form. The token is ALSO bumped on every
  // custom/upload transition (setCustom), so a pending preset fetch can never
  // overwrite a design the user has since taken manual control of.
  const presetApplyToken = useRef(0);

  // While a preset logo fetch or an upload's ratio computation is in flight,
  // submission is disabled — a quick submit must never store a half-prepared
  // design (colors without the logo, or a wordmark logo without its ratio).
  const [logoPending, setLogoPending] = useState(() => (startPreset?.logoAssetKey ? 1 : 0));

  // Manual design edits take control: invalidate any pending preset fetch and
  // flip the selector to Custom in one step. (logoPending is untouched — every
  // in-flight operation decrements itself unconditionally on settle; only the
  // APPLICATION of its result is token-guarded.)
  const setCustom = (patch: Partial<QrFormState>) => {
    presetApplyToken.current += 1;
    set({ ...patch, brandSel: 'custom' });
  };

  const logoTarget: PresetLogoTarget = {
    applyToken: presetApplyToken,
    setState: setS,
    setLogoPending,
  };

  // Apply a brand preset's design (or the neutral default for null).
  const applyPresetDesign = (preset: QrBrandPreset | null) => {
    const token = ++presetApplyToken.current;
    set(presetDesignPatch(preset));
    if (preset?.logoAssetKey) {
      setLogoPending(n => n + 1);
      void loadPresetLogo(preset, preset.logoAssetKey, token, logoTarget);
    }
  };

  // The start preset's logo, once the form has mounted (already counted as
  // pending in logoPending's initial state).
  useEffect(() => {
    if (!startPreset?.logoAssetKey) return;
    void loadPresetLogo(startPreset, startPreset.logoAssetKey, ++presetApplyToken.current, {
      applyToken: presetApplyToken,
      setState: setS,
      setLogoPending,
    });
  }, [startPreset]);

  // Prefill the Reference from the type's identifying payload field, until the
  // user takes it over (description deliberately NOT a source — the two
  // fields are independent). Create-only — in edit mode the
  // id is the immutable KV key and `idTouched` is seeded true. Adjusted during
  // render: the next render's suggestion equals s.id, so it settles at once.
  if (mode === 'create' && !s.idTouched) {
    const suggested = suggestQrId(s);
    if (suggested && suggested !== s.id) set({ id: suggested });
  }

  // Live preview content — invalid mid-typing states just blank the preview.
  // A route-linked QR encodes its short URL: the preview must agree with the
  // list-row preview and the Worker render.
  const preview = useMemo(() => {
    try {
      const design = QRDesignSchema.parse(designFromState(s));
      const selected = linkedRouteFromState(s, domain);
      const content = dynamic
        ? selected
          ? linkedRouteUrl(selected)
          : ''
        : serializePayload(s.type, payloadFromState(s) as never);
      return content ? { content, design } : null;
    } catch {
      return null;
    }
  }, [s, domain, dynamic]);

  const contrast = useMemo(() => qrContrastRatio(s.fg, s.bg), [s.fg, s.bg]);

  const onLogoFile = (file: File | undefined) => {
    if (!file) {
      setCustom({ logoDataUri: '', logoAspectRatio: null });
      return;
    }
    if (file.size > QR_LOGO_MAX_BYTES) {
      toast.error(`Logo must be under ${Math.floor(QR_LOGO_MAX_BYTES / 1024)} KB`);
      return;
    }
    // One pending unit covers the whole upload pipeline (file read + ratio
    // computation); decremented exactly once when the pipeline settles.
    setLogoPending(n => n + 1);
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      // readAsDataURL always yields a string result.
      const dataUri = typeof reader.result === 'string' ? reader.result : '';
      setCustom({ logoDataUri: dataUri, logoAspectRatio: null });
      // Wordmark-shaped uploads get the wide-logo window too (ratio computed
      // client-side; undecodable images just keep the square window).
      void (async () => {
        try {
          const ratio = await computeLogoAspectRatio(dataUri);
          if (ratio) {
            setS(prev =>
              prev.logoDataUri === dataUri ? { ...prev, logoAspectRatio: ratio } : prev,
            );
          }
        } finally {
          setLogoPending(n => Math.max(0, n - 1));
        }
      })();
    });
    reader.addEventListener('error', () => setLogoPending(n => Math.max(0, n - 1)));
    reader.readAsDataURL(file);
  };

  /** Open the Routes page on a route this form created. */
  const viewRoute = (route: Route) => {
    void navigate('/routes', { state: { editRoute: route } });
  };

  /**
   * A route this form created is kept when the code is not saved. A refusal
   * the server answered (a 400 reason, a 409 such as an id already taken or
   * an unreadable record) is shown as the server wrote it (v1.38.0); an
   * answer that never arrived says the save could not be confirmed.
   */
  const reportRetainedRoute = (route: Route, error?: unknown) => {
    const url = linkedRouteUrl({ domain, path: route.path });
    // One predicate for what the server definitely refused (v1.41.2)
    const refused = error instanceof Error && !isUncertainAnswer(error) ? error.message : undefined;
    toast.error(
      refused === undefined
        ? `Route ${url} was created, but the QR save could not be confirmed. The route is kept; retry the QR save or view the route.`
        : `Route ${url} was created, but the QR code was not saved: ${refused}. The route is kept; fix the code and save again, or view the route.`,
      { action: { label: 'View route', onClick: () => viewRoute(route) } },
    );
  };

  /**
   * Create the route first when the code links a new one, then save the code
   * with the route's canonical path. The form switches to that existing route
   * BEFORE the code is saved, so a retry never creates the route twice.
   */
  const save = async (submission: QrSubmission, acknowledgeCredentialTarget?: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const submittedLink = submission.input['linkedRoute'] as QRCode['linkedRoute'] | null;
    let retained =
      !submission.route && createdRoute && createdRoute.path === submittedLink?.path
        ? createdRoute
        : undefined;
    try {
      let input = submission.input;
      if (submission.route) {
        const routeKey = keyOfInput(domain, submission.route.path);
        let route: Route;
        try {
          ({ route } = await createRoute.mutateAsync({
            data: submission.route,
            domain,
            acknowledgeCredentialTarget,
            afterUncertainAnswer: uncertainRoute.current === routeKey,
          }));
        } catch (failure) {
          // Refused before any request (another write of this route is still
          // saving): nothing was sent, so nothing is uncertain and the mark
          // stays as it was; the toast below says why (v1.41.1 review). A
          // create answered 2xx without a route is uncertain since v1.41.2
          // (status 0), so its retry reads the route back
          if (!(failure instanceof RouteWritePendingError)) {
            uncertainRoute.current = isUncertainAnswer(failure) ? routeKey : null;
          }
          throw failure;
        }
        uncertainRoute.current = null;
        retained = { ...route, domain };
        if (!mounted.current) {
          reportRetainedRoute(retained);
          return;
        }
        setCreatedRoute(retained);
        const linked = { domain, path: route.path };
        set({ linkMode: 'existing', linkedRoute: linked, newRoutePath: '', newRouteTarget: '' });
        input = { ...input, payload: { url: linkedRouteUrl(linked) }, linkedRoute: linked };
      }
      setCredentialConfirm(null);
      // The code was gone (deleted elsewhere): the dialog closed without a
      // save, so a route created for it is reported as kept, with View route
      if ((await onSubmit(input)) === 'not-saved' && retained) reportRetainedRoute(retained);
    } catch (error) {
      const parameters = credentialTargetParametersFromError(error);
      if (submission.route && !retained && parameters && !acknowledgeCredentialTarget) {
        setCredentialConfirm({ parameters, submission });
      } else {
        setCredentialConfirm(null);
        if (retained) reportRetainedRoute(retained, error);
        else if (error instanceof RouteExistsError) {
          // The path holds a route this form did not make: never linked
          // silently, never created twice
          const existing = { ...error.route, domain };
          toast.error(
            `Route ${linkedRouteUrl({ domain, path: existing.path })} already exists with other values. Link it as an existing route, or choose another path.`,
            { action: { label: 'View route', onClick: () => viewRoute(existing) } },
          );
        } else toast.error(error instanceof Error ? error.message : 'Save failed');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const submit = () => {
    if (submitting || savingRef.current || credentialConfirm || logoPending > 0) return;
    if (!linkUsable) {
      toast.error('Select an available route on this domain.');
      return;
    }
    let input: Record<string, unknown>;
    if (mode === 'create') {
      // Full normalisation at submit — the typing-friendly input normaliser
      // permits a trailing hyphen that QR_ID_REGEX would reject server-side.
      let id = normalizeQrId(s.id);
      // A linked code keeps one reference across uncertain answers: a retry
      // hits the same id (409 if it was saved), never a second generated code
      if (dynamic && !id) {
        id = generateQrId();
        set({ id, idTouched: true });
      }
      input = {
        type: s.type,
        ...(id ? { id } : {}),
        payload: submittedPayload(s, domain),
        ...(dynamic ? { linkedRoute: link } : {}),
        design: designFromState(s),
        // An explicit '' is the same as no description on create
        description: s.description.trim(),
        tags: tagsFromState(s),
      };
      // Checked BEFORE a route is created, so an invalid code never leaves a
      // route behind
      const valid = CreateQRInputSchema.safeParse(input);
      if (!valid.success) {
        toast.error(valid.error.issues[0]?.message ?? 'The QR code is not valid');
        return;
      }
    } else {
      // Only the fields that changed (v1.38.0), and only those are checked: a
      // code saved under earlier limits stays editable
      input = initial ? qrEditPatch(initial, s, domain) : {};
      const issues = [
        ...(UpdateQRInputSchema.safeParse(input).error?.issues ?? []),
        ...(input['payload'] === undefined
          ? []
          : (QR_PAYLOAD_SCHEMAS[s.type].safeParse(input['payload']).error?.issues ?? [])),
      ];
      if (issues.length > 0) {
        toast.error(issues[0]?.message ?? 'The QR code is not valid');
        return;
      }
    }
    let route: CreateRouteInput | undefined;
    if (dynamic && s.linkMode === 'new' && link && input['linkedRoute'] !== undefined) {
      route = {
        path: link.path,
        type: 'redirect',
        target: s.newRouteTarget.trim(),
        statusCode: 302,
        preserveQuery: true,
      };
      let webTarget = false;
      try {
        webTarget = ['http:', 'https:'].includes(new URL(route.target).protocol);
      } catch {
        // An incomplete target
      }
      if (!CreateRouteSchema.safeParse(route).success || !webTarget) {
        toast.error('Enter a valid route path and an HTTP or HTTPS target.');
        return;
      }
    }
    void save({ input, route });
  };

  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
      <fieldset
        disabled={saving || submitting || !!credentialConfirm}
        className="min-w-0 space-y-3"
      >
        {mode === 'create' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={s.type} onValueChange={v => set({ type: v as QRType })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="url">URL / URI</SelectItem>
                  <SelectItem value="text">Plain text</SelectItem>
                  <SelectItem value="wifi">Wi-Fi network</SelectItem>
                  <SelectItem value="vcard">Contact card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <FieldHint
                htmlFor="qr-id"
                label="Reference"
                hint="How you'll find this code later, and how the API and AI agents refer to it. Capitals and spaces convert automatically — “Office WiFi” becomes “office-wifi”. Permanent once the code is created."
              />
              <Input
                id="qr-id"
                placeholder="office-wifi"
                value={s.id}
                // Normalise on the way IN, so what you see is what is stored —
                // the same doctrine as route paths and R2 keys.
                onChange={e => set({ id: normalizeQrIdInput(e.target.value), idTouched: true })}
                // Trailing separators are allowed WHILE typing; tidy them on blur.
                onBlur={() => set({ id: normalizeQrId(s.id) })}
              />
            </div>
          </div>
        )}

        {s.type === 'url' && (
          <>
            <div className="space-y-1">
              <FieldHint
                htmlFor="qr-url"
                label="URL / URI"
                hint="Encodes this exact address permanently in the printed code. For a code you can re-point later, link it to a route below — the code then encodes the short link."
              />
              <Input
                id="qr-url"
                placeholder="https://… or mailto:, tel:, wa.me…"
                value={dynamic ? (link ? linkedRouteUrl(link) : '') : s.url}
                readOnly={dynamic}
                onChange={e => set({ url: e.target.value })}
              />
            </div>
            <QrRouteFields
              state={s}
              domain={domain}
              set={set}
              routes={routes.filter(route => !route.domain || route.domain === domain)}
              loading={routeQuery.isPending}
              failed={!!routeQuery.error}
              duplicate={duplicate}
              retry={() => {
                void routeQuery.refetch();
              }}
            />
            {dynamic &&
              s.linkMode === 'existing' &&
              linkChanged &&
              !routeSelected &&
              link &&
              !routeQuery.isFetching && (
                <p className="text-sm text-destructive">
                  This route is unavailable. Select another route or clear the link.
                </p>
              )}
          </>
        )}
        {s.type === 'text' && (
          <div className="space-y-1">
            <Label htmlFor="qr-text">Text</Label>
            <Input id="qr-text" value={s.text} onChange={e => set({ text: e.target.value })} />
          </div>
        )}
        {s.type === 'wifi' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="qr-ssid">Network name (SSID)</Label>
              <Input id="qr-ssid" value={s.ssid} onChange={e => set({ ssid: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Security</Label>
              {/* Category picker, not a protocol picker: every
                  password-secured personal network — WPA, WPA2, or WPA3 —
                  encodes the interoperable T:WPA token (T:SAE/T:WPA3 break
                  many scanners). Enterprise encodes the ZXing T:WPA2-EAP
                  extension. WEP is legacy, demoted last. */}
              <Select value={s.auth} onValueChange={v => set({ auth: v as QrFormState['auth'] })}>
                <SelectTrigger>
                  {/* Short trigger label; the menu below keeps the full
                      protocol list (the long label overflowed
                      this half-width column). */}
                  <SelectValue>{WIFI_AUTH_TRIGGER_LABELS[s.auth]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WPA">Password-protected (WPA / WPA2 / WPA3)</SelectItem>
                  <SelectItem value="WPA2-EAP">Enterprise (802.1X)</SelectItem>
                  <SelectItem value="nopass">Open (no password)</SelectItem>
                  <SelectItem value="WEP">WEP (legacy)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {s.auth === 'WPA2-EAP' && (
              <>
                <div className="space-y-1">
                  <Label>EAP method</Label>
                  <Select value={s.eapMethod} onValueChange={v => set({ eapMethod: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PEAP">PEAP</SelectItem>
                      <SelectItem value="TTLS">TTLS</SelectItem>
                      <SelectItem value="TLS">TLS (certificate)</SelectItem>
                      <SelectItem value="PWD">PWD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(TUNNELED_EAP_METHODS as readonly string[]).includes(s.eapMethod) && (
                  <div className="space-y-1">
                    <Label>Phase-2 auth</Label>
                    <Select value={s.phase2} onValueChange={v => set({ phase2: v })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MSCHAPV2">MSCHAPv2</SelectItem>
                        <SelectItem value="GTC">GTC</SelectItem>
                        <SelectItem value="PAP">PAP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label htmlFor="qr-identity">Identity (username)</Label>
                  <Input
                    id="qr-identity"
                    value={s.identity}
                    onChange={e => set({ identity: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="qr-anon">Anonymous identity (optional)</Label>
                  <Input
                    id="qr-anon"
                    value={s.anonymousIdentity}
                    onChange={e => set({ anonymousIdentity: e.target.value })}
                  />
                </div>
                <p className="col-span-2 text-sm text-amber-600">
                  Android only — iPhones cannot join enterprise (802.1X) networks from a QR code and
                  must be configured manually.
                </p>
              </>
            )}
            {s.auth !== 'nopass' && !(s.auth === 'WPA2-EAP' && s.eapMethod === 'TLS') && (
              <div className="col-span-2 space-y-1">
                <Label htmlFor="qr-pass">Password</Label>
                <Input
                  id="qr-pass"
                  value={s.password}
                  onChange={e => set({ password: e.target.value })}
                />
              </div>
            )}
          </div>
        )}
        {s.type === 'vcard' && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="qr-name">Name</Label>
              <Input id="qr-name" value={s.name} onChange={e => set({ name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="qr-phone">Phone</Label>
              <Input id="qr-phone" value={s.phone} onChange={e => set({ phone: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="qr-email">Email</Label>
              <Input id="qr-email" value={s.email} onChange={e => set({ email: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="qr-org">Organisation</Label>
              <Input id="qr-org" value={s.org} onChange={e => set({ org: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="qr-title">Title</Label>
              <Input id="qr-title" value={s.title} onChange={e => set({ title: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="qr-vurl">Website</Label>
              <Input id="qr-vurl" value={s.vurl} onChange={e => set({ vurl: e.target.value })} />
            </div>
          </div>
        )}

        <div className="space-y-1">
          <FieldHint
            htmlFor="qr-description"
            label="Description (optional)"
            hint="A plain note about what this code is for. Shown in the QR list and included in search. It isn't encoded into the code, so you can reword it any time without reprinting."
          />
          <Input
            id="qr-description"
            value={s.description}
            onChange={e => set({ description: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <FieldHint
            htmlFor="qr-tags"
            label="Tags (optional)"
            hint="Comma-separated keywords for grouping and filtering the list — for example “office, singapore”. Up to 10. Not encoded into the code."
          />
          <Input id="qr-tags" value={s.tags} onChange={e => set({ tags: e.target.value })} />
        </div>

        <div className="grid grid-cols-2 gap-3 rounded-md border p-3">
          <div className="col-span-2 space-y-1">
            <Label>Brand design</Label>
            {/* Auto resolves the preset from the target domain; picking a brand
                applies its colors + logo; any manual design edit flips to
                Custom (preserving the edits). */}
            <Select
              value={s.brandSel}
              onValueChange={v => {
                if (v === 'custom') {
                  setCustom({});
                  return;
                }
                set({ brandSel: v });
                applyPresetDesign(
                  v === 'auto'
                    ? deriveBrandForDomain(domain)
                    : (QR_BRAND_PRESETS.find(p => p.id === v) ?? null),
                );
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  Auto — {deriveBrandForDomain(domain)?.label ?? 'Neutral'} (match domain)
                </SelectItem>
                {QR_BRAND_PRESETS.map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="qr-fg">Foreground</Label>
            <Input
              id="qr-fg"
              type="color"
              value={s.fg}
              onChange={e => setCustom({ fg: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="qr-bg">Background</Label>
            <Input
              id="qr-bg"
              type="color"
              value={s.bg}
              onChange={e => setCustom({ bg: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>Size</Label>
            <Select value={String(s.size)} onValueChange={v => set({ size: Number(v) })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="256">256 px</SelectItem>
                <SelectItem value="512">512 px</SelectItem>
                <SelectItem value="1024">1024 px</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <FieldHint
              label="Error correction"
              hint="How much of the code can be damaged, dirty, or covered and still scan — from L (~7%) to H (~30%). Higher levels make the pattern denser. Locked to H whenever a logo is present."
            />
            <Select
              value={s.logoDataUri ? 'H' : s.errorCorrection}
              onValueChange={v => set({ errorCorrection: v as QrFormState['errorCorrection'] })}
              disabled={!!s.logoDataUri}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="L">L (7%)</SelectItem>
                <SelectItem value="M">M (15%)</SelectItem>
                <SelectItem value="Q">Q (25%)</SelectItem>
                <SelectItem value="H">H (30%)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1">
            <FieldHint
              htmlFor="qr-logo"
              label="Logo (optional)"
              hint="An image placed in the centre of the code — PNG, JPEG or SVG, up to 100 KB. Adding one automatically raises error correction to its highest level, so the code still scans with its centre covered. Brand designs already supply the right logo; upload only for a one-off."
            />
            <Input
              id="qr-logo"
              type="file"
              accept="image/png,image/jpeg,image/svg+xml"
              onChange={e => onLogoFile(e.target.files?.[0])}
            />
          </div>
          {contrast < 4.5 && (
            <p className="col-span-2 text-sm text-amber-600">
              Low contrast ({contrast.toFixed(1)}:1) — scanners may struggle. Aim for 4.5:1 or
              higher.
            </p>
          )}
        </div>
      </fieldset>

      <div className="flex flex-col items-center gap-2">
        <Label>Preview</Label>
        {preview ? (
          <QrPreview content={preview.content} design={preview.design} />
        ) : (
          <div className="flex size-48 items-center justify-center rounded-md border text-sm text-muted-foreground">
            Fill in the fields
          </div>
        )}
        {createdRoute && (
          <output className="block max-w-48 text-xs break-all">
            Route created: {linkedRouteUrl({ domain, path: createdRoute.path })}
            <Button
              type="button"
              variant="link"
              disabled={saving}
              onClick={() => viewRoute(createdRoute)}
            >
              View route
            </Button>
          </output>
        )}
        <Button
          onClick={submit}
          disabled={
            submitting ||
            saving ||
            writeLocked ||
            !!credentialConfirm ||
            !preview ||
            logoPending > 0 ||
            !linkUsable
          }
        >
          {logoPending > 0
            ? 'Preparing logo…'
            : mode === 'create'
              ? 'Create QR code'
              : 'Save changes'}
        </Button>
      </div>
      <CredentialTargetDialog
        parameters={credentialConfirm?.parameters ?? null}
        verb="Create route"
        pending={saving}
        onConfirm={() => {
          if (credentialConfirm) void save(credentialConfirm.submission, true);
        }}
        onCancel={() => setCredentialConfirm(null)}
      />
    </div>
  );
}

// =============================================================================
// Page
// =============================================================================

export function QrCodesPage() {
  // Single-operator deployment: every supported domain is writable.
  const allowedDomains = SUPPORTED_DOMAINS;
  const readOnly = false;
  // "Save as QR Code" on the Routes page opens this page on the new code's domain
  const location = useLocation();
  const [domain, setDomain] = useState<string>(() =>
    initialQrPageDomain(location.state, allowedDomains),
  );
  // Clear the domain from the history entry once read, through the router, so
  // a reload or a return to this entry opens on the page's own default (as
  // routes.tsx does)
  useClearNavigationState(qrPageNavDomain(location.state) !== undefined);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(() => getPersistedPageSize());

  const queryParams: QrQueryParams = useMemo(
    () => ({
      domain,
      type: typeFilter === 'all' ? undefined : typeFilter,
      search: debouncedSearch || undefined,
      limit,
      offset,
    }),
    [domain, typeFilter, debouncedSearch, limit, offset],
  );

  const { data, isLoading, error } = useQrCodes(queryParams);
  const items = data?.items ?? [];
  // Records that cannot be read (v1.38.0): listed flagged, Delete only
  const invalidItems = data?.invalid ?? [];
  const meta = data?.meta;

  const createQr = useCreateQr();
  const updateQr = useUpdateQr();
  const deleteQr = useDeleteQr();

  const [createOpen, setCreateOpen] = useState(false);
  const [editQr, setEditQr] = useState<QRCode | null>(null);
  // The code to delete: a readable code or an unreadable record's row
  const [deleteTarget, setDeleteTarget] = useState<QRCode | InvalidQRRow | null>(null);

  // The code whose last create got no certain answer (v1.38.0): no answer
  // at all, a 5xx or an unreadable body. Its save may have landed, so a retry
  // of the same id that meets 409 QR_ALREADY_EXISTS reads the code back and
  // takes it for this save when it is the one sent
  const uncertainCreate = useRef<string | null>(null);
  const onCreate = async (input: Record<string, unknown>): Promise<QrSaveOutcome> => {
    const id = typeof input['id'] === 'string' ? input['id'] : undefined;
    const key = id === undefined ? undefined : `${domain}:${id}`;
    let qr: QRCode;
    try {
      qr = await createQr.mutateAsync({
        input,
        domain,
        afterUncertainAnswer: key !== undefined && uncertainCreate.current === key,
      });
    } catch (failure) {
      uncertainCreate.current = isUncertainAnswer(failure) && key !== undefined ? key : null;
      throw failure;
    }
    uncertainCreate.current = null;
    toast.success(`QR code created: ${qr.id}`);
    setCreateOpen(false);
    return 'saved';
  };

  const onUpdate = async (input: Record<string, unknown>): Promise<QrSaveOutcome> => {
    if (!editQr) return 'not-saved';
    // Nothing changed: no request, no audit row, no new updatedAt (v1.38.0)
    if (Object.keys(input).length === 0) {
      toast.success('No changes to save');
      setEditQr(null);
      return 'saved';
    }
    let qr: QRCode;
    try {
      qr = await updateQr.mutateAsync({
        id: editQr.id,
        input,
        domain: editQr.domain,
        createdAt: editQr.createdAt,
      });
    } catch (e) {
      // Deleted elsewhere while the dialog was open: nothing left to edit, as
      // on delete. The hook has already hidden it in every listing. Not a
      // save: the form reports a route it created for it as kept
      if (isQrNotFoundError(e)) {
        toast.info(`QR code ${editQr.id} was already deleted`);
        setEditQr(null);
        return 'not-saved';
      }
      throw e;
    }
    toast.success(`QR code updated: ${qr.id}`);
    setEditQr(null);
    return 'saved';
  };

  const onDelete = () => {
    if (!deleteTarget) return;
    deleteQr.mutate(
      {
        id: deleteTarget.id,
        domain: deleteTarget.domain,
        // The incarnation deleted; unknown for an unreadable record
        createdAt: 'createdAt' in deleteTarget ? deleteTarget.createdAt : undefined,
      },
      {
        onSuccess: () => {
          toast.success(`QR code deleted: ${deleteTarget.id}`);
          setDeleteTarget(null);
        },
        onError: e => {
          // Deleted elsewhere first: the outcome the user asked for, not a failure
          if (isQrNotFoundError(e)) {
            toast.info(`QR code ${deleteTarget.id} was already deleted`);
            setDeleteTarget(null);
            return;
          }
          toast.error(e instanceof Error ? e.message : 'Delete failed');
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2 font-inter font-semibold text-blue-950">
                QR Codes
                <ContextualHelp anchor="qr-codes" label="QR codes" />
              </CardTitle>
              <CardDescription className="font-inter">
                URL, text, Wi-Fi, and contact-card QR codes. Link a URL code to a route for
                dynamic-QR semantics — re-point the route, never reprint.
              </CardDescription>
            </div>
            {!readOnly && (
              <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Plus className="mr-1 size-4" /> New QR code
                  </Button>
                </DialogTrigger>
                <DialogContent feedbackTrigger className="sm:max-w-xl lg:max-w-3xl">
                  <DialogHeader>
                    <DialogTitle className="font-inter font-semibold text-blue-950">
                      Create QR code
                    </DialogTitle>
                    <DialogDescription className="font-inter">
                      Created on {domain}. Previews render exactly what the API serves.
                    </DialogDescription>
                  </DialogHeader>
                  <QrForm
                    key={domain}
                    mode="create"
                    domain={domain}
                    submitting={createQr.isPending}
                    onSubmit={onCreate}
                  />
                </DialogContent>
              </Dialog>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Select
              value={domain}
              onValueChange={v => {
                setDomain(v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {allowedDomains.map(d => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={typeFilter}
              onValueChange={v => {
                setTypeFilter(v);
                setOffset(0);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="url">URL</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="wifi">Wi-Fi</SelectItem>
                <SelectItem value="vcard">Contact</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Search description or id…"
              className="w-64"
              value={search}
              onChange={e => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </div>

          {error ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : 'Failed to load QR codes'}
            </p>
          ) : isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : items.length === 0 && invalidItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No QR codes yet{debouncedSearch ? ' matching your search' : ''}.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Preview</TableHead>
                  <TableHead>Reference / description</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Linked route</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(qr => (
                  <TableRow key={qr.id}>
                    <TableCell>
                      <QrPreview content={qrContent(qr)} design={qr.design} displaySize={48} />
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">{qr.id}</div>
                      {qr.description && (
                        <div className="text-sm text-muted-foreground">{qr.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <QrTypeBadge type={qr.type} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {qr.linkedRoute ? `${qr.linkedRoute.domain}${qr.linkedRoute.path}` : '—'}
                    </TableCell>
                    <TableCell className="text-xs">{(qr.tags ?? []).join(', ')}</TableCell>
                    <TableCell className="text-xs">
                      {new Date(qr.updatedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download SVG"
                          onClick={() => void handleDownload(qr, 'svg')}
                        >
                          <Download className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download PNG"
                          onClick={() => void handleDownload(qr, 'png')}
                        >
                          <QrCodeIcon className="size-4" />
                        </Button>
                        {!readOnly && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Edit"
                              onClick={() => setEditQr(qr)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Delete"
                              onClick={() => setDeleteTarget(qr)}
                            >
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {invalidItems.map(row => (
                  <TableRow
                    key={`invalid:${row.id}`}
                    data-testid="unreadable-qr"
                    className="bg-destructive/5"
                  >
                    <TableCell />
                    <TableCell>
                      <div className="font-mono text-sm">{row.id}</div>
                    </TableCell>
                    <TableCell colSpan={4}>
                      <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 font-inter text-tiny font-medium text-destructive">
                        Unreadable record
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        Stored in a shape that cannot be read. Delete it and create it again.
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      {!readOnly && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete"
                          aria-label={`Delete unreadable record ${row.id}`}
                          onClick={() => setDeleteTarget(row)}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {meta && meta.total > 0 && (
            <PaginationControls
              offset={meta.offset}
              limit={limit}
              total={meta.total}
              hasMore={meta.hasMore}
              onOffsetChange={setOffset}
              onLimitChange={l => {
                setLimit(l);
                persistPageSize(l);
                setOffset(0);
              }}
            />
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editQr} onOpenChange={open => !open && setEditQr(null)}>
        <DialogContent feedbackTrigger className="sm:max-w-xl lg:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-inter font-semibold text-blue-950">
              Edit QR code
            </DialogTitle>
            <DialogDescription className="font-inter">
              {editQr?.id} — type is immutable; the encoded content updates on save.
            </DialogDescription>
          </DialogHeader>
          {editQr && (
            <QrForm
              mode="edit"
              domain={editQr.domain}
              initial={editQr}
              submitting={updateQr.isPending}
              onSubmit={onUpdate}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete QR code?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.id} will be permanently deleted. Printed copies stop resolving only if
              they encode this record's payload; route-linked prints keep working while the route
              exists. The audit log preserves the record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

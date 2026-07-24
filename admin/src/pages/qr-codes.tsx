/**
 * QR Codes page (v1.54.0) — plan Rev 3, Approach C-prime.
 *
 * List + create/edit/delete for the unified QR resource. All previews and
 * downloads render CLIENT-SIDE via the shared renderer (WYSIWYG with the
 * Worker by construction; serving stays authed-only per the locked decision).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ContextualHelp } from '@/components/contextual-help';
import { FieldHint } from '@/components/field-hint';
import {
  QRDesignSchema,
  NEUTRAL_QR_DESIGN,
  QR_BRAND_PRESETS,
  QR_LOGO_MAX_BYTES,
  deriveBrandForDomain,
  normalizeQrId,
  qrContrastRatio,
  renderQrSvg,
  serializePayload,
  type QRCode,
  type QRDesign,
  type QRType,
  type QrBrandPreset,
} from '@bifrost/shared';
import { useQrCodes, useCreateQr, useUpdateQr, useDeleteQr, useDebounce } from '@/hooks';
import { SUPPORTED_DOMAINS } from '@/context';
import type { QrQueryParams } from '@/lib/api-client';
import { getPersistedPageSize, persistPageSize } from '@/lib/constants';
import { computeLogoAspectRatio, fetchBrandLogo } from '@/lib/qr-brand-logo';
import {
  designFromState,
  payloadFromState,
  stateFromQr,
  suggestQrId,
  TUNNELED_EAP_METHODS,
  WIFI_AUTH_TRIGGER_LABELS,
  type QrFormState,
} from '@/lib/qr-form-state';
import { downloadPng, downloadSvg } from '@/lib/svg-to-png';
import { QrPreview } from '@/components/qr-preview';
import { PaginationControls } from '@/components/pagination-controls';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Download, Pencil, Plus, QrCode as QrCodeIcon, Trash2 } from 'lucide-react';

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

// Pure form-state derivation lives in admin/src/lib/qr-form-state.ts (v1.58.0
// review round) — unit-tested there, incl. the stale-credential exclusions.

interface QrFormProps {
  mode: 'create' | 'edit';
  domain: string;
  initial?: QRCode;
  submitting: boolean;
  onSubmit: (input: Record<string, unknown>) => void;
}

function QrForm({ mode, domain, initial, submitting, onSubmit }: QrFormProps) {
  // Single-operator deployment (v1.30.0 port): the ADMIN_API_KEY grants full
  // write access — the upstream RBAC gate collapses to a constant.
  const writeLocked = false;
  const [s, setS] = useState<QrFormState>(() => stateFromQr(initial));
  const set = (patch: Partial<QrFormState>) => setS(prev => ({ ...prev, ...patch }));

  // Guard against stale async logo fetches: only the latest preset application
  // may write its logo into the form. The token is ALSO bumped on every
  // custom/upload transition (setCustom), so a pending preset fetch can never
  // overwrite a design the user has since taken manual control of.
  const presetApplyToken = useRef(0);

  // While a preset logo fetch or an upload's ratio computation is in flight,
  // submission is disabled — a quick submit must never store a half-prepared
  // design (colors without the logo, or a wordmark logo without its ratio).
  const [logoPending, setLogoPending] = useState(0);

  // Manual design edits take control: invalidate any pending preset fetch and
  // flip the selector to Custom in one step. (logoPending is untouched — every
  // in-flight operation decrements itself unconditionally on settle; only the
  // APPLICATION of its result is token-guarded.)
  const setCustom = (patch: Partial<QrFormState>) => {
    presetApplyToken.current += 1;
    set({ ...patch, brandSel: 'custom' });
  };

  // Apply a brand preset's design (or the neutral default for null). The logo
  // arrives async via the same-origin storage API; failure degrades to
  // colors-only with a toast.
  const applyPresetDesign = (preset: QrBrandPreset | null) => {
    const token = ++presetApplyToken.current;
    if (!preset) {
      set({ ...NEUTRAL_QR_DESIGN, logoDataUri: '', logoAspectRatio: null });
      return;
    }
    set({ fg: preset.fg, bg: preset.bg, logoDataUri: '', logoAspectRatio: null });
    if (preset.logoAssetKey) {
      setLogoPending(n => n + 1);
      fetchBrandLogo(preset.logoAssetKey)
        .then(logo => {
          if (presetApplyToken.current !== token) return;
          set({ logoDataUri: logo.dataUri, logoAspectRatio: logo.aspectRatio });
        })
        .catch(() => {
          if (presetApplyToken.current !== token) return;
          toast.warning(`${preset.label} logo unavailable — using colors only`);
        })
        .finally(() => setLogoPending(n => Math.max(0, n - 1)));
    }
  };

  // Auto mode resolves the preset from the target domain (and re-resolves if
  // the domain changes while still in Auto). Edit mode starts in Custom, so
  // stored designs are never clobbered.
  // oxlint-disable-next-line exhaustive-deps -- applyPresetDesign is stable-per-render by construction
  useEffect(() => {
    if (s.brandSel !== 'auto') return;
    applyPresetDesign(deriveBrandForDomain(domain));
  }, [domain, s.brandSel]);

  // Prefill the Reference from the type's identifying payload field, until the
  // user takes it over (v1.58.5; description deliberately NOT a source since
  // v1.58.7 — the two fields are independent). Create-only — in edit mode the
  // id is the immutable KV key and `idTouched` is seeded true.
  useEffect(() => {
    if (mode !== 'create' || s.idTouched) return;
    const suggested = suggestQrId(s);
    if (suggested && suggested !== s.id) set({ id: suggested });
    // oxlint-disable-next-line exhaustive-deps -- derives from the specific source fields below
  }, [mode, s.idTouched, s.type, s.ssid, s.url, s.name, s.text]);

  // Live preview content — invalid mid-typing states just blank the preview.
  // A route-linked QR encodes its short URL (v1.54.1 review fix): the edit
  // preview must agree with the list-row preview and the Worker render.
  const preview = useMemo(() => {
    try {
      const design = QRDesignSchema.parse(designFromState(s)) as QRDesign;
      const content = initial?.linkedRoute
        ? `https://${initial.linkedRoute.domain}${initial.linkedRoute.path}`
        : serializePayload(s.type, payloadFromState(s) as never);
      return content ? { content, design } : null;
    } catch {
      return null;
    }
  }, [s, initial]);

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
    reader.onload = () => {
      const dataUri = String(reader.result);
      setCustom({ logoDataUri: dataUri, logoAspectRatio: null });
      // Wordmark-shaped uploads get the wide-logo window too (ratio computed
      // client-side; undecodable images just keep the square window).
      void computeLogoAspectRatio(dataUri)
        .then(ratio => {
          if (ratio) {
            setS(prev =>
              prev.logoDataUri === dataUri ? { ...prev, logoAspectRatio: ratio } : prev,
            );
          }
        })
        .finally(() => setLogoPending(n => Math.max(0, n - 1)));
    };
    reader.onerror = () => setLogoPending(n => Math.max(0, n - 1));
    reader.readAsDataURL(file);
  };

  const submit = () => {
    const input: Record<string, unknown> = {
      ...(mode === 'create' ? { type: s.type, ...(s.id.trim() ? { id: s.id.trim() } : {}) } : {}),
      payload: payloadFromState(s),
      design: designFromState(s),
      // Always submit description — an explicit '' clears it server-side (codex F7).
      description: s.description.trim(),
      tags: s.tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
    };
    onSubmit(input);
  };

  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
      <div className="space-y-3">
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
                onChange={e => set({ id: normalizeQrId(e.target.value), idTouched: true })}
              />
            </div>
          </div>
        )}

        {s.type === 'url' && (
          <div className="space-y-1">
            <Label htmlFor="qr-url">URL / URI</Label>
            <Input
              id="qr-url"
              placeholder="https://… or mailto:, tel:, wa.me…"
              value={s.url}
              onChange={e => set({ url: e.target.value })}
            />
          </div>
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
              {/* Category picker, not a protocol picker (v1.58.0): every
                  password-secured personal network — WPA, WPA2, or WPA3 —
                  encodes the interoperable T:WPA token (T:SAE/T:WPA3 break
                  many scanners). Enterprise encodes the ZXing T:WPA2-EAP
                  extension. WEP is legacy, demoted last. */}
              <Select value={s.auth} onValueChange={v => set({ auth: v as QrFormState['auth'] })}>
                <SelectTrigger>
                  {/* Short trigger label; the menu below keeps the full
                      protocol list (v1.58.3 — the long label overflowed
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
                if (v !== 'auto') {
                  applyPresetDesign(QR_BRAND_PRESETS.find(p => p.id === v) ?? null);
                }
                // 'auto' re-applies via the effect above.
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
      </div>

      <div className="flex flex-col items-center gap-2">
        <Label>Preview</Label>
        {preview ? (
          <QrPreview content={preview.content} design={preview.design} />
        ) : (
          <div className="flex size-48 items-center justify-center rounded-md border text-sm text-muted-foreground">
            Fill in the fields
          </div>
        )}
        <Button
          onClick={submit}
          disabled={submitting || writeLocked || !preview || logoPending > 0}
        >
          {logoPending > 0
            ? 'Preparing logo…'
            : mode === 'create'
              ? 'Create QR code'
              : 'Save changes'}
        </Button>
      </div>
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
  const [domain, setDomain] = useState<string>(() => allowedDomains[0] ?? 'example.com');
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
  const meta = data?.meta;

  const createQr = useCreateQr();
  const updateQr = useUpdateQr();
  const deleteQr = useDeleteQr();

  const [createOpen, setCreateOpen] = useState(false);
  const [editQr, setEditQr] = useState<QRCode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QRCode | null>(null);

  const onCreate = (input: Record<string, unknown>) => {
    createQr.mutate(
      { input, domain },
      {
        onSuccess: qr => {
          toast.success(`QR code created: ${qr.id}`);
          setCreateOpen(false);
        },
        onError: e => toast.error(e instanceof Error ? e.message : 'Create failed'),
      },
    );
  };

  const onUpdate = (input: Record<string, unknown>) => {
    if (!editQr) return;
    updateQr.mutate(
      { id: editQr.id, input, domain: editQr.domain },
      {
        onSuccess: qr => {
          toast.success(`QR code updated: ${qr.id}`);
          setEditQr(null);
        },
        onError: e => toast.error(e instanceof Error ? e.message : 'Update failed'),
      },
    );
  };

  const onDelete = () => {
    if (!deleteTarget) return;
    deleteQr.mutate(
      { id: deleteTarget.id, domain: deleteTarget.domain },
      {
        onSuccess: () => {
          toast.success(`QR code deleted: ${deleteTarget.id}`);
          setDeleteTarget(null);
        },
        onError: e => toast.error(e instanceof Error ? e.message : 'Delete failed'),
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
          ) : items.length === 0 ? (
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
                          onClick={() => handleDownload(qr, 'svg')}
                        >
                          <Download className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download PNG"
                          onClick={() => handleDownload(qr, 'png')}
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

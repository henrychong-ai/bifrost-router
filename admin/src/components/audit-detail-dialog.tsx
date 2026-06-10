import { Copy, ExternalLink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AuditActionIcon } from '@/components/audit-action-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ACTION_COLORS,
  SOURCE_COLORS,
  SOURCE_LABELS,
  computeNavTargets,
  formatDate,
  formatRelativeTime,
  parseDetails,
  prettyPrintDetails,
} from '@/lib/audit-format';
import { useRoutesFilters, type SupportedDomain } from '@/context';
import { SUPPORTED_DOMAINS, type AuditLog } from '@/lib/schemas';
import { copyToClipboard } from '@/lib/utils';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-inter text-xs text-charcoal-600">{label}</span>
      <span className="text-sm break-all text-blue-950">{children}</span>
    </div>
  );
}

export function AuditDetailDialog({
  log,
  onClose,
}: {
  log: AuditLog | null;
  onClose: () => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const { setFilters: setRoutesFilters } = useRoutesFilters();
  const targets = log ? computeNavTargets(log) : [];
  const pretty = log ? prettyPrintDetails(log.details) : '';
  // Only build a live URL for a validated route target: a known supported
  // domain + an absolute path. Guards against a poisoned audit record pointing
  // the anchor at an unexpected origin (defence-in-depth; scheme is hardcoded).
  const liveUrl =
    log &&
    log.domain !== 'storage' &&
    log.path?.startsWith('/') &&
    (SUPPORTED_DOMAINS as readonly string[]).includes(log.domain)
      ? `https://${log.domain}${log.path}`
      : null;

  return (
    <Dialog
      open={!!log}
      onOpenChange={o => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl lg:max-w-2xl">
        {log && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <DialogTitle className="font-inter font-semibold text-blue-950">
                  Audit record
                </DialogTitle>
                <Badge variant="outline" className={`${ACTION_COLORS[log.action]} font-inter`}>
                  <AuditActionIcon action={log.action} />
                  {log.action}
                </Badge>
                {log.source !== 'bifrost' && (
                  <Badge variant="outline" className={`${SOURCE_COLORS[log.source]} font-inter`}>
                    {SOURCE_LABELS[log.source]}
                  </Badge>
                )}
              </div>
              <DialogDescription className="font-inter">
                {log.actorName ?? log.actorLogin ?? 'Unknown'} · {formatDate(log.createdAt)} ·{' '}
                {formatRelativeTime(log.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div
              className="
                grid grid-cols-1 gap-4
                sm:grid-cols-2
              "
            >
              <Field label="Domain">
                <span className="font-mono">{log.domain}</span>
              </Field>
              <Field label="Path">
                <span className="font-mono">{log.path ?? '-'}</span>
              </Field>
              <Field label="Actor">
                <span className="font-inter">{log.actorName ?? log.actorLogin ?? 'Unknown'}</span>
                {log.actorLogin && log.actorLogin !== log.actorName && (
                  <span className="block font-mono text-xs text-charcoal-600">
                    {log.actorLogin}
                  </span>
                )}
              </Field>
              <Field label="IP address">
                <span className="font-mono">{log.ipAddress ?? '-'}</span>
              </Field>
              <Field label="Created">
                <span className="font-inter">{formatDate(log.createdAt)}</span>
              </Field>
              <Field label="Record ID">
                <span className="font-mono">#{log.id}</span>
              </Field>
              <Field label="Source">
                <span className="font-inter">{SOURCE_LABELS[log.source]}</span>
              </Field>
            </div>

            <div className="flex flex-col gap-2">
              <span className="font-inter text-xs text-charcoal-600">Details</span>
              <p className="font-inter text-sm text-charcoal-700">{parseDetails(log.details)}</p>
              {pretty && (
                <pre
                  className="
                    max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono
                    text-xs break-all whitespace-pre-wrap text-charcoal-700
                  "
                >
                  {pretty}
                </pre>
              )}
            </div>

            <DialogFooter>
              {liveUrl && (
                <Button asChild variant="outline">
                  <a href={liveUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    Open live URL
                  </a>
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  // Copy the raw details payload only — not the full row (which
                  // carries actor login + IP already shown above).
                  copyToClipboard(log.details ?? '{}', 'Details JSON');
                }}
              >
                <Copy />
                Copy raw JSON
              </Button>
              {targets.map(t => (
                <Button
                  key={`${t.kind}-${t.label}`}
                  onClick={() => {
                    if (t.kind === 'route') {
                      // Surface the route on the Routes page by switching the
                      // domain filter and searching its path. The Routes page
                      // resolves it against live data (handles deleted routes
                      // gracefully — it simply shows no match).
                      setRoutesFilters({
                        domain: t.domain as SupportedDomain,
                        search: t.path,
                      });
                      navigate('/routes');
                    } else {
                      const params = new URLSearchParams({ bucket: t.bucket, open: t.key });
                      navigate(`/storage?${params.toString()}`);
                    }
                    onClose();
                  }}
                >
                  {t.label}
                </Button>
              ))}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

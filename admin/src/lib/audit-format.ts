import type { AuditAction, AuditLog, AuditSource } from '@/lib/schemas';

export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return formatDate(timestamp);
}

export const ACTION_COLORS: Record<AuditAction, string> = {
  create: 'bg-green-100 text-green-800 border-green-200',
  update: 'bg-blue-100 text-blue-800 border-blue-200',
  delete: 'bg-red-100 text-red-800 border-red-200',
  toggle: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  seed: 'bg-purple-100 text-purple-800 border-purple-200',
  migrate: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  transfer: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  r2_upload: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  r2_delete: 'bg-red-100 text-red-800 border-red-200',
  r2_rename: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  r2_move: 'bg-sky-100 text-sky-800 border-sky-200',
  r2_replace: 'bg-amber-100 text-amber-800 border-amber-200',
  r2_metadata_update: 'bg-blue-100 text-blue-800 border-blue-200',
  r2_cache_purge: 'bg-orange-100 text-orange-800 border-orange-200',
  r2_comment_update: 'bg-teal-100 text-teal-800 border-teal-200',
  feedback_create: 'bg-green-100 text-green-800 border-green-200',
  feedback_triage: 'bg-blue-100 text-blue-800 border-blue-200',
  feedback_delete: 'bg-red-100 text-red-800 border-red-200',
  r2_object_create: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
  r2_object_delete: 'bg-red-100 text-red-800 border-red-200',
  cf_config_change: 'bg-slate-100 text-slate-800 border-slate-200',
};

/**
 * Source pipeline badges. 'bifrost' renders no badge (the default,
 * uninteresting case); external pipelines get a visible marker.
 */
export const SOURCE_LABELS: Record<AuditSource, string> = {
  bifrost: 'Bifrost',
  r2_event: 'External',
  cf_audit: 'Cloudflare',
};

export const SOURCE_COLORS: Record<AuditSource, string> = {
  bifrost: 'bg-charcoal-100 text-charcoal-700 border-charcoal-200',
  r2_event: 'bg-orange-100 text-orange-800 border-orange-200',
  cf_audit: 'bg-blue-100 text-blue-800 border-blue-200',
};

export function parseDetails(details: string | null): string {
  if (!details) return '-';
  try {
    const parsed = JSON.parse(details);
    // CF audit-log poller entries: show the control-plane action type.
    if ('cf_audit_id' in parsed) {
      const resource = parsed.resource?.type
        ? ` on ${parsed.resource.type}${parsed.resource.id ? `/${parsed.resource.id}` : ''}`
        : '';
      return `${parsed.actionType || 'config change'}${resource}`;
    }
    // R2 event consumer entries: show raw R2 action + object.
    if ('r2Action' in parsed) {
      return `${parsed.r2Action}: ${parsed.bucket}/${parsed.key}`;
    }
    // For toggle actions, show enabled status
    if ('enabled' in parsed) {
      return parsed.enabled ? 'Enabled' : 'Disabled';
    }
    // For seed actions, show count
    if ('count' in parsed) {
      return `${parsed.count} routes`;
    }
    // For migrate actions, show old -> new path
    if ('oldPath' in parsed && 'newPath' in parsed) {
      return `${parsed.oldPath} -> ${parsed.newPath}`;
    }
    // For R2 move actions, show source -> destination
    if ('sourceBucket' in parsed && 'destinationBucket' in parsed) {
      const destKey = parsed.destinationKey || parsed.key;
      return `${parsed.sourceBucket}/${parsed.key} → ${parsed.destinationBucket}/${destKey}`;
    }
    // For R2 replace, show old and new size
    if ('replaced' in parsed && parsed.replaced) {
      const oldSize = parsed.replaced.size;
      const newSize = parsed.size;
      return `${parsed.bucket}/${parsed.key} (${oldSize} → ${newSize} bytes)`;
    }
    // For R2 rename, show old -> new key
    if ('bucket' in parsed && 'oldKey' in parsed && 'newKey' in parsed) {
      return `${parsed.oldKey} -> ${parsed.newKey}`;
    }
    // For R2 actions, show bucket/key info
    if ('bucket' in parsed && 'key' in parsed) {
      return `${parsed.bucket}/${parsed.key}`;
    }
    // For other actions, show a summary
    if ('route' in parsed) {
      return parsed.route?.target ? `Target: ${parsed.route.target}` : 'Route data';
    }
    if ('before' in parsed && 'after' in parsed) {
      return 'Modified route';
    }
    return JSON.stringify(parsed).slice(0, 50);
  } catch {
    return details.slice(0, 50);
  }
}

/**
 * Safely parse the audit `details` JSON into a plain object.
 * Returns null on null/empty input, parse error, or any non-object result
 * (arrays, primitives, null). Never throws.
 */
export function parseDetailsObject(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Pretty-print the audit `details` field. If it parses to an object, return
 * 2-space-indented JSON; otherwise return the raw non-empty string; otherwise ''.
 */
export function prettyPrintDetails(details: string | null): string {
  const parsed = parseDetailsObject(details);
  if (parsed !== null) {
    return JSON.stringify(parsed, null, 2);
  }
  if (typeof details === 'string' && details.length > 0) {
    return details;
  }
  return '';
}

export type NavTarget =
  | { kind: 'route'; label: string; domain: string; path: string }
  | { kind: 'storage'; label: string; bucket: string; key: string };

/** Type guard: non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Compute the navigation targets (jump buttons) for an audit log entry.
 *
 * Fully defensive: every field is guarded, and a target is only emitted when
 * its required fields are non-empty strings. Never throws. When in doubt,
 * fewer targets are emitted.
 */
export function computeNavTargets(
  log: Pick<AuditLog, 'action' | 'domain' | 'path' | 'details'>,
): NavTarget[] {
  // cf_config_change rows live under domain='storage' but their path is
  // `resource.type/resource.id` (e.g. "queue/bifrost-r2-events"), not a real
  // bucket/key — a storage nav target would dead-end on a non-existent bucket.
  if (log.action === 'cf_config_change') {
    return [];
  }

  const details = parseDetailsObject(log.details);

  // Feedback entries reference feedback shortIds, which are not routable — no nav target.
  if (log.domain === 'feedback' || log.action.startsWith('feedback_')) {
    return [];
  }

  const isStorage = log.domain === 'storage' || log.action.startsWith('r2_');

  if (isStorage) {
    return computeStorageTargets(log, details);
  }
  return computeRouteTargets(log, details);
}

function computeStorageTargets(
  log: Pick<AuditLog, 'action' | 'domain' | 'path' | 'details'>,
  details: Record<string, unknown> | null,
): NavTarget[] {
  const targets: NavTarget[] = [];

  if (log.action === 'r2_move') {
    const sourceBucket = details?.sourceBucket;
    const destinationBucket = details?.destinationBucket;
    const key = details?.key;
    const destinationKey = details?.destinationKey;

    // Primary: the file at its new location.
    const primaryKey = isNonEmptyString(destinationKey)
      ? destinationKey
      : isNonEmptyString(key)
        ? key
        : null;
    if (isNonEmptyString(destinationBucket) && primaryKey !== null) {
      targets.push({
        kind: 'storage',
        label: 'View file in storage',
        bucket: destinationBucket,
        key: primaryKey,
      });
    }

    // Secondary: the previous (source) file location.
    if (isNonEmptyString(sourceBucket) && isNonEmptyString(key)) {
      targets.push({
        kind: 'storage',
        label: 'View previous file',
        bucket: sourceBucket,
        key,
      });
    }

    return targets;
  }

  if (log.action === 'r2_rename') {
    const bucket = details?.bucket;
    const newKey = details?.newKey;
    const oldKey = details?.oldKey;

    if (isNonEmptyString(bucket) && isNonEmptyString(newKey)) {
      targets.push({
        kind: 'storage',
        label: 'View file in storage',
        bucket,
        key: newKey,
      });
    }
    if (isNonEmptyString(bucket) && isNonEmptyString(oldKey)) {
      targets.push({
        kind: 'storage',
        label: 'View previous file',
        bucket,
        key: oldKey,
      });
    }

    return targets;
  }

  // Default storage handling: derive bucket/key from path ("bucket/key").
  if (isNonEmptyString(log.path)) {
    const slashIndex = log.path.indexOf('/');
    if (slashIndex > 0) {
      const bucket = log.path.slice(0, slashIndex);
      const key = log.path.slice(slashIndex + 1);
      if (isNonEmptyString(bucket) && isNonEmptyString(key)) {
        return [{ kind: 'storage', label: 'View file in storage', bucket, key }];
      }
    }
  }

  // Fallback: bucket + key from details.
  const bucket = details?.bucket;
  const key = details?.key;
  if (isNonEmptyString(bucket) && isNonEmptyString(key)) {
    return [{ kind: 'storage', label: 'View file in storage', bucket, key }];
  }

  return [];
}

function computeRouteTargets(
  log: Pick<AuditLog, 'action' | 'domain' | 'path' | 'details'>,
  details: Record<string, unknown> | null,
): NavTarget[] {
  // Seed is a bulk operation — no single route target.
  if (log.action === 'seed') {
    return [];
  }

  if (log.action === 'migrate') {
    const targets: NavTarget[] = [];
    const newPath = details?.newPath;
    const oldPath = details?.oldPath;

    if (isNonEmptyString(log.domain) && isNonEmptyString(newPath)) {
      targets.push({
        kind: 'route',
        label: 'Open route',
        domain: log.domain,
        path: newPath,
      });
    }
    if (isNonEmptyString(log.domain) && isNonEmptyString(oldPath)) {
      targets.push({
        kind: 'route',
        label: 'Open previous route',
        domain: log.domain,
        path: oldPath,
      });
    }

    return targets;
  }

  if (log.action === 'transfer') {
    const targets: NavTarget[] = [];
    // Transfer keeps the same path, changing domain only.
    const toDomain = details?.toDomain;
    const fromDomain = details?.fromDomain;
    const detailsPath = details?.path;

    // Primary: the route at its new domain. Fall back to log.domain/log.path.
    const newDomain = isNonEmptyString(toDomain)
      ? toDomain
      : isNonEmptyString(log.domain)
        ? log.domain
        : null;
    const newPath = isNonEmptyString(detailsPath)
      ? detailsPath
      : isNonEmptyString(log.path)
        ? log.path
        : null;
    if (newDomain !== null && newPath !== null) {
      targets.push({
        kind: 'route',
        label: 'Open route',
        domain: newDomain,
        path: newPath,
      });
    }

    // Secondary: the route at its previous domain (same path).
    const oldPath = isNonEmptyString(detailsPath)
      ? detailsPath
      : isNonEmptyString(log.path)
        ? log.path
        : null;
    if (isNonEmptyString(fromDomain) && oldPath !== null) {
      targets.push({
        kind: 'route',
        label: 'Open previous route',
        domain: fromDomain,
        path: oldPath,
      });
    }

    return targets;
  }

  // create / update / delete / toggle: single target from log.path.
  if (isNonEmptyString(log.path) && isNonEmptyString(log.domain)) {
    return [{ kind: 'route', label: 'Open route', domain: log.domain, path: log.path }];
  }

  return [];
}

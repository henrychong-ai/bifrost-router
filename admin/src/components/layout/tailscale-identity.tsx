import { useTailscaleIdentity } from '@/hooks';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Displays Tailscale user identity in the header.
 * Shows user name with "Authenticated via Tailscale" subheading.
 * Falls back gracefully when not authenticated via Tailscale.
 */
export function TailscaleIdentity() {
  const { data: identity, isLoading } = useTailscaleIdentity();

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center gap-3">
        <div className="text-right">
          <Skeleton className="h-4 w-24 mb-1" />
          <Skeleton className="h-3 w-32" />
        </div>
        <Skeleton className="h-8 w-8 rounded-full" />
      </div>
    );
  }

  // Not authenticated via Tailscale
  if (!identity?.isAuthenticated) {
    return (
      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-sm font-medium text-muted-foreground">
            Not authenticated
          </p>
          <p className="text-xs text-muted-foreground/60">Local development</p>
        </div>
      </div>
    );
  }

  // Authenticated via Tailscale
  const displayName = identity.name || identity.login || 'Unknown User';

  return (
    <div className="flex items-center gap-3">
      <div className="text-right">
        <p className="text-sm font-medium text-foreground">{displayName}</p>
        <p className="text-xs text-muted-foreground">
          Authenticated via Tailscale
        </p>
      </div>
      {identity.profilePic ? (
        <img
          src={identity.profilePic}
          alt={displayName}
          className="h-8 w-8 rounded-full ring-2 ring-gold-500/20"
        />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gold-500/20 text-sm font-medium text-gold-600">
          {getInitials(displayName)}
        </div>
      )}
    </div>
  );
}

/**
 * Extract initials from a name for avatar fallback.
 */
function getInitials(name: string): string {
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

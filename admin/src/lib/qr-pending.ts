import { type QRCode, qrMatchesListFilters } from '@bifrost/shared';
import type { QRListMeta, QrQueryParams } from './api-client';
import { TOMBSTONE_SKEW_MARGIN_MS } from './server-time';

/**
 * How long the store holds what it knows about a code after it last learned
 * something new: KV list results lag a write by up to about 60 seconds, so 90
 * seconds covers the lag with margin without holding a stale copy for long.
 */
export const PENDING_QR_TTL_MS = 90 * 1000;

export interface QrListPage {
  items: QRCode[];
  meta: QRListMeta;
}

/** Store key: a code is unique per domain. */
const keyOf = (domain: string, id: string) => `${domain}\u0000${id}`;

/**
 * What the store knows about one code. `at` is when it last changed, on the
 * dashboard's clock: the TTL runs from there.
 *
 * - `live`: the newest version seen from any source, a mutation response or
 *   any server listing. `created` marks a code created in this session: only
 *   such a code may be ADDED to a first page that lacks it.
 * - `deleted`: a tombstone. The code was deleted, or the server answered
 *   QR_NOT_FOUND for it. `deletedAt` is on the SERVER's clock (the same clock
 *   as every record's `updatedAt`; see markDeleted): a server row with a
 *   LATER `updatedAt` is a code re-created after the deletion and beats the
 *   tombstone; any other row of the code is hidden until the TTL passes.
 */
type Entry =
  | { kind: 'live'; qr: QRCode; at: number; created: boolean }
  | { kind: 'deleted'; deletedAt: number; at: number };

/**
 * A read-only view of the store at one version. Its identity changes exactly
 * when what the store knows changes, so it is the `useSyncExternalStore`
 * snapshot and the dependency of the list query's `select`.
 */
export interface PendingQrView {
  readonly version: number;
  /** The list page as the store knows it. Pure: it never changes the store. */
  project(params: QrQueryParams | undefined, page: QrListPage): QrListPage;
}

/**
 * The latest known version of each QR code, applied when a list page is READ
 * (v1.38.0; it replaces the create-only pending store). KV listing is
 * eventually consistent: a list fetched right after a write can miss a new
 * code or show an older version, and responses for different filters can
 * arrive in any order. So the store keeps, per code, the version with the
 * highest `updatedAt` seen from any source — create and update responses and
 * every row of every server listing — and never moves backwards. Seeing a
 * current server row never removes an entry: only the TTL (90 seconds from
 * the entry's last change) or a delete (or a QR_NOT_FOUND) ends it, and a
 * deleted code stays a tombstone until its TTL passes or a later version of
 * it is seen.
 *
 * The React Query cache holds the RAW server pages. The list fetch only feeds
 * the store (`ingest`); the store is applied when a page is read, in the
 * query's `select` (`project`), which re-runs whenever the store changes. So
 * every read of every page — a cached page revisited within its staleTime, an
 * inactive page mounted again, a placeholder — shows the latest versions and
 * tombstones, and no cached page is ever patched.
 *
 * Projection, per server row: a tombstoned code is hidden; a row older than
 * the known version shows that version when it matches the list's filters
 * (the Worker's own predicate, `qrMatchesListFilters`) and is hidden when it
 * does not; any other row is shown as is. A code created in this session that
 * page 1 lacks is added to it as one extra row. An edited code is never added
 * to a page: the server sorts by `updatedAt` descending, so an edited code
 * moves to page 1 once the listing catches up, and until then it shows its
 * edit wherever the stale listing still puts it.
 *
 * The dashboard has no sign-out (its key comes from the deployment), so the
 * store lives as long as the page.
 */
export function createPendingQrStore(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();

  const fresh = (entry: Entry | undefined, at: number) =>
    entry && at - entry.at <= PENDING_QR_TTL_MS ? entry : undefined;

  function project(params: QrQueryParams | undefined, page: QrListPage): QrListPage {
    if (entries.size === 0) return page;
    const at = now();
    let altered = false;
    const items: QRCode[] = [];
    const listed = new Set<string>();
    for (const row of page.items) {
      const key = keyOf(row.domain, row.id);
      listed.add(key);
      const entry = fresh(entries.get(key), at);
      if (entry?.kind === 'deleted') {
        if (row.updatedAt > entry.deletedAt) {
          // Re-created after the deletion
          items.push(row);
        } else {
          altered = true;
        }
        continue;
      }
      if (entry && entry.qr.updatedAt > row.updatedAt) {
        // A stale row: the filters apply to the version the user will see
        altered = true;
        if (!params || qrMatchesListFilters(entry.qr, params)) items.push(entry.qr);
        continue;
      }
      // The server's own row passed the server's filters
      items.push(row);
    }

    if (params?.domain && page.meta.offset === 0) {
      const last = page.items.at(-1);
      for (const [key, stored] of entries) {
        const entry = fresh(stored, at);
        if (entry?.kind !== 'live' || !entry.created || listed.has(key)) continue;
        const { qr } = entry;
        if (qr.domain !== params.domain || !qrMatchesListFilters(qr, params)) continue;
        // It sorts onto a later page, where the server will list it
        if (page.meta.hasMore && last && qr.updatedAt < last.updatedAt) continue;
        items.push(qr);
        altered = true;
      }
    }
    if (!altered) return page;

    // Page 1 grows by the additions instead of dropping server rows: a
    // trimmed row would shift onto no page at all, because page 2 is the
    // server's own and starts after the server's page 1. The server's total
    // is kept, so every pagination label (page count, "of N") still matches
    // the server's pages; a created code is one extra row on page 1 until
    // the server lists it. In-place sort of a fresh local copy.
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { items, meta: { ...page.meta, count: items.length } };
  }

  let view: PendingQrView = { version: 0, project };

  /** A new snapshot, and every subscriber told: every page is read again. */
  function changed(): void {
    view = { version: view.version + 1, project };
    for (const listener of listeners) listener();
  }

  /** Drop expired entries. No snapshot change: a projection ignores them. */
  function prune(at: number): void {
    for (const [key, entry] of entries) {
      if (!fresh(entry, at)) entries.delete(key);
    }
  }

  /**
   * Raise the known version of `qr` from a listing (never lower it). A
   * tombstone yields only to a version later than the deletion. Whether
   * anything changed.
   */
  function raise(qr: QRCode, at: number): boolean {
    const key = keyOf(qr.domain, qr.id);
    const entry = entries.get(key);
    if (entry?.kind === 'deleted' && qr.updatedAt <= entry.deletedAt) return false;
    if (entry?.kind === 'live' && entry.qr.updatedAt >= qr.updatedAt) return false;
    entries.set(key, {
      kind: 'live',
      qr,
      at,
      created: entry?.kind === 'live' && entry.created,
    });
    return true;
  }

  /**
   * This session's own successful write of `qr` (create or update). It
   * supersedes any tombstone the store holds for the code, whatever the two
   * clocks say: the server has just answered that the code exists. A newer
   * version already seen (a listing that showed a later edit first) is kept.
   */
  function ownWrite(qr: QRCode, created: boolean): void {
    const at = now();
    prune(at);
    const key = keyOf(qr.domain, qr.id);
    const entry = entries.get(key);
    if (entry?.kind === 'live' && entry.qr.updatedAt >= qr.updatedAt) {
      // Nothing newer: only a create can mark the code as made here
      if (created && !entry.created) {
        entries.set(key, { ...entry, at, created: true });
        changed();
      }
      return;
    }
    entries.set(key, {
      kind: 'live',
      qr,
      at,
      created: created || (entry?.kind === 'live' && entry.created),
    });
    changed();
  }

  return {
    /** For `useSyncExternalStore`: called whenever the snapshot changes. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** The current view; a new object exactly when the store changed. */
    getSnapshot(): PendingQrView {
      return view;
    },

    /** Track a code this session's create returned (see ownWrite). */
    remember(qr: QRCode): void {
      ownWrite(qr, true);
    },

    /** Track the record this session's update returned (see ownWrite). */
    observeOwn(qr: QRCode): void {
      ownWrite(qr, false);
    },

    /**
     * Feed the rows of a server listing (in the list fetch): each row newer
     * than the known version raises it. The page itself is cached raw.
     */
    ingest(page: QrListPage): void {
      const at = now();
      prune(at);
      let raised = false;
      for (const row of page.items) raised = raise(row, at) || raised;
      if (raised) changed();
    },

    /**
     * The code was deleted, or the server says it no longer exists. The
     * tombstone hides every row of the code up to the deletion time, compared
     * with rows stamped by the SERVER's clock (`updatedAt`), so the deletion
     * time is the server's too: `serverTime`, the server's clock on the
     * answer (`serverTimeOf`: the validated `X-Server-Time`, else the end of
     * the `Date` second), plus {@link TOMBSTONE_SKEW_MARGIN_MS}, raised to
     * the last version the store knew. The margin keeps a stale row stamped
     * just after the deletion by another session's clock hidden; this
     * session's own re-create supersedes the tombstone at once (ownWrite).
     * Only when the answer carried no server time does the dashboard clock
     * stand in.
     */
    markDeleted(domain: string, id: string, serverTime?: number): void {
      const at = now();
      const key = keyOf(domain, id);
      // The known version is read BEFORE pruning: an entry past its TTL still
      // says which version this session saw, and a stale row of it must not
      // outlive the deletion
      const entry = entries.get(key);
      prune(at);
      const known =
        entry?.kind === 'live'
          ? entry.qr.updatedAt
          : entry?.kind === 'deleted'
            ? entry.deletedAt
            : 0;
      const deletion = (serverTime ?? at) + TOMBSTONE_SKEW_MARGIN_MS;
      entries.set(key, { kind: 'deleted', deletedAt: Math.max(deletion, known), at });
      changed();
    },

    /** Forget everything (tests). */
    clear(): void {
      entries.clear();
      changed();
    },

    /** Entries held, tombstones and expired entries included (for tests). */
    size(): number {
      return entries.size;
    },

    /** The list page as the store knows it now (see {@link PendingQrView}). */
    project,
  };
}

export type PendingQrStore = ReturnType<typeof createPendingQrStore>;

/** The dashboard's one store, shared by the QR hooks. */
export const pendingQrs = createPendingQrStore();

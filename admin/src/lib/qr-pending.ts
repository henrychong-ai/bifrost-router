import {
  type InvalidQRRow,
  parseSearchQuery,
  type QRCode,
  qrMatchesListFilters,
} from '@bifrost/shared';
import type { QRListMeta, QrQueryParams } from './api-client';

/**
 * How long the store holds what it knows about a code after it last learned
 * something new: 5 minutes. KV list results lag a write by about 60 seconds,
 * sometimes more at a slow location, and the TTL also bounds the deletion
 * tombstones, so a short one would let a deleted code reappear (or a new one
 * drop off page 1) while the listing is still stale.
 */
export const PENDING_QR_TTL_MS = 5 * 60 * 1000;

export interface QrListPage {
  items: QRCode[];
  /**
   * Rows for stored records that cannot be read (v1.38.0): shown flagged,
   * with a Delete action only. The store hides one only while a deletion of
   * its code is known.
   */
  invalid?: InvalidQRRow[] | undefined;
  meta: QRListMeta;
}

/** Store key: a code is unique per domain. */
const keyOf = (domain: string, id: string) => `${domain}\u0000${id}`;

/**
 * A deleted INCARNATION of a code (v1.38.0). A deleted code and a code
 * re-created later with the same id are different incarnations, and the
 * record's `createdAt` tells them apart: the Worker sets it at create, on its
 * own clock (a client value is ignored), and every update keeps it. So the
 * store keeps one tombstone per deleted incarnation, each until its own TTL,
 * and never compares clocks across incarnations. The incarnation comes from
 * the server: the delete answer names the `createdAt` of the record it
 * removed; a `QR_NOT_FOUND` names none, and the incarnation the request was
 * made for (bound to it by the dialog) is used.
 */
interface Tombstone {
  createdAt: number;
  /** When the store learned of it, on the dashboard's clock: the TTL runs from here. */
  at: number;
}

/**
 * The newest version of one code the store has seen, from a mutation answer
 * or any server listing. `created` marks a code created in this session:
 * only such a code may be ADDED to a first page that lacks it. `at` is when
 * the entry last changed, on the dashboard's clock: the TTL runs from there.
 */
interface LiveEntry {
  qr: QRCode;
  at: number;
  created: boolean;
}

/**
 * Whether a tombstone hides a version of its code: one of the deleted
 * incarnation (the same `createdAt`), whatever its `updatedAt` and whenever it
 * arrives (a stale row stamped after the deletion by a faster clock, a
 * delayed answer to an update issued before the deletion). A version of
 * another incarnation (another session's re-create, or this session's) is
 * never hidden by it. No clock is compared.
 */
function hides(tombstone: Tombstone, qr: QRCode): boolean {
  return qr.createdAt === tombstone.createdAt;
}

/** Whether a version or tombstone learned at `entry.at` is still held at `at`. */
const isFresh = (entry: { at: number }, at: number) => at - entry.at <= PENDING_QR_TTL_MS;

/**
 * Whether `qr` is a newer version than `known`: a later incarnation (a later
 * `createdAt`), or within one incarnation a later `updatedAt`.
 */
const isNewer = (qr: QRCode, known: QRCode) =>
  qr.createdAt !== known.createdAt
    ? qr.createdAt > known.createdAt
    : qr.updatedAt > known.updatedAt;

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
 * arrive in any order. So the store keeps, per code, the newest version seen
 * from any source — create and update responses and every row of every
 * server listing — and never moves backwards (`isNewer`); and, per deleted
 * incarnation, a tombstone (`hides`). Seeing a current server row never
 * removes an entry: only the TTL (5 minutes from the entry's last change)
 * ends a version or a tombstone, and a deletion ends the version of the
 * incarnation it deleted.
 *
 * The React Query cache holds the RAW server pages. The list fetch only feeds
 * the store (`ingest`); the store is applied when a page is read, in the
 * query's `select` (`project`), which re-runs whenever the store changes. So
 * every read of every page — a cached page revisited within its staleTime, an
 * inactive page mounted again, a placeholder — shows the latest versions and
 * tombstones, and no cached page is ever patched.
 *
 * Projection, per server row: a row older than the known version shows that
 * version when it matches the list's filters (the Worker's own predicate,
 * `qrMatchesListFilters`) and is hidden when it does not; else a row a
 * tombstone hides is hidden; any other row is shown as is. A code created in this
 * session that page 1 lacks is added to it as one extra row. An edited code
 * is never added to a page: the server sorts by `updatedAt` descending, so an
 * edited code moves to page 1 once the listing catches up, and until then it
 * shows its edit wherever the stale listing still puts it. A row for an
 * unreadable record is hidden while a deletion of its code is known (one of
 * an unreadable record names no incarnation, so it hides those rows only).
 *
 * The dashboard has no sign-out (its key comes from the deployment), so the
 * store lives as long as the page.
 */
export function createPendingQrStore(now: () => number = Date.now) {
  const live = new Map<string, LiveEntry>();
  const tombstones = new Map<string, Tombstone[]>();
  /** Codes whose unreadable record this session deleted: when, for the TTL. */
  const unreadableDeleted = new Map<string, number>();
  const listeners = new Set<() => void>();

  const freshLive = (key: string, at: number) => {
    const entry = live.get(key);
    return entry && isFresh(entry, at) ? entry : undefined;
  };
  const freshTombstones = (key: string, at: number) =>
    (tombstones.get(key) ?? []).filter(tombstone => isFresh(tombstone, at));
  const hidden = (qr: QRCode, at: number) =>
    freshTombstones(keyOf(qr.domain, qr.id), at).some(tombstone => hides(tombstone, qr));

  function project(params: QrQueryParams | undefined, page: QrListPage): QrListPage {
    if (live.size === 0 && tombstones.size === 0 && unreadableDeleted.size === 0) return page;
    const at = now();
    let altered = false;
    // The list's filters, with the search parsed once for every row
    const filters = params && { ...params, search: parseSearchQuery(params.search) };
    const items: QRCode[] = [];
    const listed = new Set<string>();
    for (const row of page.items) {
      const key = keyOf(row.domain, row.id);
      listed.add(key);
      // A newer version the store knows (never one a tombstone hides) stands
      // in for a stale row, of an older incarnation too: the filters apply to
      // the version the user will see
      const entry = freshLive(key, at);
      if (entry && isNewer(entry.qr, row)) {
        altered = true;
        if (!filters || qrMatchesListFilters(entry.qr, filters)) items.push(entry.qr);
        continue;
      }
      if (hidden(row, at)) {
        altered = true;
        continue;
      }
      // The server's own row passed the server's filters
      items.push(row);
    }

    if (params?.domain && filters && page.meta.offset === 0) {
      const last = page.items.at(-1);
      for (const [key, entry] of live) {
        if (!isFresh(entry, at) || !entry.created || listed.has(key)) continue;
        const { qr } = entry;
        if (qr.domain !== params.domain || !qrMatchesListFilters(qr, filters)) continue;
        // It sorts onto a later page, where the server will list it
        if (page.meta.hasMore && last && qr.updatedAt < last.updatedAt) continue;
        items.push(qr);
        altered = true;
      }
    }

    const invalid = page.invalid?.filter(row => {
      const key = keyOf(row.domain, row.id);
      const unreadableAt = unreadableDeleted.get(key);
      const deleted = unreadableAt !== undefined && isFresh({ at: unreadableAt }, at);
      return !deleted && freshTombstones(key, at).length === 0;
    });
    if (invalid && invalid.length !== page.invalid?.length) altered = true;
    if (!altered) return page;

    // Page 1 grows by the additions instead of dropping server rows: a
    // trimmed row would shift onto no page at all, because page 2 is the
    // server's own and starts after the server's page 1. The server's total
    // is kept, so every pagination label (page count, "of N") still matches
    // the server's pages; a created code is one extra row on page 1 until
    // the server lists it. In-place sort of a fresh local copy: the
    // dashboard's build target predates Array#toSorted.
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      items,
      ...(invalid === undefined ? {} : { invalid }),
      meta: { ...page.meta, count: items.length + (invalid?.length ?? 0) },
    };
  }

  let view: PendingQrView = { version: 0, project };

  /** A new snapshot, and every subscriber told: every page is read again. */
  function changed(): void {
    view = { version: view.version + 1, project };
    for (const listener of listeners) listener();
  }

  /** Drop expired versions and tombstones. No snapshot change: a projection ignores them. */
  function prune(at: number): void {
    for (const [key, entry] of live) {
      if (!isFresh(entry, at)) live.delete(key);
    }
    for (const [key, list] of tombstones) {
      const kept = list.filter(tombstone => isFresh(tombstone, at));
      if (kept.length === 0) tombstones.delete(key);
      else tombstones.set(key, kept);
    }
    for (const [key, deletedAt] of unreadableDeleted) {
      if (!isFresh({ at: deletedAt }, at)) unreadableDeleted.delete(key);
    }
  }

  /**
   * Record `qr` if it is newer than what the store knows (never lower it) and
   * no tombstone hides it. Whether anything changed.
   */
  function raise(qr: QRCode, at: number, created: boolean): boolean {
    if (hidden(qr, at)) return false;
    const key = keyOf(qr.domain, qr.id);
    const entry = live.get(key);
    if (entry && !isNewer(qr, entry.qr)) {
      // Nothing newer: only a create can mark the code as made here
      if (!created || entry.created) return false;
      live.set(key, { ...entry, at, created: true });
      return true;
    }
    live.set(key, { qr, at, created: created || (entry?.created ?? false) });
    return true;
  }

  /** Feed one version from a mutation answer. */
  function own(qr: QRCode, created: boolean): void {
    const at = now();
    prune(at);
    if (raise(qr, at, created)) changed();
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

    /**
     * Track a code this session's create returned. A create is a new
     * incarnation, so the tombstone of a deleted one never hides it, even
     * when its clock stamped it before the deletion. A create answer for an
     * incarnation already deleted (deleted while the answer was in flight) is
     * dropped.
     */
    remember(qr: QRCode): void {
      own(qr, true);
    },

    /**
     * Track the record this session's update returned, if it is newer than
     * the version the store knows. An answer for a deleted incarnation (an
     * update issued before the deletion landed) is dropped.
     */
    observeOwn(qr: QRCode): void {
      own(qr, false);
    },

    /**
     * Feed the rows of a server listing (in the list fetch): each row newer
     * than the known version raises it. The page itself is cached raw.
     */
    ingest(page: QrListPage): void {
      const at = now();
      prune(at);
      let raised = false;
      for (const row of page.items) raised = raise(row, at, false) || raised;
      if (raised) changed();
    },

    /**
     * The code was deleted, or the server says it no longer exists.
     * `createdAt` names the incarnation that is gone: the one the delete
     * answer names (the record it removed), or, for a `QR_NOT_FOUND`, the one
     * the request was made for. Never whatever the store knows by the time
     * the reply arrives, since a delayed reply can land after the code was
     * re-created. Every deleted incarnation keeps its own tombstone until its
     * own TTL, so deletions of several incarnations, in any order, never undo
     * each other. Without a `createdAt` (an unreadable record was deleted)
     * no version is hidden; only the rows listing that unreadable record are.
     */
    markDeleted(domain: string, id: string, createdAt?: number): void {
      const at = now();
      const key = keyOf(domain, id);
      prune(at);
      if (createdAt === undefined) {
        unreadableDeleted.set(key, at);
        changed();
        return;
      }
      const deletion: Tombstone = { createdAt, at };
      tombstones.set(key, [
        ...(tombstones.get(key) ?? []).filter(tombstone => tombstone.createdAt !== createdAt),
        deletion,
      ]);
      // The deleted incarnation's version is gone; another one is kept
      const entry = live.get(key);
      if (entry && hides(deletion, entry.qr)) live.delete(key);
      changed();
    },

    /** Forget everything (tests). */
    clear(): void {
      live.clear();
      tombstones.clear();
      unreadableDeleted.clear();
      changed();
    },

    /** Versions and tombstones held, expired ones included (for tests). */
    size(): number {
      let count = live.size + unreadableDeleted.size;
      for (const list of tombstones.values()) count += list.length;
      return count;
    },

    /** The list page as the store knows it now (see {@link PendingQrView}). */
    project,
  };
}

export type PendingQrStore = ReturnType<typeof createPendingQrStore>;

/** The dashboard's one store, shared by the QR hooks. */
export const pendingQrs = createPendingQrStore();

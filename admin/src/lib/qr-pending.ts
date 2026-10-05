import { type QRCode, qrMatchesListFilters } from '@bifrost/shared';
import type { QRListMeta, QrQueryParams } from './api-client';

/** How long a created code is merged into lists the server has not caught up on. */
export const PENDING_QR_TTL_MS = 5 * 60 * 1000;

export interface QrListPage {
  items: QRCode[];
  meta: QRListMeta;
}

/** Store key: a code is unique per domain. */
const keyOf = (domain: string, id: string) => `${domain}\u0000${id}`;

/**
 * QR codes created in this session that a list may not show yet. KV listing
 * is eventually consistent, so a list fetched right after a create can miss
 * the new code. Every list response for
 * that code's domain is merged with it — first page only, and only when the
 * list's filters match, by the Worker's own predicate — until the server list
 * contains it, the code is deleted, or the TTL passes.
 */
export function createPendingQrStore(now: () => number = Date.now) {
  const pending = new Map<string, { qr: QRCode; addedAt: number }>();

  return {
    /** Track a code the create call returned. */
    remember(qr: QRCode): void {
      pending.set(keyOf(qr.domain, qr.id), { qr, addedAt: now() });
    },

    /** Keep a still-pending code's record current after an update. */
    update(qr: QRCode): void {
      const key = keyOf(qr.domain, qr.id);
      const entry = pending.get(key);
      if (entry) pending.set(key, { qr, addedAt: entry.addedAt });
    },

    /** Stop tracking a code (it was deleted). */
    forget(domain: string, id: string): void {
      pending.delete(keyOf(domain, id));
    },

    size(): number {
      return pending.size;
    },

    /**
     * The list page with every matching pending code merged in, newest first
     * like the Worker's listing. `total`, `offset`, `limit` and `hasMore`
     * stay the server's; only `count` follows the merged items.
     * Drops entries the page already contains (the server has caught up) and
     * entries past the TTL.
     */
    merge(params: QrQueryParams | undefined, page: QrListPage): QrListPage {
      if (!params?.domain) return page;
      const at = now();
      const additions: QRCode[] = [];
      for (const [key, { qr, addedAt }] of pending) {
        if (at - addedAt > PENDING_QR_TTL_MS) {
          pending.delete(key);
          continue;
        }
        if (params.domain !== qr.domain) continue;
        if (page.items.some(item => item.id === qr.id)) {
          pending.delete(key);
          continue;
        }
        if (page.meta.offset !== 0) continue;
        if (!qrMatchesListFilters(qr, params)) continue;
        additions.push(qr);
      }
      if (additions.length === 0) return page;

      // Page 1 grows by the additions instead of dropping server rows: a
      // trimmed row would shift onto no page at all, because page 2 is the
      // server's own and starts after the server's page 1.
      //
      // `total` stays the server's. The pagination controls derive every
      // label from it, so adding the pending codes would announce a page the
      // server does not have: 50 rows at limit 50 plus one pending code would
      // read "Showing 1-50 of 51" and "Page 1 of 2" with Next disabled.
      const items = [...additions, ...page.items];
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      return { items, meta: { ...page.meta, count: items.length } };
    },
  };
}

export type PendingQrStore = ReturnType<typeof createPendingQrStore>;

/** The dashboard's one store, shared by the QR hooks. */
export const pendingQrs = createPendingQrStore();

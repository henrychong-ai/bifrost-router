/**
 * Recently written QR codes, per domain (v1.40.0). KV's `list` lags a write
 * by about 60 seconds, so a code just created was missing from every listing
 * (MCP `list_qrs`, the REST API, another dashboard tab) except the dashboard
 * that created it, which merges its own. A `get` sees a write at once at the
 * location that made it, so each QR write also records the code's id in ONE
 * small key, `qr-recent:{domain}`, and `listQRs` reads that key and fetches
 * any recent id its listing lacks: every client at that location gets the
 * same list.
 *
 * Best effort, never a failed write: the key is read, updated and written
 * back with no compare-and-set (two writes at once can drop one id, which
 * the listing then shows a minute later, as before), KV refuses more than one
 * write a second to one key (such a refusal is logged and ignored), and
 * another location sees the key as late as it sees the listing. A deleted
 * code needs no entry: the listing reads every listed key with `get`, and a
 * key that is gone is left out. The key holds ids and times only, expires on
 * its own, and is outside every prefix the routes, QR listing and the backup
 * read (`qr:` and `{domain}:/`).
 */
import { z } from 'zod';
import { readKvJson } from '../utils/boundary';
import { errorName } from '../utils/error-name';

/** How long a write is remembered: past KV's listing lag, with room. */
export const QR_RECENT_WINDOW_MS = 120_000;

/** Most ids one domain's key holds (the newest are kept). */
export const QR_RECENT_MAX = 100;

/** The key's own expiry, in seconds (KV's minimum is 60). */
const QR_RECENT_TTL_SECONDS = 300;

/** The key of a domain's recent QR writes. */
export function qrRecentKey(domain: string): string {
  return `qr-recent:${domain}`;
}

const RecentWritesSchema = z
  .array(z.object({ id: z.string().min(1).max(512), at: z.number().int().nonnegative() }))
  .max(QR_RECENT_MAX);

/** One recent write: the code's id and when it was written. */
export type RecentQRWrite = z.infer<typeof RecentWritesSchema>[number];

/** The ids written within the window before `now`, newest last; [] on any failure. */
export async function readRecentQRWrites(
  kv: KVNamespace,
  domain: string,
  now: number = Date.now(),
): Promise<RecentQRWrite[]> {
  try {
    const read = await readKvJson(kv, qrRecentKey(domain), RecentWritesSchema);
    if (read.status !== 'ok') return [];
    return read.value.filter(write => now - write.at <= QR_RECENT_WINDOW_MS);
  } catch (error) {
    console.warn(`[QR] Recent writes could not be read: ${errorName(error)}`);
    return [];
  }
}

/** Record that `id` was just written (best effort; never throws). */
export async function recordRecentQRWrite(
  kv: KVNamespace,
  domain: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    const kept = (await readRecentQRWrites(kv, domain, now)).filter(write => write.id !== id);
    const writes = [...kept, { id, at: now }].slice(-QR_RECENT_MAX);
    await kv.put(qrRecentKey(domain), JSON.stringify(writes), {
      expirationTtl: QR_RECENT_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(`[QR] Recent write could not be recorded: ${errorName(error)}`);
  }
}

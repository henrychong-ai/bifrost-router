import { type QRCode, QRDesignSchema } from '@bifrost/shared';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/env', () => ({
  env: { VITE_API_URL: 'https://api.example.test', ADMIN_API_KEY: 'test-admin-key' },
}));

// `vi.mock` is hoisted above every top-level binding, so the spies are created
// inside the factory and read back from the mocked module afterwards.
vi.mock('@/lib/api-client', () => ({
  api: {
    qr: {
      list: vi.fn<typeof api.qr.list>(),
      create: vi.fn<typeof api.qr.create>(),
      get: vi.fn<typeof api.qr.get>(),
      update: vi.fn<typeof api.qr.update>(),
      delete: vi.fn<typeof api.qr.delete>(),
    },
  },
}));

import { api } from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';
import { createPendingQrStore, type PendingQrStore, type QrListPage } from '@/lib/qr-pending';
import {
  createQrMutationOptions,
  deleteQrMutationOptions,
  fetchQrList,
  qrKeys,
  updateQrMutationOptions,
} from './use-qr-codes';

const list = vi.mocked(api.qr.list);
const create = vi.mocked(api.qr.create);
const get = vi.mocked(api.qr.get);
const update = vi.mocked(api.qr.update);
const remove = vi.mocked(api.qr.delete);

function qr(id: string, overrides: Partial<QRCode> = {}): QRCode {
  return {
    id,
    domain: 'example.com',
    type: 'url',
    payload: { url: `https://example.com/${id}` },
    design: QRDesignSchema.parse({}),
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'test',
    ...overrides,
  };
}

const emptyPage = () => ({
  items: [],
  meta: { total: 0, count: 0, offset: 0, limit: 50, hasMore: false },
});
const params = { domain: 'example.com', limit: 50, offset: 0 };
const notFound = () =>
  new ApiError(404, 'QR code not found: a', undefined, { code: 'QR_NOT_FOUND' });

afterEach(() => {
  vi.clearAllMocks();
});

type Params = typeof params | (typeof params & { type?: string; tag?: string });

/** A fetch, then a read: what the list query shows for a fresh fetch. */
async function read(listParams: Params, store: PendingQrStore) {
  return store.getSnapshot().project(listParams, await fetchQrList(listParams, store));
}

/**
 * A list observer wired as `useQrCodes` wires it: raw pages in the cache, the
 * store applied in `select`, and a new `select` whenever the store changes.
 */
function watchList(client: QueryClient, store: PendingQrStore) {
  const options = () => ({
    queryKey: qrKeys.list(params),
    queryFn: () => fetchQrList(params, store),
    select: (page: QrListPage) => store.getSnapshot().project(params, page),
  });
  const observer = new QueryObserver(client, options());
  const stopStore = store.subscribe(() => observer.setOptions(options()));
  const stopObserver = observer.subscribe(() => {});
  return {
    shown: () => observer.getCurrentResult().data?.items.map(item => item.id),
    stop: () => {
      stopObserver();
      stopStore();
    },
  };
}

describe('QR list and mutation wiring', () => {
  it('shows a created code in the stale list fetched right after the create', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    create.mockResolvedValueOnce(qr('fresh', { updatedAt: 10 }));
    list.mockResolvedValue(emptyPage());

    await new MutationObserver(client, createQrMutationOptions(client, store)).mutate({
      input: { type: 'url' },
      domain: 'example.com',
    });

    expect(create).toHaveBeenCalledWith({ type: 'url' }, 'example.com');
    expect(store.size()).toBe(1);
    expect((await read(params, store)).items.map(item => item.id)).toEqual(['fresh']);
  });

  it('invalidates lists instead of patching them, so an inactive list is marked stale, not fresh', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    const key = qrKeys.list(params);
    client.setQueryData(key, emptyPage());
    const before = client.getQueryState(key)?.dataUpdatedAt;
    create.mockResolvedValueOnce(qr('fresh'));

    await new MutationObserver(client, createQrMutationOptions(client, store)).mutate({
      input: {},
      domain: 'example.com',
    });

    const state = client.getQueryState(key);
    expect(state?.isInvalidated).toBe(true);
    expect(state?.dataUpdatedAt).toBe(before);
    expect(client.getQueryData(key)).toEqual(emptyPage());
  });

  it('keeps an updated code current, and hides a deleted one from stale listings', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    store.remember(qr('a', { description: 'first' }));
    update.mockResolvedValueOnce(qr('a', { description: 'second', updatedAt: 2 }));
    // The answer names the deleted record's createdAt
    remove.mockResolvedValueOnce({ createdAt: 1 });
    list.mockResolvedValue(emptyPage());

    await new MutationObserver(client, updateQrMutationOptions(client, store)).mutate({
      id: 'a',
      input: { description: 'second' },
      domain: 'example.com',
    });
    expect((await read(params, store)).items.map(item => item.description)).toEqual(['second']);

    await new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
      id: 'a',
      domain: 'example.com',
    });
    expect(remove).toHaveBeenCalledWith('a', 'example.com');
    expect((await read({ ...params, type: 'url' }, store)).items).toEqual([]);
    // A stale listing that still holds it drops it too (a tombstone)
    list.mockResolvedValueOnce({ ...emptyPage(), items: [qr('a')] });
    expect((await read(params, store)).items).toEqual([]);
  });

  it('tombstones the incarnation the delete answer names, not the one the dialog showed', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    // The dialog shows A (createdAt 1); the server had B (createdAt 50), and deletes B
    remove.mockResolvedValueOnce({ createdAt: 50 });
    await new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
      id: 'a',
      domain: 'example.com',
      createdAt: 1,
    });
    const project = (row: QRCode) =>
      store.getSnapshot().project(params, { ...emptyPage(), items: [row] }).items.length;
    expect(project(qr('a', { createdAt: 50, updatedAt: 60 }))).toBe(0);
    // Another incarnation is never hidden, whatever its clock
    expect(project(qr('a', { createdAt: 70, updatedAt: 70 }))).toBe(1);
    // An answer without a createdAt (an older Worker) falls back to the request's
    remove.mockResolvedValueOnce({});
    await new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
      id: 'c',
      domain: 'example.com',
      createdAt: 9,
    });
    expect(project(qr('c', { createdAt: 9, updatedAt: 99 }))).toBe(0);
  });

  it('shows a code this session re-creates in the same second as its deletion, at once', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    remove.mockResolvedValueOnce({ createdAt: 1 });
    await new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
      id: 'a',
      domain: 'example.com',
      createdAt: 1,
    });
    // A new incarnation, stamped before the deletion by a slower clock
    create.mockResolvedValueOnce(
      qr('a', { description: 'again', createdAt: 10_100, updatedAt: 10_100 }),
    );
    await new MutationObserver(client, createQrMutationOptions(client, store)).mutate({
      input: {},
      domain: 'example.com',
    });
    list.mockResolvedValueOnce({ ...emptyPage(), items: [qr('a', { updatedAt: 10_128 })] });
    expect((await read(params, store)).items.map(item => item.description)).toEqual(['again']);
  });

  it('tombstones the incarnation a delayed delete reply names, never the re-created one', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    let reply: ((value: { createdAt?: number }) => void) | undefined;
    remove.mockReturnValueOnce(
      new Promise(resolve => {
        reply = resolve;
      }),
    );
    const deleting = new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
      id: 'a',
      domain: 'example.com',
      createdAt: 1,
    });
    // Before the reply: re-created and listed
    const recreated = qr('a', { description: 'B', createdAt: 20_000, updatedAt: 20_000 });
    create.mockResolvedValueOnce(recreated);
    await new MutationObserver(client, createQrMutationOptions(client, store)).mutate({
      input: {},
      domain: 'example.com',
    });
    list.mockResolvedValueOnce({ ...emptyPage(), items: [recreated] });
    await read(params, store);
    reply?.({ createdAt: 1 });
    await deleting;
    list.mockResolvedValueOnce({ ...emptyPage(), items: [recreated] });
    expect((await read(params, store)).items.map(item => item.description)).toEqual(['B']);
  });

  it('fetches through the module store by default', async () => {
    list.mockResolvedValueOnce(emptyPage());
    expect(await fetchQrList(params)).toEqual(emptyPage());
  });

  it('returns the raw server page from the fetch and only feeds the store', async () => {
    const store = createPendingQrStore();
    store.observeOwn(qr('a', { description: 'v20', updatedAt: 20 }));
    const raw = {
      ...emptyPage(),
      items: [qr('a', { description: 'v10', updatedAt: 10 }), qr('b')],
    };
    list.mockResolvedValueOnce(raw);
    expect(await fetchQrList(params, store)).toBe(raw);
    // Both rows were ingested; the older `a` did not lower the known v20
    expect(store.size()).toBe(2);
  });

  it.each([
    ['delete', deleteQrMutationOptions, remove],
    ['update', updateQrMutationOptions, update],
  ] as const)(
    'drops a code when %s answers QR_NOT_FOUND, and refreshes the rendered list without it',
    async (_label, factory, call) => {
      const client = new QueryClient();
      const store = createPendingQrStore();
      store.remember(qr('b'));
      // The server still lists `a` (a stale listing) on every fetch
      const stale = { ...emptyPage(), items: [qr('a'), qr('b')] };
      list.mockResolvedValue(stale);
      const list$ = watchList(client, store);
      await vi.waitFor(() => expect(list$.shown()).toEqual(['a', 'b']));
      expect(list).toHaveBeenCalledTimes(1);

      (call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(notFound());
      await expect(
        new MutationObserver(client, factory(client, store) as never).mutate({
          id: 'a',
          input: {},
          domain: 'example.com',
          // The incarnation the request was made for
          createdAt: 1,
        } as never),
      ).rejects.toBeInstanceOf(ApiError);

      // Invalidated and refetched (the mutation awaits it): the rendered list
      // no longer shows `a`, though the server still lists it. The cache keeps
      // the raw server page; the store hides `a` when it is read.
      expect(list).toHaveBeenCalledTimes(2);
      expect(client.getQueryState(qrKeys.list(params))?.isInvalidated).toBe(false);
      expect(
        client.getQueryData<QrListPage>(qrKeys.list(params))?.items.map(item => item.id),
      ).toEqual(['a', 'b']);
      expect(list$.shown()).toEqual(['b']);
      list$.stop();
    },
  );

  it.each([
    ['delete', deleteQrMutationOptions, remove],
    ['update', updateQrMutationOptions, update],
  ] as const)(
    'leaves the store and cache alone when %s answers a 404 that is not QR_NOT_FOUND',
    async (_label, factory, call) => {
      const client = new QueryClient();
      const store = createPendingQrStore();
      list.mockResolvedValue({ ...emptyPage(), items: [qr('a'), qr('b')] });
      const list$ = watchList(client, store);
      await vi.waitFor(() => expect(list$.shown()).toEqual(['a', 'b']));
      const sizeBefore = store.size();

      // A route-level 404 (no such endpoint, a proxy): no QR error code
      (call as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(404, 'Not Found'));
      await expect(
        new MutationObserver(client, factory(client, store) as never).mutate({
          id: 'a',
          input: {},
          domain: 'example.com',
        } as never),
      ).rejects.toBeInstanceOf(ApiError);

      expect(store.size()).toBe(sizeBefore);
      expect(list).toHaveBeenCalledTimes(1);
      expect(client.getQueryState(qrKeys.list(params))?.isInvalidated).toBe(false);
      expect(list$.shown()).toEqual(['a', 'b']);
      // No tombstone: a later listing still shows the code
      expect((await read(params, store)).items.map(item => item.id)).toEqual(['a', 'b']);
      list$.stop();
    },
  );

  it('shows the newest version across out-of-order responses for two filters', async () => {
    const store = createPendingQrStore();
    // The fresh unfiltered response arrives first: v20 has moved to the web tag
    list.mockResolvedValueOnce({
      ...emptyPage(),
      items: [qr('a', { tags: ['web'], updatedAt: 20 })],
    });
    // Then the print-filtered response, fetched before the edit, still at v10
    list.mockResolvedValueOnce({
      ...emptyPage(),
      items: [qr('a', { tags: ['print'], updatedAt: 10 })],
    });
    expect((await read(params, store)).items.map(item => item.updatedAt)).toEqual([20]);
    expect((await read({ ...params, tag: 'print' }, store)).items).toEqual([]);
  });

  it('keeps what it knows on any other failure', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    store.remember(qr('a'));
    remove.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await expect(
      new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
        id: 'a',
        domain: 'example.com',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    list.mockResolvedValueOnce(emptyPage());
    expect((await read(params, store)).items.map(item => item.id)).toEqual(['a']);
  });
});

const exists = () =>
  new ApiError(409, 'QR code already exists: promo', undefined, { code: 'QR_ALREADY_EXISTS' });
const stored = () =>
  qr('promo', {
    payload: { url: 'https://example.com/summer' },
    linkedRoute: { domain: 'example.com', path: '/summer' },
  });

describe('a create retried after an uncertain answer (v1.38.0)', () => {
  const sent = {
    type: 'url',
    id: 'promo',
    payload: { url: 'https://example.com/summer' },
    linkedRoute: { domain: 'example.com', path: '/summer' },
  };

  it('takes a 409 QR_ALREADY_EXISTS for its own code as its earlier save, read back', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    create.mockRejectedValueOnce(exists());
    get.mockResolvedValueOnce(stored());
    const created = await new MutationObserver(
      client,
      createQrMutationOptions(client, store),
    ).mutate({ input: sent, domain: 'example.com', afterUncertainAnswer: true });
    expect(created.id).toBe('promo');
    expect(get).toHaveBeenCalledWith('promo', 'example.com');
    // Remembered as any created code is, so stale lists show it
    expect(store.size()).toBe(1);
  });

  it('keeps the 409 when the stored code is not the one sent', async () => {
    const client = new QueryClient();
    create.mockRejectedValueOnce(exists());
    get.mockResolvedValueOnce(qr('promo', { payload: { url: 'https://example.com/other' } }));
    await expect(
      new MutationObserver(client, createQrMutationOptions(client, createPendingQrStore())).mutate({
        input: sent,
        domain: 'example.com',
        afterUncertainAnswer: true,
      }),
    ).rejects.toMatchObject({ code: 'QR_ALREADY_EXISTS' });
  });

  it('never reads back after a certain answer: the 409 stands', async () => {
    const client = new QueryClient();
    create.mockRejectedValueOnce(exists());
    await expect(
      new MutationObserver(client, createQrMutationOptions(client, createPendingQrStore())).mutate({
        input: sent,
        domain: 'example.com',
      }),
    ).rejects.toMatchObject({ code: 'QR_ALREADY_EXISTS' });
    expect(get).not.toHaveBeenCalled();
  });
});

import { type QRCode, QRDesignSchema } from '@bifrost/shared';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
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
      update: vi.fn<typeof api.qr.update>(),
      delete: vi.fn<typeof api.qr.delete>(),
    },
  },
}));

import { api } from '@/lib/api-client';
import { createPendingQrStore } from '@/lib/qr-pending';
import {
  createQrMutationOptions,
  deleteQrMutationOptions,
  fetchQrList,
  qrKeys,
  updateQrMutationOptions,
} from './use-qr-codes';

const list = vi.mocked(api.qr.list);
const create = vi.mocked(api.qr.create);
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('QR list and mutation wiring', () => {
  it('merges a created code into the stale list fetched right after the create', async () => {
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
    expect((await fetchQrList(params, store)).items.map(item => item.id)).toEqual(['fresh']);
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

  it('keeps an updated pending code current, and forgets a deleted one', async () => {
    const client = new QueryClient();
    const store = createPendingQrStore();
    store.remember(qr('a', { description: 'first' }));
    update.mockResolvedValueOnce(qr('a', { description: 'second' }));
    remove.mockResolvedValueOnce(undefined);
    list.mockResolvedValue(emptyPage());

    await new MutationObserver(client, updateQrMutationOptions(client, store)).mutate({
      id: 'a',
      input: { description: 'second' },
      domain: 'example.com',
    });
    expect((await fetchQrList(params, store)).items.map(item => item.description)).toEqual([
      'second',
    ]);

    await new MutationObserver(client, deleteQrMutationOptions(client, store)).mutate({
      id: 'a',
      domain: 'example.com',
    });
    expect(remove).toHaveBeenCalledWith('a', 'example.com');
    expect(store.size()).toBe(0);
    expect((await fetchQrList({ ...params, type: 'url' }, store)).items).toEqual([]);
  });
});

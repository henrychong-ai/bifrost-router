import { describe, it, expect, vi } from 'vitest';
import type { EdgeRouterClient, QRCode } from '@bifrost/shared';
import { createQr, deleteQr, getQr, getRouteQr, listQrs, updateQr } from './qr.js';

const sampleQr: QRCode = {
  id: 'office-wifi',
  domain: 'links.example.com',
  type: 'wifi',
  description: 'Office wifi',
  tags: ['office'],
  payload: { ssid: 'Office', auth: 'WPA', password: 'secret123', hidden: false },
  design: { fg: '#000000', bg: '#ffffff', size: 512, margin: 4, errorCorrection: 'M' },
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  createdBy: 'api-key',
} as QRCode;

function mockClient(overrides: Partial<Record<string, unknown>> = {}): EdgeRouterClient {
  return {
    listQrs: vi.fn().mockResolvedValue({
      items: [sampleQr],
      meta: { total: 1, count: 1, offset: 0, limit: 1, hasMore: false },
    }),
    getQr: vi.fn().mockResolvedValue(sampleQr),
    createQr: vi.fn().mockResolvedValue(sampleQr),
    updateQr: vi.fn().mockResolvedValue(sampleQr),
    deleteQr: vi.fn().mockResolvedValue({ deleted: true, id: 'office-wifi' }),
    getRouteQrSvg: vi.fn().mockResolvedValue('<svg>qr</svg>'),
    ...overrides,
  } as unknown as EdgeRouterClient;
}

describe('QR MCP tool handlers', () => {
  it('listQrs formats the summary rows and meta', async () => {
    const client = mockClient();
    const result = await listQrs(client, { tag: 'office' }, 'links.example.com');

    expect(client.listQrs).toHaveBeenCalledWith(
      expect.objectContaining({ tag: 'office', domain: 'links.example.com' }),
    );
    expect(result).toContain('1 QR code(s)');
    expect(result).toContain('office-wifi (wifi) — Office wifi');
  });

  it('listQrs reports an empty catalogue plainly', async () => {
    const client = mockClient({
      listQrs: vi.fn().mockResolvedValue({
        items: [],
        meta: { total: 0, count: 0, offset: 0, limit: 0, hasMore: false },
      }),
    });
    expect(await listQrs(client, {})).toBe('No QR codes found.');
  });

  it('getQr formats the full record including the payload', async () => {
    const result = await getQr(mockClient(), { id: 'office-wifi' });
    expect(result).toContain('QR: office-wifi (wifi)');
    expect(result).toContain('"ssid":"Office"');
  });

  it('createQr strips domain from the body and passes it as the domain arg', async () => {
    const client = mockClient();
    await createQr(
      client,
      {
        domain: 'secondary.example.net',
        type: 'url',
        payload: { url: 'https://target.example.com' },
      },
      'links.example.com',
    );
    expect(client.createQr).toHaveBeenCalledWith(
      { type: 'url', payload: { url: 'https://target.example.com' } },
      'secondary.example.net',
    );
  });

  it('updateQr maps clearLinkedRoute to an explicit null link', async () => {
    const client = mockClient();
    await updateQr(client, { id: 'office-wifi', clearLinkedRoute: true, description: 'New' });
    expect(client.updateQr).toHaveBeenCalledWith(
      'office-wifi',
      { description: 'New', linkedRoute: null },
      undefined,
    );
  });

  it('deleteQr reports the hard delete', async () => {
    const result = await deleteQr(mockClient(), { id: 'office-wifi' });
    expect(result).toContain('QR code deleted: office-wifi');
  });

  it('getRouteQr returns the SVG source with the ephemeral note', async () => {
    const client = mockClient();
    const result = await getRouteQr(client, { path: '/linkedin', fg: '#112233' });
    expect(client.getRouteQrSvg).toHaveBeenCalledWith('/linkedin', {
      domain: undefined,
      fg: '#112233',
      bg: undefined,
      size: undefined,
    });
    expect(result).toContain('ephemeral');
    expect(result).toContain('<svg>qr</svg>');
  });

  it('surfaces API errors verbatim instead of throwing', async () => {
    const client = mockClient({
      getQr: vi.fn().mockRejectedValue(new Error('QR code not found: nope')),
    });
    expect(await getQr(client, { id: 'nope' })).toBe('Error: QR code not found: nope');
  });
});

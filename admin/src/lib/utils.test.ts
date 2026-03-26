import { describe, test, expect, vi, beforeEach } from 'vitest';
import { formatBytes, cn, copyToClipboard } from './utils';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// =============================================================================
// formatBytes
// =============================================================================

describe('formatBytes', () => {
  test('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  test('formats bytes without decimals', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('formats kilobytes with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10240)).toBe('10.0 KB');
  });

  test('formats megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  test('formats gigabytes with one decimal', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });

  test('formats terabytes with one decimal', () => {
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  test('handles exact power-of-2 boundaries', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});

// =============================================================================
// cn (class name merging)
// =============================================================================

describe('cn', () => {
  test('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  test('handles falsy values', () => {
    expect(cn('base', false, 'active')).toBe('base active');
  });

  test('resolves Tailwind conflicts (last wins)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  test('handles empty input', () => {
    expect(cn()).toBe('');
  });

  test('handles undefined and null values', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar');
  });
});

// =============================================================================
// copyToClipboard
// =============================================================================

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('copies text and shows success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await copyToClipboard('https://example.com/test');
    expect(writeText).toHaveBeenCalledWith('https://example.com/test');
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('Link copied to clipboard');
  });

  test('uses custom label in toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await copyToClipboard('https://example.com', 'URL');
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('URL copied to clipboard');
  });

  test('shows error toast when clipboard fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    await copyToClipboard('https://example.com');
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
  });
});

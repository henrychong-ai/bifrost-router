import { beforeEach, describe, expect, test, vi } from 'vitest';
import { cn, copyToClipboard } from './utils';

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: { success: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() },
}));

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
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await copyToClipboard('https://links.example.com/test');
    expect(writeText).toHaveBeenCalledWith('https://links.example.com/test');
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('Link copied to clipboard');
  });

  test('uses custom label in toast', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await copyToClipboard('https://example.com', 'URL');
    const { toast } = await import('sonner');
    expect(toast.success).toHaveBeenCalledWith('URL copied to clipboard');
  });

  test('shows error toast when clipboard fails', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('Denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    await copyToClipboard('https://example.com');
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
  });
});

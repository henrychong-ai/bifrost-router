export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZE_OPTIONS = [50, 100, 250] as const;
export const PAGE_SIZE_STORAGE_KEY = 'bifrost-page-size';

export function getPersistedPageSize(): number {
  try {
    const saved = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (saved) {
      const size = Number(saved);
      if (PAGE_SIZE_OPTIONS.includes(size as (typeof PAGE_SIZE_OPTIONS)[number])) return size;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PAGE_SIZE;
}

export function persistPageSize(size: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    /* ignore */
  }
}

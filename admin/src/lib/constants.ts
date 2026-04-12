export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZE_OPTIONS = [50, 100, 250] as const;
export const PAGE_SIZE_STORAGE_KEY = 'bifrost-page-size';

export function getPersistedPageSize(): number {
  try {
    const stored = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (stored) {
      const num = Number(stored);
      if ((PAGE_SIZE_OPTIONS as readonly number[]).includes(num)) return num;
    }
  } catch {
    // localStorage not available
  }
  return DEFAULT_PAGE_SIZE;
}

export function persistPageSize(size: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    // localStorage not available
  }
}

/** Maps R2 bucket names to their Cloudflare custom domain. Mirrors src/types.ts. */
export const R2_BUCKET_CUSTOM_DOMAINS: Record<string, string> = {
  // Configure with your R2 custom domain URLs.
  // Example: files: 'files.example.com',
};

/** Build public URL for an R2 object. Returns null if bucket has no custom domain. */
export function getR2ObjectUrl(bucket: string, key: string): string | null {
  const domain = R2_BUCKET_CUSTOM_DOMAINS[bucket];
  if (!domain) return null;
  const encodedPath = key.split('/').map(encodeURIComponent).join('/');
  return `https://${domain}/${encodedPath}`;
}

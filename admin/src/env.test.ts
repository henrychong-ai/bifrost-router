/**
 * The dashboard holds no admin key (v1.39.0): it calls its own origin, where
 * nginx (or the Vite dev server) adds the key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import envSource from './env.ts?raw';

async function loadEnv() {
  vi.resetModules();
  return (await import('./env')).env;
}

describe('env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends every API call to the page origin, whatever the build environment says', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://dashboard.example.com' } });
    vi.stubEnv('VITE_API_URL', 'https://bifrost.example.com');
    vi.stubEnv('VITE_ADMIN_API_KEY', 'build-key');
    expect(await loadEnv()).toEqual({ API_ORIGIN: 'https://dashboard.example.com' });
  });

  it('reads no key and no build-time API URL', () => {
    const code = envSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('window.location.origin');
    expect(code).not.toMatch(/import\.meta\.env|__ENV__|ADMIN_API_KEY|X-Admin-Key/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { IGNORED_ENV_WARNINGS, warnIgnoredEnv } from './boot-warnings.js';

describe('boot warnings for removed environment variables', () => {
  it('warns exactly once when EDGE_ROUTER_DOMAIN is still set', () => {
    const log = vi.fn();

    const warned = warnIgnoredEnv({ EDGE_ROUTER_DOMAIN: 'links.example.com' }, log);

    expect(warned).toEqual(['EDGE_ROUTER_DOMAIN']);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0][0]);
    // Name the variable, say it is ignored, and say what to do instead — an
    // operator reading one stderr line must not have to guess any of the three.
    expect(message).toContain('EDGE_ROUTER_DOMAIN');
    expect(message).toContain('ignored');
    expect(message).toContain('v1.35.0');
    expect(message).toContain('pass domain');
  });

  it('says nothing when the variable is absent or empty', () => {
    const log = vi.fn();

    expect(warnIgnoredEnv({}, log)).toEqual([]);
    expect(warnIgnoredEnv({ EDGE_ROUTER_DOMAIN: undefined }, log)).toEqual([]);
    expect(warnIgnoredEnv({ EDGE_ROUTER_DOMAIN: '' }, log)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('ignores unrelated variables and never throws', () => {
    const log = vi.fn();

    expect(
      warnIgnoredEnv({ EDGE_ROUTER_URL: 'https://bifrost.example.com', PATH: '/usr/bin' }, log),
    ).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('carries one entry today, so a future removal has an obvious home', () => {
    expect(Object.keys(IGNORED_ENV_WARNINGS)).toEqual(['EDGE_ROUTER_DOMAIN']);
  });
});

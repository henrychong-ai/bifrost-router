/**
 * Zod jitless mode (v1.37.0). Zod 4 probes `new Function('')` (its cached
 * `allowsEval`) the first time a schema needs it during module evaluation; the
 * dashboard's CSP (`script-src 'self'` in admin/nginx.conf.template) refuses
 * eval, so every load reported a `script-src` violation even though zod catches
 * the error and falls back. Jitless skips the probe and parses on the same
 * interpreted path. Never answer this with 'unsafe-eval' in the CSP.
 *
 * Must stay the FIRST import in main.tsx: imports evaluate in order, so a config
 * call in main.tsx's body would run after the probe had already fired.
 */
import { z } from 'zod';

z.config({ jitless: true });

/** main.tsx's boot check: false means zod could probe eval again. */
export function isZodJitless(): boolean {
  return z.config().jitless === true;
}

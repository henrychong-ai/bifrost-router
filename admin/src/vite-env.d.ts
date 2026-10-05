/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Worker API (local dev and builds). */
  readonly VITE_API_URL?: string;
  /** Admin key for local dev; production injects it at runtime instead. */
  readonly VITE_ADMIN_API_KEY?: string;
}

/**
 * Version injected at build time from root package.json
 * @see vite.config.ts define.APP_VERSION
 */
declare const __APP_VERSION__: string;

/**
 * The two variables `src/env.ts` reads. Declaring them keeps those reads
 * dotted under `noPropertyAccessFromIndexSignature`: Vite replaces
 * `import.meta.env.VITE_X` statically, while a bracket read makes it inline
 * the whole env object into the bundle.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_ADMIN_API_KEY?: string;
}

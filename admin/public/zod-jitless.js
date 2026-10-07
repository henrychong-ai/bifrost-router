// Zod runs jitless in the dashboard (v1.39.0). Zod 4 probes `new Function`
// when a schema is BUILT, to decide whether to compile object parsers. Under
// the dashboard CSP (`script-src 'self'`, no 'unsafe-eval') the probe files a
// script-src violation on every page load; Zod falls back, so nothing breaks,
// but every load reports. Jitless skips the probe and the compiler.
//
// This is a classic script, loaded before the module entry, because the
// bundle builds schemas (the shared package's among them) in chunks that run
// before any code of the entry module, so `z.config({ jitless: true })` in the
// entry would come too late. Zod keeps its global config on
// `globalThis.__zod_globalConfig` and adopts an object that already exists;
// scripts/check-dashboard-security.test.mjs fails if a Zod upgrade stops
// honouring it. Never answer the violation with 'unsafe-eval' in the policy.
// oxlint-disable-next-line no-underscore-dangle, typescript/no-unsafe-assignment -- Zod's own global-config key, in an untyped classic script
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, {
  jitless: true,
});

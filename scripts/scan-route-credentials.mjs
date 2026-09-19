#!/usr/bin/env node
// Read-only inventory. Inject BIFROST_ADMIN_KEY; never print route targets or responses.
import { writeFileSync } from 'node:fs';
import { findCredentialParams, redactRouteTarget } from '../src/utils/credential-redaction.ts';

const [base, output] = process.argv.slice(2);
const url = new URL(base);
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
  throw new Error('Supply an HTTPS API origin without credentials or a path.');
}
if (!output || !process.env.BIFROST_ADMIN_KEY)
  throw new Error('Output path and injected key required.');
const response = await fetch(new URL('/api/routes', url), {
  headers: { 'X-Admin-Key': process.env.BIFROST_ADMIN_KEY },
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Route inventory returned HTTP ${response.status}.`);
const body = await response.json();
if (!body.success || !Array.isArray(body.data?.routes) || body.data?.meta?.hasMore) {
  throw new Error('Incomplete or invalid route inventory.');
}
const routes = body.data.routes;
const findings = routes.flatMap(route => {
  if (route.type === 'r2' || typeof route.target !== 'string') return [];
  const parameters = findCredentialParams(route.target);
  return parameters.length
    ? [
        {
          domain: route.domain,
          path: redactRouteTarget(route.path),
          type: route.type,
          enabled: route.enabled !== false,
          parameters,
        },
      ]
    : [];
});
writeFileSync(
  output,
  JSON.stringify(
    {
      source: url.origin,
      checkedAt: new Date().toISOString(),
      totalRoutes: routes.length,
      findings,
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
console.log(
  `Reviewed ${routes.length} routes; ${findings.length} flagged. Sanitised report: ${output}`,
);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('OpenAPI is valid YAML and exposes the v1.33 analytics filters', () => {
  const document = parse(readFileSync('openapi/bifrost-api.yaml', 'utf8'));
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(document.openapi, '3.0.3');
  // Derived, never pinned: a hardcoded literal here turns step 5 of the release
  // checklist into a CI failure every single release. Asserting equality with
  // package.json is the property that actually matters.
  assert.equal(document.info.version, version);
  const parameters = document.paths['/api/analytics/summary'].get.parameters.map(
    parameter => parameter.$ref,
  );
  assert.ok(parameters.includes('#/components/parameters/IncludeMonitoringQuery'));
  assert.ok(parameters.includes('#/components/parameters/AnalyticsSearchQuery'));
  assert.ok(parameters.includes('#/components/parameters/CountryQuery'));
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('OpenAPI is valid YAML and exposes the v1.33 analytics filters', () => {
  const document = parse(readFileSync('openapi/bifrost-api.yaml', 'utf8'));
  assert.equal(document.openapi, '3.0.3');
  assert.equal(document.info.version, '1.34.1');
  const parameters = document.paths['/api/analytics/summary'].get.parameters.map(
    parameter => parameter.$ref,
  );
  assert.ok(parameters.includes('#/components/parameters/IncludeMonitoringQuery'));
  assert.ok(parameters.includes('#/components/parameters/AnalyticsSearchQuery'));
  assert.ok(parameters.includes('#/components/parameters/CountryQuery'));
});

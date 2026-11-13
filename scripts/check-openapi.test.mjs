import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('OpenAPI is valid YAML and exposes the v1.33 analytics filters', () => {
  const document = parse(readFileSync('openapi/bifrost-api.yaml', 'utf8'));
  assert.equal(document.openapi, '3.0.3');
  assert.equal(document.info.version, '1.45.0');
  const parameters = document.paths['/api/analytics/summary'].get.parameters.map(
    parameter => parameter.$ref,
  );
  assert.ok(parameters.includes('#/components/parameters/IncludeMonitoringQuery'));
  assert.ok(parameters.includes('#/components/parameters/AnalyticsSearchQuery'));
  assert.ok(parameters.includes('#/components/parameters/CountryQuery'));
});

test('OpenAPI documents the feedback queue order as a lenient string', () => {
  const document = parse(readFileSync('openapi/bifrost-api.yaml', 'utf8'));
  const parameters = document.paths['/api/feedback'].get.parameters.map(
    parameter => parameter.$ref,
  );
  assert.ok(parameters.includes('#/components/parameters/FeedbackSortQuery'));
  const sort = document.components.parameters.FeedbackSortQuery;
  assert.equal(sort.name, 'sort');
  assert.equal(sort.in, 'query');
  // An unrecognised value keeps the default on the Worker, so the spec must
  // not refuse it at the edge.
  assert.deepEqual(sort.schema, { type: 'string' });
  assert.match(sort.description, /`newest`/);
  assert.match(sort.description, /`oldest`/);
});

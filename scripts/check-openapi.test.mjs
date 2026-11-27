import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

test('OpenAPI is valid YAML and exposes the v1.33 analytics filters', () => {
  const document = parse(readFileSync('openapi/bifrost-api.yaml', 'utf8'));
  assert.equal(document.openapi, '3.0.3');
  assert.equal(document.info.version, '1.47.0');
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

test('OpenAPI documents the link-preview fields and the preview-image refusals (v1.48.0)', () => {
  const document = parse(readFileSync('openapi/bifrost-api.yaml', 'utf8'));
  const { schemas } = document.components;
  const previewFields = [
    'previewTitle',
    'previewDescription',
    'previewImageBucket',
    'previewImageKey',
    'previewVideoWidth',
    'previewVideoHeight',
  ];
  for (const name of ['CreateRouteInput', 'UpdateRouteInput']) {
    for (const field of previewFields) {
      assert.ok(schemas[name].properties[field], `${name}.${field}`);
    }
    // The image's pixel size is read from the image, never accepted
    assert.equal(schemas[name].properties.previewImageWidth, undefined);
  }
  assert.equal(schemas.UpdateRouteInput.properties.previewVideoWidth.nullable, true);
  for (const field of [...previewFields, 'previewImageWidth', 'previewImageHeight']) {
    assert.ok(schemas.RouteConfig.properties[field], `RouteConfig.${field}`);
  }
  const byTarget = document.paths['/api/routes/by-target'].get;
  assert.deepEqual(
    byTarget.parameters.filter(parameter => parameter.required).map(parameter => parameter.name),
    ['bucket', 'target'],
  );
  for (const [path, method] of [
    ['/api/storage/{bucket}/upload', 'post'],
    ['/api/storage/{bucket}/objects/{key}', 'delete'],
    ['/api/storage/{bucket}/rename', 'post'],
    ['/api/storage/{bucket}/move', 'post'],
  ]) {
    assert.match(
      document.paths[path][method].responses['409'].description,
      /STORE_PREVIEW_IMAGE_IN_USE/,
      `${method} ${path}`,
    );
  }
  assert.match(
    document.paths['/api/storage/{bucket}/upload'].post.responses['409'].description,
    /STORE_OBJECT_EXISTS/,
  );
});

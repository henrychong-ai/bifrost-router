#!/usr/bin/env node

/**
 * Upload OpenAPI schema to Cloudflare API Shield (Schema Validation).
 *
 * Cloudflare has no in-place update for schemas, so the workflow is:
 *   1. List existing schemas → find all matching by name
 *   2. Delete ALL matching schemas (cleans up duplicates from manual uploads)
 *   3. Create a new schema with the current spec content
 *
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN  - API token with "API Gateway > Edit" zone permission
 *   CLOUDFLARE_ZONE_ID    - Zone ID for API Shield uploads
 *
 * Usage:
 *   node scripts/upload-api-shield.mjs [path-to-spec]
 *   Default spec path: openapi/bifrost-api.yaml
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const SCHEMA_NAME = 'bifrost-api';

const token = process.env.CLOUDFLARE_API_TOKEN;
const zoneId = process.env.CLOUDFLARE_ZONE_ID;

if (!token || !zoneId) {
  console.error('❌ Missing required env vars: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID');
  process.exit(1);
}

const specPath = resolve(process.argv[2] || 'openapi/bifrost-api.yaml');
let specContent;
try {
  specContent = readFileSync(specPath, 'utf-8');
} catch {
  console.error(`❌ Cannot read spec file: ${specPath}`);
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function cfFetch(method, path, body) {
  const url = `${API_BASE}/zones/${zoneId}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) {
    const errors = data.errors?.map(e => e.message).join(', ') || 'Unknown';
    throw new Error(`Cloudflare API error (${method} ${path}): ${errors}`);
  }
  return data;
}

// Step 1: Find existing schemas
console.log('🔍 Looking for existing API Shield schemas...');
const listData = await cfFetch('GET', '/schema_validation/schemas?omit_source=true');
// Response: { result: [ { schema_id, name, kind, ... }, ... ] }
const allSchemas = Array.isArray(listData.result)
  ? listData.result
  : listData.result?.schemas || [];
// Match by name with or without .yaml extension (manual uploads use filename)
const matching = allSchemas.filter(s => s.name === SCHEMA_NAME || s.name === `${SCHEMA_NAME}.yaml`);
console.log(`   Found ${matching.length} matching schema(s) out of ${allSchemas.length} total.`);

// Step 2: Delete ALL matching schemas (cleans up duplicates)
for (const schema of matching) {
  console.log(`🗑️  Deleting "${schema.name}" (${schema.schema_id})...`);
  await cfFetch('DELETE', `/schema_validation/schemas/${schema.schema_id}`);
}
if (matching.length > 0) {
  console.log(`   Deleted ${matching.length} schema(s).`);
}

// Step 3: Upload new schema
console.log(`📤 Uploading new schema from ${specPath}...`);
const createData = await cfFetch('POST', '/schema_validation/schemas', {
  kind: 'openapi_v3',
  name: SCHEMA_NAME,
  source: specContent,
  validation_enabled: true,
});

const result = createData.result;
const newId = result?.schema_id || result?.schema?.schema_id;
console.log(`✅ API Shield schema uploaded successfully (ID: ${newId})`);

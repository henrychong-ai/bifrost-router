import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('credential-redaction.json', root), 'utf8'));
for (const { path, sha256 } of manifest.files) {
  const actual = createHash('sha256')
    .update(readFileSync(new URL(path, root)))
    .digest('hex');
  if (actual !== sha256) throw new Error(`Credential policy ${manifest.version} drift: ${path}`);
}
console.log(`Credential policy ${manifest.version}: all vendored files match.`);

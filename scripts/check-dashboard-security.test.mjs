import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const TEMPLATE = 'admin/nginx.conf.template';
const RENDER = 'admin/scripts/render-nginx-conf.sh';

/** The Content-Security-Policy header value in an nginx config. */
function cspOf(config) {
  const match = /add_header Content-Security-Policy "([^"]+)"/.exec(config);
  assert.ok(match, 'no Content-Security-Policy header');
  return match[1];
}

/**
 * Render the template as the container entrypoint does, with
 * R2_PREVIEW_ORIGINS set to `origins` (undefined leaves it unset).
 */
function render(origins) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bifrost-nginx-'));
  const output = path.join(dir, 'default.conf');
  const env = { ...process.env };
  delete env.R2_PREVIEW_ORIGINS;
  if (origins !== undefined) env.R2_PREVIEW_ORIGINS = origins;
  try {
    const result = spawnSync('sh', [RENDER, TEMPLATE, output], { env, encoding: 'utf8' });
    return {
      status: result.status,
      stderr: result.stderr,
      config: existsSync(output) ? readFileSync(output, 'utf8') : null,
      tmpLeft: existsSync(`${output}.tmp`),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('nginx dashboard template has a static-bundle CSP and baseline browser headers', () => {
  const config = readFileSync(TEMPLATE, 'utf8');
  const csp = cspOf(config);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src __CSP_OBJECT_SRC__;/);
  assert.match(csp, /frame-src __CSP_FRAME_SRC__;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(config, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(config, /unsafe-eval/);
});

/**
 * `config` with comments removed and every quoted string emptied (its quotes
 * kept), so braces and directive names inside a string, such as the JSON body
 * of `return 200 '{"status":"ok"}'`, are not read as config syntax.
 */
function stripCommentsAndStrings(config) {
  let out = '';
  let i = 0;
  while (i < config.length) {
    const char = config[i];
    if (char === '#') {
      while (i < config.length && config[i] !== '\n') i += 1;
    } else if (char === '"' || char === "'") {
      i += 1;
      while (i < config.length && config[i] !== char) i += config[i] === '\\' ? 2 : 1;
      assert.ok(i < config.length, 'unterminated quoted string');
      out += char + char;
      i += 1;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/**
 * The `location` blocks of an nginx config, each with its whole body: braces
 * are matched by depth, so an `if` block (or a nested location) inside one
 * does not end it early.
 */
function locationBlocks(config) {
  const text = stripCommentsAndStrings(config);
  const blocks = [];
  const opener = /\blocation\b[^{;]*\{/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < text.length && depth > 0; end += 1) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}') depth -= 1;
    }
    assert.equal(depth, 0, `unterminated ${match[0].trim()}`);
    blocks.push({ head: match[0].trim(), body: text.slice(start, end - 1) });
  }
  return blocks;
}

/** The heads of the locations that set their own add_header. */
function locationsWithAddHeader(config) {
  return locationBlocks(config)
    .filter(({ body }) => /\badd_header\b/.test(body))
    .map(({ head }) => head);
}

// v1.37.1: a location with its own add_header inherits none of the server's,
// so /assets/, /env-config.js and /health were served without the CSP and the
// other security headers. Per-path headers now come from a map.
test('no nginx location sets its own add_header, so every response keeps the security headers', () => {
  const config = readFileSync(TEMPLATE, 'utf8');
  const locations = locationBlocks(config);
  assert.deepEqual(
    locations.map(({ head }) => head),
    [
      'location /assets/ {',
      'location = /env-config.js {',
      'location /api/tailscale/identity {',
      'location / {',
      'location /health {',
    ],
  );
  assert.deepEqual(locationsWithAddHeader(config), []);
  for (const header of [
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'X-Frame-Options',
    'Strict-Transport-Security',
  ]) {
    assert.match(config, new RegExp(`^    add_header ${header} "[^"]+" always;$`, 'm'), header);
  }
  // Cache-Control per path through the map, at server level
  assert.match(config, /^    add_header Cache-Control \$bifrost_cache_control;$/m);
  assert.match(config, /^\s+~\^\/assets\/\s+"public, immutable";$/m);
  assert.match(config, /^\s+\/env-config\.js\s+"no-store, no-cache, must-revalidate";$/m);
  assert.match(config, /^\s+default\s+"";$/m);
});

// The guard must see a location-level add_header wherever the block puts it:
// after a quoted string holding a closing brace (the original /health bug),
// and after a nested if block. A first-closing-brace scan missed both.
test('the add_header guard sees past quoted braces and nested if blocks', () => {
  const config = readFileSync(TEMPLATE, 'utf8');
  const afterQuotedReturn = config.replace(
    `return 200 '{"status":"ok"}';`,
    `return 200 '{"status":"ok"}';\n        add_header Content-Type application/json;`,
  );
  assert.notEqual(afterQuotedReturn, config, 'the /health return line moved');
  assert.deepEqual(locationsWithAddHeader(afterQuotedReturn), ['location /health {']);

  const ifBlock = /( {8}if \(\$ts_login != ""\) \{\n[^}]*\n {8}\}\n)/;
  assert.match(config, ifBlock, 'the identity if block moved');
  const afterIf = config.replace(ifBlock, '$1        add_header X-Probe "1";\n');
  assert.deepEqual(locationsWithAddHeader(afterIf), ['location /api/tailscale/identity {']);

  // A quoted add_header is a string, not a directive
  const quoted = config.replace(
    `return 200 '{"status":"ok"}';`,
    `return 200 '{"note":"add_header"}';`,
  );
  assert.deepEqual(locationsWithAddHeader(quoted), []);
});

test('without R2_PREVIEW_ORIGINS the CSP keeps object-src none and frame-src self', () => {
  for (const origins of [undefined, '', '  \t ']) {
    const rendered = render(origins);
    assert.equal(rendered.status, 0, rendered.stderr);
    const csp = cspOf(rendered.config);
    assert.match(csp, /object-src 'none';/);
    assert.match(csp, /frame-src 'self';/);
    assert.doesNotMatch(rendered.config, /__CSP_/);
    assert.equal(rendered.tmpLeft, false);
  }
});

test('R2_PREVIEW_ORIGINS adds the R2 origins to object-src and frame-src and nothing else', () => {
  const rendered = render('https://files.example.com   HTTPS://Assets.Example.com:8443/');
  assert.equal(rendered.status, 0, rendered.stderr);
  const origins = 'https://files.example.com https://assets.example.com:8443';
  const template = readFileSync(TEMPLATE, 'utf8');
  assert.equal(
    rendered.config,
    template
      .replaceAll('__CSP_OBJECT_SRC__', origins)
      .replaceAll('__CSP_FRAME_SRC__', `'self' ${origins}`),
  );
  assert.equal(rendered.tmpLeft, false);
});

test('R2_PREVIEW_ORIGINS refuses anything but a bare https origin, writing nothing', () => {
  for (const origins of [
    'http://files.example.com',
    'https://files.example.com/pdfs',
    'https://files.example.com?x=1',
    "https://files.example.com; script-src 'unsafe-inline'",
    'https://files.example.com" always; add_header X-Injected "1',
    'https://files.example.com|x',
    "'unsafe-inline'",
    '*',
    'https://*.example.com',
    'https://localhost',
    'https://files.example.com javascript:alert(1)',
  ]) {
    const rendered = render(origins);
    assert.notEqual(rendered.status, 0, origins);
    assert.match(rendered.stderr, /is not an https origin/, origins);
    assert.equal(rendered.config, null, origins);
    assert.equal(rendered.tmpLeft, false, origins);
  }
});

const WRITE_ENV = 'admin/scripts/write-env-config.sh';

/**
 * Write env-config.js as the container entrypoint does, with ADMIN_API_KEY set
 * to `key` (undefined leaves it unset), and run it the way the page does.
 */
function writeEnvConfig(key) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bifrost-env-'));
  const output = path.join(dir, 'env-config.js');
  const env = { ...process.env };
  delete env.ADMIN_API_KEY;
  if (key !== undefined) env.ADMIN_API_KEY = key;
  try {
    const result = spawnSync('sh', [WRITE_ENV, output], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const source = readFileSync(output, 'utf8');
    const window = {};
    vm.runInNewContext(source, { window });
    // Spread into this realm: deepEqual compares prototypes across vm contexts.
    return { source, env: { ...window.__ENV__ }, tmpLeft: existsSync(`${output}.tmp`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('env-config.js carries ADMIN_API_KEY as a JSON string, whatever it holds', () => {
  for (const key of [
    'plain-key-123',
    'a"b',
    'a\\b\\\\c',
    'ends with a backslash\\',
    '"; alert(1); "',
    '" }; alert(1); //',
    'tab\there, bell\u0007, unit separator\u001f',
    'line1\nline2\n\n',
    '\n',
    'x',
    '$(id) `id` ${HOME}',
    'emoji \u{1F680} and ümläut',
    '',
  ]) {
    const written = writeEnvConfig(key);
    assert.deepEqual(written.env, { ADMIN_API_KEY: key }, JSON.stringify(key));
    // One statement around one JSON string literal: JSON.parse refuses the
    // capture if it holds a raw control character or more than one string.
    const literal = /^window\.__ENV__ = \{ "ADMIN_API_KEY": (".*") \};\n$/s.exec(written.source);
    assert.ok(literal, written.source);
    assert.equal(JSON.parse(literal[1]), key);
    assert.equal(written.tmpLeft, false);
  }
});

test('env-config.js has an empty ADMIN_API_KEY when it is unset', () => {
  assert.deepEqual(writeEnvConfig(undefined).env, { ADMIN_API_KEY: '' });
});

test('both images write env-config.js through the escaping writer only', () => {
  for (const script of ['admin/scripts/start.sh', 'admin/scripts/start-with-tailscale.sh']) {
    const source = readFileSync(script, 'utf8');
    assert.match(
      source,
      /\/usr\/local\/bin\/write-env-config\.sh \/usr\/share\/nginx\/html\/env-config\.js/,
    );
    // No value is interpolated into JavaScript by the start scripts themselves.
    assert.doesNotMatch(source, /window\.__ENV__|\$\{?ADMIN_API_KEY/, script);
  }
  for (const dockerfile of ['admin/Dockerfile', 'admin/Dockerfile.tailscale']) {
    assert.match(
      readFileSync(dockerfile, 'utf8'),
      /COPY (--link )?admin\/scripts\/write-env-config\.sh \/usr\/local\/bin\/write-env-config\.sh/,
      dockerfile,
    );
  }
});

test('a failing encoder stops the writer and leaves the previous env-config.js untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bifrost-env-fail-'));
  const bin = path.join(dir, 'bin');
  const output = path.join(dir, 'env-config.js');
  try {
    // An awk that fails: the encoder's last command
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'awk'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    writeFileSync(output, 'previous\n');
    const result = spawnSync('sh', [WRITE_ENV, output], {
      env: { ...process.env, ADMIN_API_KEY: 'k', PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(output, 'utf8'), 'previous\n');
    assert.equal(existsSync(`${output}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('both images remove the stock nginx site, so only the rendered config can serve', () => {
  for (const dockerfile of ['admin/Dockerfile', 'admin/Dockerfile.tailscale']) {
    assert.match(
      readFileSync(dockerfile, 'utf8'),
      /^RUN rm -f \/etc\/nginx\/conf\.d\/default\.conf$/m,
      dockerfile,
    );
  }
});

test('credential env files never enter the Docker build context', () => {
  const rules = readFileSync('.dockerignore', 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  for (const rule of [
    '**/.env',
    '**/.env.*',
    '!**/.env.example',
    '**/.dev.vars',
    'admin/auth.env',
    'admin/tailscale/',
  ]) {
    assert.ok(rules.includes(rule), `.dockerignore lacks ${rule}`);
  }
  // The negation must follow the exclusion it re-includes from
  assert.ok(rules.indexOf('!**/.env.example') > rules.indexOf('**/.env.*'));
});

test('the compose files publish the dashboard on loopback only', () => {
  for (const file of ['admin/docker-compose.yml', 'admin/docker-compose.prod.yml']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /- "127\.0\.0\.1:3001:3001"/, file);
    assert.doesNotMatch(source, /- "3001:3001"/, file);
  }
});

test('git ignores operator credential files and the Tailscale state', () => {
  // git itself answers, so the test follows .gitignore semantics exactly
  const paths = [
    'admin/auth.env',
    'auth.env',
    'admin/tailscale/tailscaled.state',
    'admin/.env.local',
    '.env.local',
    'admin/.env.production',
    '.dev.vars',
    '.dev.vars.staging',
  ];
  const result = spawnSync('git', ['check-ignore', '--no-index', ...paths], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), paths);

  // The examples stay tracked: check-ignore names none of them (exit 1)
  const examples = ['admin/.env.example', '.env.example', '.dev.vars.example'];
  const kept = spawnSync('git', ['check-ignore', '--no-index', ...examples], { encoding: 'utf8' });
  assert.equal(kept.status, 1, kept.stdout);
  // And the tracked example is still in the index
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'admin/.env.example'], {
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
});

test('the dashboard reads VITE_ADMIN_API_KEY only in development', () => {
  const source = readFileSync('admin/src/env.ts', 'utf8');
  // Every read of the build-time key sits behind import.meta.env.DEV
  const reads = source.match(/import\.meta\.env\.VITE_ADMIN_API_KEY/g) ?? [];
  assert.equal(reads.length, 1);
  assert.match(
    source,
    /window\.__ENV__\?\.ADMIN_API_KEY \?\?\s*\(import\.meta\.env\.DEV \? import\.meta\.env\.VITE_ADMIN_API_KEY : undefined\)/,
  );
});

test('a production build inlines no VITE_ADMIN_API_KEY', () => {
  // The key arrives through the process environment, which Vite reads with
  // the highest precedence, so no admin/.env.local is written or needed. The
  // API URL is the control: it must be inlined, proving the variables reached
  // the build.
  const dir = mkdtempSync(path.join(tmpdir(), 'bifrost-dist-'));
  const key = `synthetic-admin-key-${process.pid}-q7z`;
  const apiUrl = `https://api-${process.pid}.example.com`;
  try {
    const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], {
      cwd: 'admin',
      env: { ...process.env, VITE_ADMIN_API_KEY: key, VITE_API_URL: apiUrl },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const bundle = readdirSync(dir, { recursive: true })
      .map(file => path.join(dir, String(file)))
      .filter(file => statSync(file).isFile())
      .map(file => readFileSync(file, 'utf8'))
      .join('\n');
    assert.ok(bundle.includes(apiUrl), 'control: VITE_API_URL was not inlined');
    assert.equal(bundle.includes(key), false, 'VITE_ADMIN_API_KEY reached the production bundle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('request logs do not persist configured route targets', () => {
  const worker = readFileSync('src/index.ts', 'utf8');
  assert.doesNotMatch(worker, /target:\s*route\.target/);
});

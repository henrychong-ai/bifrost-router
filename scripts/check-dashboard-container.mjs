#!/usr/bin/env node
/**
 * Dashboard container acceptance check (v1.39.0). Needs Docker and openssl;
 * not part of `pnpm run check` (it builds the images and pulls base images).
 * Run it after changing a dashboard image, the nginx template or its
 * renderer: `pnpm run check:dashboard-container`.
 *
 * It builds admin/Dockerfile, starts it on a private Docker network beside a
 * stand-in Worker (a small HTTPS echo server with a certificate from a
 * throwaway CA), and checks on the wire what scripts/check-dashboard-security
 * .test.mjs checks in the config: the security headers once per response, the
 * /api proxy adding the key and replacing a client's, cross-site and
 * bad-path refusals (bare /api and a raw `#` among them) that never reach the
 * Worker, client Tailscale identity headers ignored, stored files sent as
 * attachments under the data policy, the upload limit, a large download
 * that never spools to disk, a metadata-only access log, /health for any
 * Host, a missing asset not cached, the rate-limited report receiver,
 * upstream certificate verification (a wrong name and a self-signed
 * certificate both fail), unknown Host names refused, and a container that
 * refuses to start without its key. It then builds admin/Dockerfile.tailscale
 * and runs its nginx exactly as the start script prepares it, without
 * tailscaled (which needs a tailnet): a Unix socket in a root-only directory
 * and no TCP port, Serve's identity and X-Forwarded-Host trusted, and the
 * per-viewer and whole-receiver CSP limits. Only synthetic values are used.
 * Everything it creates is removed at the end, pass or fail.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ID = `bifrost-check-${process.pid}`;
const IMAGE = `${ID}:dashboard`;
const TAILSCALE_IMAGE = `${ID}:dashboard-tailscale`;
/** The Unix socket nginx listens on in the :tailscale image. */
const SOCKET = '/run/bifrost/nginx.sock';
/** Distinctive values that must never reach a log line. */
const LOG_MARKERS = ['query-marker-7Kq', 'referer-marker-7Kq', 'forwarded-marker-7Kq'];
/** The size of the no-spool download check: well past nginx's memory buffers. */
const BIG_DOWNLOAD_BYTES = 48 * 1024 * 1024;
const NETWORK = `${ID}-net`;
const KEY = `synthetic-admin-key-${process.pid}-Zq7`;
const DASHBOARD_HOST = 'dashboard.example.com';
const API_HOST = 'bifrost-api.example.com';
const WRONG_NAME_HOST = 'wrong-name-api.example.com';
const SELF_SIGNED_HOST = 'selfsigned-api.example.com';
const API_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";
/**
 * The one Cache-Control a hashed asset must carry: the template's
 * `$bifrost_cache_control` value for /assets/ (check-dashboard-security
 * .test.mjs fails when the two differ, so a template change cannot leave this
 * check expecting an old value).
 */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const SECURITY_HEADERS = [
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'x-frame-options',
  'permissions-policy',
];

const work = mkdtempSync(path.join(tmpdir(), `${ID}-`));
const containers = new Set();
let networkCreated = false;
const imagesBuilt = new Set();
const failures = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr}`);
  }
  return result;
}

const docker = (args, options) => run('docker', args, options);

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ok    ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
    failures.push(label);
  }
}

function cleanup() {
  for (const name of containers) docker(['rm', '-f', name], { check: false });
  containers.clear();
  if (networkCreated) docker(['network', 'rm', NETWORK], { check: false });
  networkCreated = false;
  for (const image of imagesBuilt) docker(['rmi', '-f', image], { check: false });
  imagesBuilt.clear();
  rmSync(work, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------
// Certificates: a throwaway CA, a certificate for the stand-in Worker, and a
// self-signed one nothing trusts
// ---------------------------------------------------------------------------

const file = name => path.join(work, name);
const openssl = args => run('openssl', args, { cwd: work });

function certificates() {
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Bifrost check CA',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.crt'),
  ]);
  const leaf = (name, host, signer) => {
    writeFileSync(
      file(`${name}.cnf`),
      `[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    );
    openssl([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${host}`,
      '-keyout',
      file(`${name}.key`),
      '-out',
      file(`${name}.csr`),
      '-config',
      file(`${name}.cnf`),
    ]);
    const sign =
      signer === 'self'
        ? ['-signkey', file(`${name}.key`)]
        : ['-CA', file('ca.crt'), '-CAkey', file('ca.key'), '-CAcreateserial'];
    openssl([
      'x509',
      '-req',
      '-days',
      '1',
      '-in',
      file(`${name}.csr`),
      ...sign,
      '-extfile',
      file(`${name}.cnf`),
      '-extensions',
      'ext',
      '-out',
      file(`${name}.crt`),
    ]);
  };
  leaf('api', API_HOST, 'ca');
  leaf('selfsigned', SELF_SIGNED_HOST, 'self');
}

// ---------------------------------------------------------------------------
// The stand-in Worker: echoes what it received, serves a stored HTML object,
// counts the requests that reach it
// ---------------------------------------------------------------------------

const ECHO_SERVER = `
const https = require('node:https');
const fs = require('node:fs');
let count = 0;
const server = https.createServer(
  { key: fs.readFileSync(process.env.KEY_FILE), cert: fs.readFileSync(process.env.CERT_FILE) },
  (req, res) => {
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
      if (req.url === '/api/__count') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ count }));
        return;
      }
      count += 1;
      const copies = {
        'content-security-policy': "default-src *",
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'strict-transport-security': 'max-age=1',
      };
      if (req.url.startsWith('/api/storage/files/objects/page.html')) {
        res.writeHead(200, { ...copies, 'content-type': 'text/html', 'content-disposition': 'inline' });
        res.end('<script>document.title = "ran"</script>');
        return;
      }
      if (req.url === '/api/storage/files/objects/big.bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(${BIG_DOWNLOAD_BYTES}) });
        const chunk = Buffer.alloc(1024 * 1024, 120);
        let left = ${BIG_DOWNLOAD_BYTES};
        const pump = () => {
          while (left > 0) {
            left -= chunk.length;
            if (!res.write(chunk)) return res.once('drain', pump);
          }
          res.end();
        };
        pump();
        return;
      }
      if (req.url === '/api/json-with-disposition') {
        res.writeHead(200, { ...copies, 'content-type': 'application/json', 'content-disposition': 'inline; filename="x.json"' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { ...copies, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.rawHeaders, bytes }));
    });
  },
);
server.listen(443);
`;

function startUpstream(name, alias, certName, extraAliases = []) {
  writeFileSync(path.join(work, 'echo.cjs'), ECHO_SERVER);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    NETWORK,
    ...[alias, ...extraAliases].flatMap(host => ['--network-alias', host]),
    '-v',
    `${work}:/work:ro`,
    '-e',
    `KEY_FILE=/work/${certName}.key`,
    '-e',
    `CERT_FILE=/work/${certName}.crt`,
    'node:24-alpine',
    'node',
    '/work/echo.cjs',
  ]);
  containers.add(name);
}

// ---------------------------------------------------------------------------
// Dashboard containers
// ---------------------------------------------------------------------------

/** Start a dashboard container; resolves its published host port, or null if it exited. */
async function startDashboard(name, env) {
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    NETWORK,
    '-p',
    '127.0.0.1::3001',
    '-v',
    `${path.join(work, 'ca-bundle.crt')}:/etc/ssl/certs/ca-certificates.crt:ro`,
  ];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  docker([...args, IMAGE]);
  containers.add(name);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = docker([
      'inspect',
      '-f',
      '{{.State.Running}} {{.State.ExitCode}}',
      name,
    ]).stdout.trim();
    if (state.startsWith('false')) return null;
    const port = docker(['port', name, '3001/tcp'], { check: false })
      .stdout.trim()
      .split(':')
      .pop();
    if (port) {
      const health = await request(Number(port), { path: '/health' }).catch(() => null);
      if (health?.status === 200) return Number(port);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `${name} did not become healthy:\n${docker(['logs', name], { check: false }).stderr}`,
  );
}

/** One HTTP request to a dashboard: status, raw headers (lower-cased name -> values), body. */
function request(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: target,
        headers: { host: `localhost:${port}`, ...headers },
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const all = new Map();
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = res.rawHeaders[i].toLowerCase();
            all.set(name, [...(all.get(name) ?? []), res.rawHeaders[i + 1]]);
          }
          resolve({
            status: res.statusCode,
            headers: all,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * One request written byte for byte on a raw socket, so a target a client
 * library would reject or rewrite (a raw `#`, `|`, `"`) reaches nginx as it
 * is. Resolves the status code, or the error code when nginx drops it.
 */
function rawRequest(port, target, headers) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('latin1');
    socket.on('data', chunk => {
      data += chunk;
    });
    socket.on('error', error => resolve(error.code ?? 'error'));
    socket.on('close', () => resolve(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 'closed'));
    const lines = Object.entries({ ...headers, connection: 'close' }).map(
      ([name, value]) => `${name}: ${value}`,
    );
    socket.end(Buffer.from(`GET ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`, 'latin1'));
  });
}

/**
 * Download `path` reading slowly: the client stops reading after the first
 * chunk for `pauseMs`, which makes nginx hold what the Worker keeps sending
 * (in a temporary file, which nginx logs, unless proxy_max_temp_file_size
 * is 0), then reads the rest. Resolves the status and byte count.
 */
function slowDownload(port, target, headers, pauseMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: target, headers },
      res => {
        let bytes = 0;
        let paused = false;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (!paused) {
            paused = true;
            res.pause();
            setTimeout(() => res.resume(), pauseMs);
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, bytes }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * One request to the :tailscale image's nginx over its Unix socket, from
 * inside the container (curl, as Tailscale Serve would connect). Resolves the
 * status, headers (lower-cased name -> values) and body.
 */
function socketRequest(container, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  const args = ['exec', '-i', container, 'curl', '-s', '-i', '--unix-socket', SOCKET, '-X', method];
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`);
  if (body !== undefined) args.push('--data-binary', '@-');
  args.push(`http://localhost${target}`);
  const result = docker(args, { check: false, input: body ?? '' });
  const [head = '', ...rest] = result.stdout.split('\r\n\r\n');
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const all = new Map();
  for (const line of headerLines) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).toLowerCase();
    all.set(name, [...(all.get(name) ?? []), line.slice(at + 1).trim()]);
  }
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1] ?? 0),
    headers: all,
    body: rest.join('\r\n\r\n'),
  };
}

/** The request headers the stand-in Worker received, from an echo answer. */
function received(answer) {
  const echoed = JSON.parse(answer.body || '{}');
  const sent = new Map();
  for (let i = 0; i < (echoed.headers ?? []).length; i += 2) {
    const name = echoed.headers[i].toLowerCase();
    sent.set(name, [...(sent.get(name) ?? []), echoed.headers[i + 1]]);
  }
  return { url: echoed.url, sent };
}

const ownHeaders = (extra = {}) => ({
  host: DASHBOARD_HOST,
  'x-bifrost-dashboard': '1',
  'sec-fetch-site': 'same-origin',
  ...extra,
});

const one = (response, name) => response.headers.get(name) ?? [];

async function upstreamCount(port) {
  const answer = await request(port, { path: '/api/__count', headers: ownHeaders() });
  return JSON.parse(answer.body).count;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function main() {
  if (docker(['version'], { check: false }).status !== 0) {
    console.error('check-dashboard-container: Docker is not available');
    process.exitCode = 2;
    return;
  }
  console.log('Building the dashboard image (admin/Dockerfile)...');
  docker(['build', '-q', '-f', 'admin/Dockerfile', '-t', IMAGE, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  imagesBuilt.add(IMAGE);

  certificates();
  // The image's own CA bundle plus the throwaway CA (test only)
  const bundle = docker([
    'run',
    '--rm',
    '--entrypoint',
    'cat',
    IMAGE,
    '/etc/ssl/certs/ca-certificates.crt',
  ]).stdout;
  check('the image carries a CA bundle', bundle.includes('BEGIN CERTIFICATE'));
  writeFileSync(
    path.join(work, 'ca-bundle.crt'),
    bundle + readFileSync(path.join(work, 'ca.crt'), 'utf8'),
  );

  docker(['network', 'create', NETWORK]);
  networkCreated = true;
  startUpstream(`${ID}-api`, API_HOST, 'api', [WRONG_NAME_HOST]);
  startUpstream(`${ID}-selfsigned`, SELF_SIGNED_HOST, 'selfsigned');

  const base = {
    API_PROXY_ORIGIN: `https://${API_HOST}`,
    ADMIN_API_KEY: KEY,
    API_PROXY_RESOLVER: '127.0.0.11',
    DASHBOARD_HOSTNAMES: DASHBOARD_HOST,
  };
  const dashboard = `${ID}-dashboard`;
  const port = await startDashboard(dashboard, {
    ...base,
    CSP_REPORT_ORIGIN: `https://${DASHBOARD_HOST}`,
  });
  check('the dashboard starts with the required inputs', port !== null);
  if (port === null) return;

  console.log('Security headers');
  for (const target of ['/', '/health', '/zod-jitless.js', '/routes']) {
    const answer = await request(port, { path: target, headers: { host: DASHBOARD_HOST } });
    check(`${target} answers 200`, answer.status === 200, String(answer.status));
    const csp = one(answer, 'content-security-policy');
    check(
      `${target} carries one page policy`,
      csp.length === 1 &&
        csp[0].includes("script-src 'self'") &&
        csp[0].includes("connect-src 'self';"),
      JSON.stringify(csp),
    );
    check(
      `${target} reports to the dashboard origin`,
      csp[0]?.endsWith('; report-uri /csp-report; report-to csp-report') &&
        one(answer, 'reporting-endpoints')[0] ===
          `csp-report="https://${DASHBOARD_HOST}/csp-report"`,
    );
    for (const name of SECURITY_HEADERS)
      check(`${target} ${name} once`, one(answer, name).length === 1);
    check(`${target} no Content-Disposition`, one(answer, 'content-disposition').length === 0);
  }
  const html = await request(port, { path: '/', headers: { host: DASHBOARD_HOST } });
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html.body)?.[1];
  check('the page loads its module from /assets/', asset !== undefined);
  if (asset) {
    const answer = await request(port, { path: asset, headers: { host: DASHBOARD_HOST } });
    check(
      'an asset has exactly one Cache-Control, immutable, and no Expires',
      JSON.stringify(one(answer, 'cache-control')) === JSON.stringify([ASSET_CACHE_CONTROL]) &&
        one(answer, 'expires').length === 0,
      JSON.stringify([one(answer, 'cache-control'), one(answer, 'expires')]),
    );
    check('the bundle holds no admin key', !answer.body.includes(KEY));
  }

  console.log('Host names');
  const rebound = await request(port, { path: '/', headers: { host: 'evil.example' } }).then(
    answer => `answered ${answer.status}`,
    error => error.code ?? 'closed',
  );
  check(
    'an unknown Host gets no answer (444)',
    rebound === 'ECONNRESET' || rebound === 'closed',
    rebound,
  );
  const local = await request(port, { path: '/health' });
  check('localhost is answered', local.status === 200);
  // A load balancer or Kubernetes probe names the container by its address
  const probe = await request(port, { path: '/health', headers: { host: '10.0.0.5' } });
  check(
    '/health is answered for an IP Host (a probe), with no key or proxy',
    probe.status === 200 && probe.body === '{"status":"ok"}',
    `${probe.status} ${probe.body}`,
  );
  for (const target of ['/', '/routes', '/api/echo']) {
    const dropped = await request(port, {
      path: target,
      headers: ownHeaders({ host: '10.0.0.5' }),
    }).then(
      answer => `answered ${answer.status}`,
      error => error.code ?? 'closed',
    );
    check(
      `${target} for an IP Host gets no answer (444)`,
      dropped === 'ECONNRESET' || dropped === 'closed',
      dropped,
    );
  }

  console.log('The /api proxy');
  const before = await upstreamCount(port);
  const echoTarget = `/api/echo?${LOG_MARKERS[0]}=1`;
  const echo = await request(port, {
    method: 'POST',
    path: echoTarget,
    headers: ownHeaders({
      origin: `https://${DASHBOARD_HOST}`,
      'content-type': 'application/json',
      'x-admin-key': 'client-supplied-key',
      referer: `https://${DASHBOARD_HOST}/routes?${LOG_MARKERS[1]}=1`,
      'x-forwarded-for': LOG_MARKERS[2],
      // Identity headers a client sends past a front door that is not
      // Tailscale Serve: never trusted, never forwarded
      'tailscale-user-login': 'forged@example.com',
      'tailscale-user-name': 'Forged Name',
      'tailscale-user-profile-pic': 'https://example.com/forged.png',
    }),
    body: '{}',
  });
  check('the dashboard’s own call is proxied', echo.status === 200, `${echo.status} ${echo.body}`);
  const { url: echoedUrl, sent } = received(echo);
  check(
    'the Worker gets the container key, once, never the client’s',
    JSON.stringify(sent.get('x-admin-key')) === JSON.stringify([KEY]),
  );
  check(
    'the Worker gets its own Host',
    JSON.stringify(sent.get('host')) === JSON.stringify([API_HOST]),
  );
  check(
    'the Worker gets no client-sent Tailscale identity',
    !['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic'].some(name =>
      sent.has(name),
    ),
    JSON.stringify([...sent.keys()]),
  );
  // v1.40.0: the shared internal-header rule; nginx drops the dashboard's
  // own request header too, as the dev proxy and the Worker do
  check(
    'the Worker gets no X-Bifrost-* header',
    ![...sent.keys()].some(name => name.startsWith('x-bifrost-')),
    JSON.stringify([...sent.keys()]),
  );
  check('the raw request URI is forwarded', echoedUrl === echoTarget);
  check(
    'a proxied answer carries the data policy only',
    JSON.stringify(one(echo, 'content-security-policy')) === JSON.stringify([API_POLICY]),
  );
  for (const name of SECURITY_HEADERS)
    check(
      `a proxied answer has one ${name}`,
      one(echo, name).length === 1,
      JSON.stringify(one(echo, name)),
    );
  check('a JSON answer gets no Content-Disposition', one(echo, 'content-disposition').length === 0);
  const afterOwn = await upstreamCount(port);
  check(
    'exactly one request reached the Worker',
    afterOwn === before + 1,
    `${before} -> ${afterOwn}`,
  );

  const refused = [
    ['a GET without the dashboard header', { headers: { host: DASHBOARD_HOST } }],
    [
      'a text/plain POST from another site',
      {
        method: 'POST',
        headers: {
          host: DASHBOARD_HOST,
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
          'content-type': 'text/plain',
        },
        body: '{"path":"/x"}',
      },
    ],
    [
      'a form POST from another site',
      {
        method: 'POST',
        headers: {
          host: DASHBOARD_HOST,
          origin: 'https://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'a=1',
      },
    ],
    [
      'a multipart POST from another site',
      {
        method: 'POST',
        headers: {
          host: DASHBOARD_HOST,
          origin: 'https://evil.example',
          'content-type': 'multipart/form-data; boundary=x',
        },
        body: '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n',
      },
    ],
    [
      'a cross-site GET with the header',
      { headers: ownHeaders({ 'sec-fetch-site': 'cross-site' }) },
    ],
    ['a navigation (Sec-Fetch-Site: none)', { headers: ownHeaders({ 'sec-fetch-site': 'none' }) }],
    [
      'an Origin of another host',
      { method: 'POST', headers: ownHeaders({ origin: 'https://evil.example' }), body: '{}' },
    ],
    ['an Origin of null', { method: 'POST', headers: ownHeaders({ origin: 'null' }), body: '{}' }],
    [
      'a CORS preflight',
      {
        method: 'OPTIONS',
        headers: {
          host: DASHBOARD_HOST,
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-bifrost-dashboard',
        },
      },
    ],
  ];
  for (const [label, options] of refused) {
    const answer = await request(port, { path: '/api/echo', ...options });
    check(
      `${label} is refused 403`,
      answer.status === 403 && answer.body.includes('CROSS_SITE_REQUEST'),
      `${answer.status}`,
    );
  }
  for (const target of [
    '/x/..%2Fapi/echo',
    '//api/echo',
    '/api/echo%2F..%2Fother',
    '/api/a%2Eb',
    '/api/a%5Cb',
    '/api//echo',
  ]) {
    const answer = await request(port, { path: target, headers: ownHeaders() });
    check(
      `${target} is refused 400`,
      answer.status === 400 && answer.body.includes('BAD_API_PATH'),
      `${answer.status}`,
    );
  }
  // Written on a raw socket: a client library would refuse or encode these
  for (const target of [
    '/api/echo#/../../other',
    '/api/echo?x=1#/../../other',
    '/api/a|b',
    '/api/a"b',
    '/api/a^b',
    '/api/echo?q=a|b',
    '/api/a\u00e9b',
  ]) {
    const status = await rawRequest(port, target, ownHeaders());
    check(`${JSON.stringify(target)} (raw) is refused 400`, status === '400', status);
  }
  // Bare /api is not the API: the dashboard serves its page, adds no key and
  // proxies nothing (the Worker would serve it as an ordinary route)
  for (const target of ['/api', '/api?x=1']) {
    const answer = await request(port, { path: target, headers: ownHeaders() });
    check(
      `${target} is the dashboard page, not proxied`,
      answer.status === 200 &&
        (one(answer, 'content-type')[0] ?? '').startsWith('text/html') &&
        one(answer, 'content-security-policy')[0]?.includes("script-src 'self'") === true,
      `${answer.status} ${JSON.stringify(one(answer, 'content-type'))}`,
    );
  }
  const afterRefusals = await upstreamCount(port);
  check(
    'no refused request reached the Worker',
    afterRefusals === afterOwn,
    `${afterOwn} -> ${afterRefusals}`,
  );

  const identity = await request(port, {
    path: '/api/tailscale/identity',
    headers: { host: DASHBOARD_HOST, 'tailscale-user-login': 'forged@example.com' },
  });
  check(
    'the identity endpoint is answered locally and ignores a client’s Tailscale header',
    identity.status === 200 &&
      JSON.parse(identity.body).isAuthenticated === false &&
      JSON.parse(identity.body).login === '',
    identity.body,
  );
  check('the identity endpoint is not proxied', (await upstreamCount(port)) === afterRefusals);

  console.log('Stored files');
  const stored = await request(port, {
    path: '/api/storage/files/objects/page.html',
    headers: ownHeaders(),
  });
  check(
    'a stored HTML object is an attachment',
    JSON.stringify(one(stored, 'content-disposition')) === '["attachment"]',
    JSON.stringify(one(stored, 'content-disposition')),
  );
  check(
    'a stored HTML object gets the sandboxed data policy',
    JSON.stringify(one(stored, 'content-security-policy')) === JSON.stringify([API_POLICY]),
  );
  check(
    'a stored HTML object is nosniff',
    JSON.stringify(one(stored, 'x-content-type-options')) === '["nosniff"]',
  );
  const jsonDisposition = await request(port, {
    path: '/api/json-with-disposition',
    headers: ownHeaders(),
  });
  check(
    'a JSON answer keeps the Worker’s Content-Disposition',
    JSON.stringify(one(jsonDisposition, 'content-disposition')) ===
      '["inline; filename=\\"x.json\\""]',
    JSON.stringify(one(jsonDisposition, 'content-disposition')),
  );

  // A large download streams through: nginx holds no more than its memory
  // buffers while the client is slow, never a temporary file (checked in the
  // log below: nginx warns "buffered to a temporary file" when it spools)
  const download = await slowDownload(
    port,
    '/api/storage/files/objects/big.bin',
    ownHeaders(),
    1500,
  );
  check(
    'a large download read slowly arrives whole',
    download.status === 200 && download.bytes === BIG_DOWNLOAD_BYTES,
    `${download.status} ${download.bytes}`,
  );

  console.log('Uploads');
  const upload = await request(port, {
    method: 'POST',
    path: '/api/upload',
    headers: ownHeaders({ 'content-type': 'application/octet-stream' }),
    body: Buffer.alloc(5 * 1024 * 1024),
  });
  check(
    'a 5 MiB upload reaches the Worker',
    upload.status === 200 && JSON.parse(upload.body).bytes === 5 * 1024 * 1024,
    `${upload.status}`,
  );
  const tooLarge = await request(port, {
    method: 'POST',
    path: '/api/upload',
    headers: ownHeaders({ 'content-type': 'application/octet-stream' }),
    body: Buffer.alloc(102 * 1024 * 1024),
  });
  check('a body over 101 MiB is refused 413', tooLarge.status === 413, `${tooLarge.status}`);

  console.log('Assets');
  const missing = await request(port, {
    path: '/assets/missing-chunk-abc123.js',
    headers: { host: DASHBOARD_HOST },
  });
  check(
    'a missing asset is a 404 that is not cached',
    missing.status === 404 && one(missing, 'cache-control').length === 0,
    `${missing.status} ${JSON.stringify(one(missing, 'cache-control'))}`,
  );

  console.log('CSP report receiver');
  const report = (login, method = 'POST') =>
    request(port, {
      method,
      path: '/csp-report',
      headers: {
        host: DASHBOARD_HOST,
        'content-type': 'application/reports+json',
        ...(login ? { 'tailscale-user-login': login } : {}),
      },
      body: method === 'POST' ? '[]' : undefined,
    });
  check('a GET is refused 405', (await report(undefined, 'GET')).status === 405);
  // Without Tailscale Serve every viewer is its address, whatever identity
  // header it sends (the per-viewer and whole-receiver limits by identity are
  // checked behind Serve, below)
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, i) => report(`viewer-${i}@example.com`)),
  );
  const codes = burst.map(answer => answer.status);
  check(
    'a burst from one address is limited (204 then 429), whatever identity it claims',
    codes.includes(204) && codes.includes(429) && codes.every(code => code === 204 || code === 429),
    JSON.stringify(codes),
  );
  await new Promise(resolve => setTimeout(resolve, 300));
  const logs = docker(['logs', dashboard], { check: false });
  const logText = `${logs.stdout}\n${logs.stderr}`;
  check('a refused report is logged with its 429', /"status":429/.test(logText));
  // limit_req logs at info, below the error log's level: the access line is the record
  check(
    'limit_req writes no error line naming the client or Referer',
    !/limiting requests/.test(logText),
  );

  console.log('Access log');
  const accessLines = logText
    .split('\n')
    .filter(line => line.startsWith('{') && line.includes('"scope"'))
    .map(line => JSON.parse(line));
  check('requests are logged', accessLines.length > 20, String(accessLines.length));
  check(
    'every access line is metadata only',
    accessLines.every(
      line =>
        JSON.stringify(Object.keys(line)) ===
        JSON.stringify([
          'time',
          'method',
          'scope',
          'status',
          'bytes_sent',
          'request_time',
          'upstream_time',
        ]),
    ),
  );
  check(
    'no log line carries a query, a Referer or a forwarded address',
    LOG_MARKERS.every(marker => !logText.includes(marker)),
  );
  check(
    'nginx’s stock request-line format is never used',
    !/\] "[A-Z]+ \/[^"]*" \d{3} \d+ "/.test(logText),
  );
  check(
    'the slow large download was never buffered to a temporary file',
    !logText.includes('buffered to a temporary file'),
  );

  console.log('The key stays on the server');
  check('no log line carries the key', !logText.includes(KEY));
  check(
    'the key include is root-only',
    docker([
      'exec',
      dashboard,
      'stat',
      '-c',
      '%a %U',
      '/etc/nginx/bifrost/admin-key.conf',
    ]).stdout.trim() === '600 root',
  );
  check(
    'the served config does not hold the key',
    !docker(['exec', dashboard, 'cat', '/etc/nginx/conf.d/default.conf']).stdout.includes(KEY),
  );
  check(
    'no served file holds the key',
    docker(['exec', dashboard, 'grep', '-rl', KEY, '/usr/share/nginx/html'], { check: false })
      .status === 1,
  );

  console.log('Upstream certificate verification');
  for (const [label, host] of [
    ['a certificate for another name', WRONG_NAME_HOST],
    ['a self-signed certificate', SELF_SIGNED_HOST],
  ]) {
    const name = `${ID}-${host.split('.')[0]}`;
    const other = await startDashboard(name, { ...base, API_PROXY_ORIGIN: `https://${host}` });
    const answer =
      other === null ? null : await request(other, { path: '/api/echo', headers: ownHeaders() });
    check(`${label} is refused (502)`, answer?.status === 502, String(answer?.status));
  }

  console.log('Report-only, no reporting');
  const quiet = await startDashboard(`${ID}-report-only`, { ...base, CSP_MODE: 'report-only' });
  if (quiet !== null) {
    const page = await request(quiet, { path: '/', headers: { host: DASHBOARD_HOST } });
    check(
      'the page policy is report-only',
      one(page, 'content-security-policy-report-only').length === 1 &&
        one(page, 'content-security-policy').length === 0,
    );
    check(
      'no report directives and no Reporting-Endpoints',
      !one(page, 'content-security-policy-report-only')[0].includes('report-') &&
        one(page, 'reporting-endpoints').length === 0,
    );
    const receiver = await request(quiet, {
      method: 'POST',
      path: '/csp-report',
      headers: { host: DASHBOARD_HOST, 'content-type': 'application/reports+json' },
      body: '[]',
    });
    check('the report receiver is off (404)', receiver.status === 404, `${receiver.status}`);
    const api = await request(quiet, { path: '/api/echo', headers: ownHeaders() });
    check(
      '/api keeps the enforced data policy',
      JSON.stringify(one(api, 'content-security-policy')) === JSON.stringify([API_POLICY]) &&
        one(api, 'content-security-policy-report-only').length === 0,
    );
  } else {
    check('the report-only dashboard starts', false);
  }

  console.log('Refusing to start');
  for (const [label, env, message] of [
    ['without ADMIN_API_KEY', { ...base, ADMIN_API_KEY: '' }, /ADMIN_API_KEY is required/],
    [
      'with an unsafe key',
      { ...base, ADMIN_API_KEY: 'unsafe$key' },
      /double quote, backslash or dollar/,
    ],
    ['without API_PROXY_ORIGIN', { ...base, API_PROXY_ORIGIN: '' }, /API_PROXY_ORIGIN is required/],
  ]) {
    const name = `${ID}-refuse-${failures.length}-${label.length}`;
    const started = await startDashboard(name, env);
    const output = docker(['logs', name], { check: false });
    check(
      `the container stops ${label}`,
      started === null && message.test(output.stderr),
      output.stderr.trim(),
    );
    if (env.ADMIN_API_KEY)
      check(
        `the refusal does not print the key ${label}`,
        !`${output.stdout}${output.stderr}`.includes(env.ADMIN_API_KEY),
      );
  }

  await checkTailscaleImage(base);
}

/**
 * The :tailscale image's nginx, prepared exactly as its start script does
 * (the lines from the render through the socket directory are taken from the
 * script itself), then started without tailscaled, which needs a tailnet.
 * Requests come over the Unix socket from inside the container, as Tailscale
 * Serve's would, with the headers Serve sets.
 */
async function checkTailscaleImage(base) {
  console.log('The :tailscale image (admin/Dockerfile.tailscale)');
  docker(['build', '-q', '-f', 'admin/Dockerfile.tailscale', '-t', TAILSCALE_IMAGE, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  imagesBuilt.add(TAILSCALE_IMAGE);
  const script = readFileSync('admin/scripts/start-with-tailscale.sh', 'utf8').split('\n');
  const first = script.findIndex(line => line.startsWith('/usr/local/bin/render-nginx-conf.sh '));
  const last = script.indexOf(`rm -f ${SOCKET}`);
  check('the start script prepares the socket after rendering', first > 0 && last > first);
  if (!(first > 0 && last > first)) return;
  const prepare = script.slice(first, last + 1).filter(line => line && !line.startsWith('#'));
  const name = `${ID}-tailscale`;
  const env = { ...base, CSP_REPORT_ORIGIN: `https://${DASHBOARD_HOST}` };
  delete env.DASHBOARD_HOSTNAMES;
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    NETWORK,
    '-v',
    `${path.join(work, 'ca-bundle.crt')}:/etc/ssl/certs/ca-certificates.crt:ro`,
    '--entrypoint',
    '/bin/sh',
  ];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  docker([
    ...args,
    TAILSCALE_IMAGE,
    '-c',
    ['set -e', ...prepare, "exec nginx -g 'daemon off;'"].join('\n'),
  ]);
  containers.add(name);
  let healthy = false;
  for (let attempt = 0; attempt < 50 && !healthy; attempt += 1) {
    healthy = socketRequest(name, { path: '/health' }).status === 200;
    if (!healthy) await new Promise(resolve => setTimeout(resolve, 200));
  }
  check(
    'its nginx answers /health on the socket',
    healthy,
    docker(['logs', name], { check: false }).stderr,
  );
  if (!healthy) return;

  // Docker's embedded DNS listens on 127.0.0.11 in every container; nginx
  // must hold no TCP listener at all
  const listeners = docker(['exec', name, 'netstat', '-ltnp']).stdout;
  check(
    'nginx listens on no TCP port',
    !listeners.split('\n').some(line => /LISTEN/.test(line) && /nginx/.test(line)) &&
      !/:3001\b/.test(listeners),
    listeners.trim(),
  );
  check(
    'it listens on the Unix socket',
    docker(['exec', name, 'netstat', '-lx']).stdout.includes(SOCKET),
  );
  check(
    'a loopback TCP request finds nothing',
    docker(
      ['exec', name, 'wget', '-q', '-T', '2', '-O', '/dev/null', 'http://127.0.0.1:3001/health'],
      {
        check: false,
      },
    ).status !== 0,
  );
  check(
    'the socket directory is root-only',
    docker(['exec', name, 'stat', '-c', '%a %U', '/run/bifrost']).stdout.trim() === '700 root',
  );
  // The compose healthcheck: the socket here, TCP in an image from before
  // the socket (a rollback; the plain image, on TCP 3001, stands in for one)
  const healthcheck = JSON.parse(
    /^\s+test: (\["CMD-SHELL", .*\])$/m.exec(
      readFileSync('admin/docker-compose.tailscale.yml', 'utf8'),
    )?.[1] ?? '[]',
  )[1];
  check(
    'the compose healthcheck passes on the socket',
    typeof healthcheck === 'string' &&
      docker(['exec', name, 'sh', '-c', healthcheck], { check: false }).status === 0,
  );
  check(
    'the compose healthcheck passes on an image without the socket (rollback)',
    typeof healthcheck === 'string' &&
      docker(['exec', `${ID}-dashboard`, 'sh', '-c', healthcheck], { check: false }).status === 0,
  );

  // What Serve sends: Host localhost, the browser's host in
  // X-Forwarded-Host, the viewer's identity
  const serve = (extra = {}) => ({
    'x-forwarded-host': DASHBOARD_HOST,
    'x-bifrost-dashboard': '1',
    'sec-fetch-site': 'same-origin',
    'tailscale-user-login': 'person@example.com',
    'tailscale-user-name': 'Person',
    ...extra,
  });
  const identity = socketRequest(name, { path: '/api/tailscale/identity', headers: serve() });
  check(
    'Serve’s identity is trusted',
    identity.status === 200 && JSON.parse(identity.body || '{}').login === 'person@example.com',
    identity.body,
  );
  // nginx pastes the values into the JSON unescaped, so one holding a quote
  // or a backslash is blanked: still valid JSON, and no injected key
  const quotedIdentity = (headers, expected) => {
    const answer = socketRequest(name, {
      path: '/api/tailscale/identity',
      headers: serve(headers),
    });
    try {
      const parsed = JSON.parse(answer.body);
      return (
        answer.status === 200 &&
        JSON.stringify(Object.keys(parsed)) ===
          JSON.stringify(['login', 'name', 'profilePic', 'isAuthenticated']) &&
        JSON.stringify(parsed) === JSON.stringify(expected)
      );
    } catch {
      return false;
    }
  };
  const injected = 'Per"son", "isAuthenticated": false, "admin": "x';
  check(
    'a quoted display name is blanked and the identity answer stays valid JSON',
    quotedIdentity(
      { 'tailscale-user-name': injected, 'tailscale-user-profile-pic': 'a\\b' },
      { login: 'person@example.com', name: '', profilePic: '', isAuthenticated: true },
    ),
  );
  check(
    'a quoted login is blanked and answers unauthenticated',
    quotedIdentity(
      { 'tailscale-user-login': 'person@example.com","isAuthenticated":true,"x":"' },
      { login: '', name: 'Person', profilePic: '', isAuthenticated: false },
    ),
  );
  const echo = socketRequest(name, {
    method: 'POST',
    path: '/api/echo',
    headers: serve({ origin: `https://${DASHBOARD_HOST}`, 'content-type': 'application/json' }),
    body: '{}',
  });
  check(
    'the dashboard’s own call through Serve is proxied',
    echo.status === 200,
    `${echo.status} ${echo.body}`,
  );
  const { sent } = received(echo);
  check(
    'the Worker gets the key and Serve’s identity for its audit rows',
    JSON.stringify(sent.get('x-admin-key')) === JSON.stringify([KEY]) &&
      JSON.stringify(sent.get('tailscale-user-login')) === '["person@example.com"]' &&
      JSON.stringify(sent.get('tailscale-user-name')) === '["Person"]',
    JSON.stringify([...sent.entries()].filter(([key]) => key.startsWith('tailscale'))),
  );
  for (const [label, headers] of [
    ['an Origin of another host', serve({ origin: 'https://evil.example' })],
    [
      'an Origin that is not the X-Forwarded-Host',
      serve({ origin: `https://${DASHBOARD_HOST}`, 'x-forwarded-host': 'other.example.com' }),
    ],
    [
      'an Origin with no X-Forwarded-Host (Host is localhost)',
      { ...serve({ origin: `https://${DASHBOARD_HOST}` }), 'x-forwarded-host': '' },
    ],
  ]) {
    const answer = socketRequest(name, { method: 'POST', path: '/api/echo', headers, body: '{}' });
    check(
      `behind Serve, ${label} is refused 403`,
      answer.status === 403 && answer.body.includes('CROSS_SITE_REQUEST'),
      String(answer.status),
    );
  }

  // The per-viewer limit keys on Serve's identity (every request arrives over
  // the one socket), and the whole receiver has its own limit
  const reports = logins =>
    docker(
      [
        'exec',
        name,
        'sh',
        '-c',
        `for login in ${logins.join(' ')}; do curl -s -o /dev/null -w '%{http_code}\\n' --unix-socket ${SOCKET} -X POST -H "Tailscale-User-Login: $login" -H 'Content-Type: application/reports+json' --data '[]' http://localhost/csp-report & done; wait`,
      ],
      { check: false },
    )
      .stdout.trim()
      .split('\n');
  const burst = reports(Array.from({ length: 20 }, () => 'viewer-a@example.com'));
  check(
    'a burst from one viewer is limited (204 then 429)',
    burst.includes('204') &&
      burst.includes('429') &&
      burst.every(code => /^(?:204|429)$/.test(code)),
    JSON.stringify(burst),
  );
  check(
    'another viewer is not limited by the first',
    reports(['viewer-b@example.com'])[0] === '204',
  );
  const many = reports(Array.from({ length: 120 }, (_, i) => `viewer-${i}@example.com`));
  check('the whole receiver is limited too', many.includes('429'), JSON.stringify(many));
}

try {
  await main();
} catch (error) {
  failures.push(String(error instanceof Error ? error.message : error));
  console.error(error);
} finally {
  cleanup();
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exitCode = 1;
} else if (process.exitCode !== 2) {
  console.log('\nAll dashboard container checks passed.');
}

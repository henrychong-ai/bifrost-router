/**
 * Dashboard nginx security (v1.37.0; v1.39.0 the key-adding /api proxy,
 * CSP_MODE and reporting, the classic-script Zod jitless).
 *
 * Both images render ONE template, admin/nginx.conf.template, with
 * admin/scripts/render-nginx-conf.sh at container start from the container's
 * environment. ADMIN_API_KEY goes into a root-only include for the /api proxy,
 * so the browser never holds it. These tests render the template and read
 * the config; scripts/check-dashboard-container.mjs runs the real image
 * (Docker) and checks the same behaviour on the wire. Only synthetic keys
 * are used here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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

import { parse as parseHtml } from 'parse5';

import {
  locationBlocks,
  locationsWithAddHeader,
  mapEntries,
  mapValue,
  pagePolicy,
  serverHeaders,
} from './nginx-config.mjs';

const TEMPLATE = 'admin/nginx.conf.template';
const RENDER = 'admin/scripts/render-nginx-conf.sh';
const DOCKERFILES = ['admin/Dockerfile', 'admin/Dockerfile.tailscale'];
const START_SCRIPTS = ['admin/scripts/start.sh', 'admin/scripts/start-with-tailscale.sh'];
const RENDER_ENV = [
  'CSP_MODE',
  'CSP_REPORT_ORIGIN',
  'API_PROXY_ORIGIN',
  'API_PROXY_RESOLVER',
  'R2_PREVIEW_ORIGINS',
  'ADMIN_API_KEY',
  'DASHBOARD_HOSTNAMES',
  'DASHBOARD_LISTEN_ADDRESS',
  'DASHBOARD_TAILSCALE_SERVE',
];
const DASHBOARD = 'https://dashboard.example.com';
const WORKER = 'https://bifrost.example.com';
const KEY = 'synthetic-admin-key-AZaz09-._~+/=!#%&()*,:;<>?@[]^`{|}';
/** Where the containers keep the rendered key include. */
const KEY_FILE = '/etc/nginx/bifrost/admin-key.conf';
const API_LOCATION = 'location ~ ^/api/ {';
/** The Unix socket nginx listens on behind Tailscale Serve. */
const SERVE_SOCKET = '/run/bifrost/nginx.sock';
const API_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";
const PAGE_POLICY =
  "default-src 'self'; base-uri 'self'; object-src __CSP_OBJECT_SRC__; " +
  "frame-src 'self'__CSP_PREVIEW_ORIGINS__; frame-ancestors 'none'; form-action 'self'; " +
  "script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' https://assets.fusang.co data:; img-src 'self' data: blob: https:; " +
  "connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:; " +
  'upgrade-insecure-requests__CSP_REPORTING__';

const template = readFileSync(TEMPLATE, 'utf8');

/**
 * Render the template as the container entrypoint does, with exactly `values`
 * in the environment (every other render variable unset). `previous`, when
 * given, is written to the config and the key file first, so a refusal can be
 * shown to leave both untouched. The key file sits in the temp directory; its
 * path in the config is mapped back to the containers' path.
 */
function render(values, previous) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bifrost-nginx-'));
  const output = path.join(dir, 'default.conf');
  const keyFile = path.join(dir, 'admin-key.conf');
  const env = { ...process.env };
  for (const name of RENDER_ENV) delete env[name];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) env[name] = value;
  }
  if (previous !== undefined) {
    writeFileSync(output, previous);
    writeFileSync(keyFile, previous);
  }
  try {
    const result = spawnSync('sh', [RENDER, TEMPLATE, output, keyFile], {
      env,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      config: existsSync(output)
        ? readFileSync(output, 'utf8').replaceAll(keyFile, KEY_FILE)
        : null,
      key: existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : null,
      keyMode: existsSync(keyFile) ? statSync(keyFile).mode & 0o777 : null,
      tmpLeft: readdirSync(dir).some(name => name.endsWith('.tmp')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The smallest valid value set: the two required inputs. */
const REQUIRED = { API_PROXY_ORIGIN: WORKER, ADMIN_API_KEY: KEY };

/** A directive's source list from a policy, e.g. directive(csp, 'img-src'). */
function directive(policy, name) {
  const match = new RegExp(`(?:^|; )${name}( [^;]*)?(?:;|$)`).exec(policy);
  assert.ok(match, `${name} missing`);
  return (match[1] ?? '').trim();
}

/** The page-policy header name of a rendered config. */
function pageHeaderName(config) {
  const names = serverHeaders(config)
    .filter(([, value]) => value === '$bifrost_page_csp')
    .map(([name]) => name);
  assert.equal(names.length, 1);
  return names[0];
}

/** The body of the one location with `head`. */
function locationBody(config, head) {
  const blocks = locationBlocks(config).filter(block => block.head === head);
  assert.equal(blocks.length, 1, head);
  return blocks[0].body;
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

test('the page policy is static, connect-src self, and never reaches /api', () => {
  assert.equal(pagePolicy(template), PAGE_POLICY);
  assert.deepEqual(mapEntries(template, 'bifrost_page_csp'), {
    source: '$uri',
    entries: [
      ['default', PAGE_POLICY],
      ['~^/api/', ''],
    ],
  });
  // No nonce machinery (the bundle has no inline script), outside comments
  const directives = template.replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(directives, /nonce|sub_filter|\$request_id|unsafe-eval/);
});

test('every /api response gets the enforced data policy, whatever CSP_MODE says', () => {
  assert.deepEqual(mapEntries(template, 'bifrost_api_csp'), {
    source: '$uri',
    entries: [
      ['default', ''],
      ['~^/api/', API_POLICY],
    ],
  });
  // A header of its own, never the CSP_MODE-named one
  assert.ok(
    serverHeaders(template).some(
      ([name, value, always]) =>
        name === 'Content-Security-Policy' && value === '$bifrost_api_csp' && always,
    ),
  );
});

test('every /api response that is not JSON is an attachment', () => {
  assert.deepEqual(mapEntries(template, 'bifrost_api_disposition'), {
    source: '$upstream_http_content_type',
    entries: [
      ['default', 'attachment'],
      [String.raw`~*^application/json\s*(?:;|$)`, '$upstream_http_content_disposition'],
    ],
  });
  assert.deepEqual(mapEntries(template, 'bifrost_content_disposition'), {
    source: '$uri',
    entries: [
      ['default', ''],
      ['~^/api/', '$bifrost_api_disposition'],
    ],
  });
  // The Worker's own value is replaced by the map's, never sent twice
  assert.match(locationBody(template, API_LOCATION), /\bproxy_hide_header Content-Disposition;/);
  // The JSON pattern, as PCRE reads it: JSON keeps the Worker's value, anything
  // else (no type, HTML, a type that only starts like JSON) is an attachment
  const json = /^application\/json\s*(?:;|$)/i;
  for (const type of ['application/json', 'application/json; charset=UTF-8', 'Application/JSON']) {
    assert.ok(json.test(type), type);
  }
  for (const type of ['', 'text/html', 'application/jsonp', 'application/json+x', 'text/json']) {
    assert.equal(json.test(type), false, type);
  }
});

test('the /api proxy refuses a cross-site request before it adds the key', () => {
  assert.deepEqual(mapEntries(template, 'bifrost_api_csrf_header'), {
    source: '$http_x_bifrost_dashboard',
    entries: [
      ['1', ''],
      ['default', 'header'],
    ],
  });
  assert.deepEqual(mapEntries(template, 'bifrost_api_csrf_site'), {
    source: '$http_sec_fetch_site',
    entries: [
      ['', ''],
      ['same-origin', ''],
      ['default', 'site'],
    ],
  });
  assert.deepEqual(mapEntries(template, 'bifrost_api_csrf_origin'), {
    source: '$http_origin $bifrost_request_host',
    entries: [
      ['~^ ', ''],
      [String.raw`~*^https?://([^/\s]+) \1$`, ''],
      ['default', 'origin'],
    ],
  });
  assert.deepEqual(mapEntries(template, 'bifrost_api_refused'), {
    source: '$bifrost_api_csrf_header$bifrost_api_csrf_site$bifrost_api_csrf_origin',
    entries: [
      ['', '0'],
      ['default', '1'],
    ],
  });
  // The refusals are the location's first directives, the path first:
  // nothing is proxied, and no key added, before both have passed
  const body = locationBody(template, API_LOCATION).trim().split('\n');
  const first = body.findIndex(line => !/^\s*(?:default_type|$)/.test(line));
  assert.match(body[first], /^\s*if \(\$bifrost_api_path_refused\) \{$/);
  assert.match(body[first + 1], /^\s*return 400 '';$/);
  assert.match(body[first + 3], /^\s*if \(\$bifrost_api_refused\) \{$/);
  assert.match(body[first + 4], /^\s*return 403 '';$/);
  assert.ok(
    template.includes(
      `return 403 '{"success":false,"error":"CROSS_SITE_REQUEST","message":"The dashboard API answers only the dashboard itself."}';`,
    ),
  );
});

/** The path-refusal map's answer for a raw request URI (1 refused). */
const pathRefused = uri => Number(mapValue(template, 'bifrost_api_path_refused', uri));

test('the /api proxy refuses a raw path that leaves /api or hides a segment', () => {
  assert.deepEqual(mapEntries(template, 'bifrost_api_path_refused'), {
    source: '$request_uri',
    entries: [
      ['~*^[^?]*(?:%2f|%2e|%5c|//)', '1'],
      [
        String.raw`~^/api/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$`,
        '0',
      ],
      ['default', '1'],
    ],
  });
  assert.ok(
    template.includes(
      `return 400 '{"success":false,"error":"BAD_API_PATH","message":"The API path must start with /api/ and hold only URL path and query characters, no encoded slash, dot or backslash, and no empty segment."}';`,
    ),
  );
  for (const uri of [
    '/api/',
    '/api/routes',
    '/api/routes?path=%2Fpromo&domain=example.com',
    '/api/routes?q=a+b&x=1&y=%2F&z=a/b?c',
    '/api/storage/files/objects/docs/a%20b.pdf',
    '/api/storage/files/objects/a%23b%3Fc%25',
    "/api/storage/files/objects/a!$&'()*+,;=:@-._~b",
    '/api/storage/files/purge-cache/docs/report.pdf',
    '/api/qr/code-1?domain=example.com',
  ]) {
    assert.equal(pathRefused(uri), 0, uri);
  }
  for (const uri of [
    // Bare /api is not the API: the Worker serves it as an ordinary path
    '/api',
    '/api?x=1',
    '/x/..%2Fapi/y',
    '/x%2F..%2Fapi/y',
    '//api/x',
    '/api//x',
    '/api/x%2f..%2fy',
    '/api/a%2Eb',
    '/api/a%5Cb',
    '/api/a\\b',
    // nginx's $uri stops at a raw #; the Worker would resolve what follows
    '/api/x#/../../evil',
    '/api/x?a=1#/../../evil',
    '/api/a b',
    '/api/a"b',
    '/api/a<b>',
    '/api/a^b',
    '/api/a`b',
    '/api/a{b}',
    '/api/a|b',
    '/api/x?q=a|b',
    '/api/aéb',
    '/apix',
    '/API/routes',
    '/assets/../api/x',
  ]) {
    assert.equal(pathRefused(uri), 1, uri);
  }
});

test('a Host the dashboard does not know gets no answer but /health, which needs no key', () => {
  const servers = [...template.matchAll(/^server \{\n([\s\S]*?)\n\}$/gm)].map(match => match[1]);
  assert.equal(servers.length, 2);
  // The default server answers /health (a probe naming the container by its
  // address) and drops everything else: no files, no proxy, no key
  assert.equal(
    servers[0],
    [
      '    listen __LISTEN__ default_server;',
      '    server_name _;',
      '    server_tokens off;',
      '    access_log /dev/stdout bifrost_access;',
      '',
      '    location = /health {',
      '        default_type application/json;',
      `        return 200 '{"status":"ok"}';`,
      '    }',
      '',
      '    location / {',
      '        return 444;',
      '    }',
    ].join('\n'),
  );
  assert.match(
    servers[1],
    /^ {4}listen __LISTEN__;\n {4}server_name localhost 127\.0\.0\.1__DASHBOARD_HOSTNAMES__;$/m,
  );
  assert.doesNotMatch(servers[1], /default_server/);
});

test('the template and the dashboard client name the same request header', () => {
  const source = readFileSync('admin/src/lib/dashboard-request.ts', 'utf8');
  const header = /DASHBOARD_REQUEST_HEADER = '([^']+)'/.exec(source)?.[1];
  const value = /DASHBOARD_REQUEST_VALUE = '([^']+)'/.exec(source)?.[1];
  assert.equal(header, 'X-Bifrost-Dashboard');
  assert.equal(value, '1');
  // nginx's variable for a header: lower case, dashes as underscores
  assert.equal(
    mapEntries(template, 'bifrost_api_csrf_header').source,
    `$http_${header.toLowerCase().replaceAll('-', '_')}`,
  );
  // The refusal body the dev server sends is nginx's
  const body = /CROSS_SITE_REFUSAL_BODY = JSON\.stringify\((\{[\s\S]*?\})\);/.exec(source)?.[1];
  assert.ok(body);
  const devBody = JSON.stringify(
    Function(`"use strict"; return (${body});`)(), // a literal object in our own source
  );
  assert.ok(template.includes(`return 403 '${devBody}';`));
  // And the dev server registers the guard before its proxy, in both servers,
  // with settings Vite never hands to the browser (no VITE_ prefix)
  const vite = readFileSync('admin/vite.config.ts', 'utf8');
  const devProxy = readFileSync('admin/dev-api-proxy.ts', 'utf8');
  assert.match(devProxy, /^export const DEV_ENV_PREFIX = 'DASHBOARD_DEV_';$/m);
  // One proxy config, from the DASHBOARD_DEV_ settings, for both servers
  assert.equal(
    vite.match(/const devEnv = loadEnv\(mode, import\.meta\.dirname, DEV_ENV_PREFIX\);/g)?.length,
    1,
  );
  assert.equal(vite.match(/const proxy = devApiProxy\(devEnv\);/g)?.length, 1);
  // Both servers proxy with it and answer no CORS request
  assert.equal(vite.match(/^\s+port: 3001,\n\s+proxy,\n\s+cors: false,$/gm)?.length, 2);
  for (const text of [vite, devProxy]) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /VITE_|envPrefix/);
  }
  assert.equal(
    vite.match(
      /server\.middlewares\.use\(tailscaleIdentityMiddleware\(\)\);\n\s+server\.middlewares\.use\(dashboardApiGuard\(\)\);/g,
    )?.length,
    2,
  );
});

test('the /api proxy verifies the Worker certificate and bounds the body', () => {
  const body = locationBody(template, API_LOCATION);
  for (const line of [
    'proxy_pass https://$bifrost_api_host$request_uri;',
    'proxy_ssl_server_name on;',
    'proxy_ssl_name $bifrost_api_host;',
    'proxy_ssl_verify on;',
    'proxy_ssl_verify_depth 3;',
    'proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;',
    'proxy_set_header Host $bifrost_api_host;',
    // A front door's cookie or credentials never reach the Worker
    'proxy_set_header Cookie "";',
    'proxy_set_header Authorization "";',
    'proxy_set_header Proxy-Authorization "";',
    'proxy_set_header Cf-Access-Jwt-Assertion "";',
    'proxy_set_header X-Forwarded-Access-Token "";',
    'client_max_body_size 101m;',
    // Uploads stream to the Worker, never spooled to a temporary file first
    'proxy_request_buffering off;',
    // and downloads stream back: a large object never spools to the disk
    'proxy_max_temp_file_size 0;',
  ]) {
    assert.ok(body.includes(`\n        ${line}\n`), line);
  }
  assert.doesNotMatch(template, /proxy_ssl_verify off|proxy_buffering off|proxy_temp_path/);
  // At least the dashboard's largest upload plus room for its multipart framing
  const storage = readFileSync('admin/src/pages/storage.tsx', 'utf8');
  const [, megabytes] = /const MAX_UPLOAD_SIZE = (\d+) \* 1024 \* 1024;/.exec(storage) ?? [];
  assert.ok(megabytes, 'MAX_UPLOAD_SIZE moved');
  const limit = Number(/client_max_body_size (\d+)m;/.exec(body.replace(/''/g, ''))?.[1]);
  assert.ok(limit > Number(megabytes), `client_max_body_size ${limit}m <= ${megabytes} MiB`);
  // Both images carry the CA bundle the proxy verifies against
  for (const dockerfile of DOCKERFILES) {
    assert.match(
      readFileSync(dockerfile, 'utf8'),
      /^RUN test -s \/etc\/ssl\/certs\/ca-certificates\.crt$/m,
      dockerfile,
    );
  }
});

test('the API proxy hides the Worker copies of the server-level headers', () => {
  const body = locationBody(template, API_LOCATION);
  for (const header of [
    'Content-Security-Policy',
    'Content-Security-Policy-Report-Only',
    'Reporting-Endpoints',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Frame-Options',
    'Permissions-Policy',
    'Content-Disposition',
  ]) {
    assert.ok(body.includes(`proxy_hide_header ${header};`), header);
  }
});

/** The text of a parse5 node: every text node under it, in order. */
const nodeText = node =>
  (node.childNodes ?? [])
    .map(child => (child.nodeName === '#text' ? child.value : nodeText(child)))
    .join('');

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Every element named `name` in a parsed document, as a browser's parser
 * builds the tree. The walk enters template contents and foreign (SVG)
 * content too, so an element anywhere in the tree counts.
 */
function elementsNamed(document, name) {
  const found = [];
  const walk = node => {
    if (node.nodeName === name) found.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(document);
  return found;
}

/**
 * Every `script` element in an HTML document: parse5 implements the WHATWG
 * tokenizer and tree builder, so a stray quote in an attribute name, end
 * tags with attributes, the script data escape states (`<!--<script>`), any
 * letter case and an unclosed script are all read the way the browser reads
 * them. A hand-written scan or a regex gets at least one of those wrong.
 * Each element is { svg, attrs, body }: whether it is an SVG script, its
 * attributes as [name, value] pairs (a namespaced one by its qualified name,
 * such as `xlink:href`; the parser keeps the first of a duplicate, as
 * browsers do) and its text.
 */
function scriptElements(html) {
  return elementsNamed(parseHtml(html), 'script').map(node => ({
    svg: node.namespaceURI === SVG_NAMESPACE,
    attrs: node.attrs.map(({ prefix, name, value }) => [
      prefix ? `${prefix}:${name}` : name,
      value,
    ]),
    body: nodeText(node),
  }));
}

/**
 * Two unrelated page origins. A root-relative URL stays on the page's own
 * origin under both; a disguised protocol-relative one (`/\\host/a.js`) names
 * one host, so it cannot stay on both (resolving against one base alone would
 * accept a URL naming that base's own host).
 */
const PAGE_ORIGINS = ['https://dashboard-a.invalid', 'https://dashboard-b.invalid'];

/**
 * Why `html` would need a nonce, or could load script from elsewhere, under
 * script-src 'self'. Each script must load a same-origin file and carry no
 * code: its URL (`src` for an HTML script; `href`, else `xlink:href`, for an
 * SVG script, as the browser reads them) must be a path from the root (one
 * leading `/`) that the URL parser resolves to the page's own origin (so a
 * backslash, or a tab or newline the parser strips, cannot turn it into a
 * protocol-relative URL), and its body must be empty. A `<base>` element
 * anywhere fails too, as it would move what every relative URL resolves
 * against. Empty when the page passes.
 */
/** `value` without leading and trailing ASCII whitespace, as HTML strips it (never Unicode spaces). */
function asciiTrim(value) {
  return value?.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
}

function inlineScriptProblems(html) {
  const document = parseHtml(html);
  const baseProblems = elementsNamed(document, 'base').map(
    node => `base element: ${JSON.stringify(node.attrs.map(({ name, value }) => [name, value]))}`,
  );
  const scriptProblems = scriptElements(html).flatMap(({ svg, attrs, body }) => {
    const attr = name => attrs.find(([attrName]) => attrName === name)?.[1];
    // Browsers strip leading and trailing ASCII whitespace from a URL attribute
    const url = asciiTrim(svg ? (attr('href') ?? attr('xlink:href')) : attr('src'));
    // With a root-relative input and an absolute base, the URL parser cannot throw
    const sameOrigin =
      url !== undefined &&
      url.startsWith('/') &&
      !url.startsWith('//') &&
      PAGE_ORIGINS.every(origin => new URL(url, `${origin}/`).origin === origin);
    return [
      ...(sameOrigin ? [] : [`no same-origin URL: ${JSON.stringify(attrs)}`]),
      ...(body.trim() === '' ? [] : [`inline body: ${JSON.stringify(body)}`]),
    ];
  });
  return [...baseProblems, ...scriptProblems];
}

test('the script check reads HTML as a browser parses it', () => {
  // A quote in an attribute name or an unquoted value is part of the name,
  // not the start of a quoted value, so the inline script is still a script
  for (const html of [
    `<script x'>alert(1)</script><script src="/b.js" '></script>`,
    '<script a">alert(1)</script><script src="/b.js"></script>',
  ]) {
    assert.ok(inlineScriptProblems(html).includes('inline body: "alert(1)"'), html);
  }
  assert.deepEqual(scriptElements(`<script x'>alert(1)</script>`), [
    { svg: false, attrs: [["x'", '']], body: 'alert(1)' },
  ]);
  // End tags may carry attributes, quoted or not, and any case
  assert.deepEqual(scriptElements('<script>x()</script foo="bar">'), [
    { svg: false, attrs: [], body: 'x()' },
  ]);
  assert.deepEqual(scriptElements('<SCRIPT SRC="/a.js"></SCRIPT >'), [
    { svg: false, attrs: [['src', '/a.js']], body: '' },
  ]);
  assert.deepEqual(inlineScriptProblems('<SCRIPT SRC="/a.js"></SCRIPT >'), []);
  // A quoted > does not end a start tag
  assert.deepEqual(scriptElements('<script data-x=">">y()</script>'), [
    { svg: false, attrs: [['data-x', '>']], body: 'y()' },
  ]);
  // An unclosed script runs to the end of the input, so its body is checked
  assert.deepEqual(scriptElements('<script>z()'), [{ svg: false, attrs: [], body: 'z()' }]);
  assert.notDeepEqual(inlineScriptProblems('<script src="/a.js">z()'), []);
  // The double-escaped state: the first end tag inside <!--<script> does not
  // close the element, so b() is part of its body
  assert.deepEqual(scriptElements('<script><!--<script>a</script>b()</script>'), [
    { svg: false, attrs: [], body: '<!--<script>a</script>b()' },
  ]);
  // A tag name ends at whitespace, / or >: <scripts> and </scripty> are not script tags
  assert.deepEqual(scriptElements('<scripts></scripts><script>w()</scripty></script>'), [
    { svg: false, attrs: [], body: 'w()</scripty>' },
  ]);
  // Scripts in template contents and SVG count; one in a comment is not one
  assert.equal(scriptElements('<template><script>t()</script></template>').length, 1);
  assert.deepEqual(scriptElements('<svg><script>s()</script></svg>'), [
    { svg: true, attrs: [], body: 's()' },
  ]);
  assert.deepEqual(scriptElements('<!--<script>c()</script>-->'), []);
  // Not same-origin, or no src at all
  assert.notDeepEqual(
    inlineScriptProblems('<script src="https://cdn.example.com/a.js"></script>'),
    [],
  );
  assert.notDeepEqual(inlineScriptProblems('<script src="//cdn.example.com/a.js"></script>'), []);
  // A disguised protocol-relative URL naming a page origin's own host
  for (const host of ['dashboard-a.invalid', 'dashboard-b.invalid']) {
    assert.notDeepEqual(inlineScriptProblems(`<script src="/\\${host}/a.js"></script>`), []);
    assert.notDeepEqual(inlineScriptProblems(`<script src="/&#9;/${host}/a.js"></script>`), []);
  }
  assert.notDeepEqual(inlineScriptProblems('<script data-src="/a.js"></script>'), []);
  // One leading slash is not enough: the URL parser reads a backslash as a
  // slash and strips a tab or newline (here a character reference or a raw
  // newline in the value), so each of these is protocol-relative
  for (const src of [
    '/\\cdn.example.com/a.js',
    '/&#9;/cdn.example.com/a.js',
    '/\n/cdn.example.com/a.js',
  ]) {
    assert.notDeepEqual(inlineScriptProblems(`<script src="${src}"></script>`), [], src);
  }
  // Surrounding ASCII whitespace is stripped as the browser does; a Unicode space is not
  assert.deepEqual(inlineScriptProblems('<script src=" /a.js\n"></script>'), []);
  assert.notDeepEqual(inlineScriptProblems('<script src="\u00a0/a.js"></script>'), []);
  // An SVG script loads its href (else xlink:href), never a src
  assert.deepEqual(inlineScriptProblems('<svg><script href="/a.js"></script></svg>'), []);
  assert.deepEqual(inlineScriptProblems('<svg><script xlink:href="/a.js"></script></svg>'), []);
  assert.notDeepEqual(
    inlineScriptProblems('<svg><script src="/a.js" href="https://evil.example/x.js"/></svg>'),
    [],
  );
  assert.notDeepEqual(
    inlineScriptProblems('<svg><script href="//evil.example/x.js" xlink:href="/a.js"/></svg>'),
    [],
  );
  assert.notDeepEqual(inlineScriptProblems('<svg><script src="/a.js"></script></svg>'), []);
  // A <base> moves what a root-relative src resolves against
  assert.deepEqual(
    inlineScriptProblems('<base href="https://evil.example/"><script src="/a.js"></script>'),
    ['base element: [["href","https://evil.example/"]]'],
  );
});

test('the dashboard HTML has no inline script, so script-src self needs no nonce', () => {
  const html = readFileSync('admin/index.html', 'utf8');
  assert.ok(scriptElements(html).length > 0);
  assert.deepEqual(inlineScriptProblems(html), []);
});

test('every security header is set once, at server level, on every response', () => {
  const headers = serverHeaders(template);
  assert.deepEqual(
    headers.map(([name, value, always]) => [name, value, always]),
    [
      ['__CSP_HEADER__', '$bifrost_page_csp', true],
      ['Content-Security-Policy', '$bifrost_api_csp', true],
      ['Reporting-Endpoints', '__CSP_REPORTING_ENDPOINTS__', true],
      ['Strict-Transport-Security', 'max-age=31536000', true],
      ['X-Content-Type-Options', 'nosniff', true],
      ['Referrer-Policy', 'strict-origin-when-cross-origin', true],
      ['X-Frame-Options', 'DENY', true],
      ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', true],
      ['Cache-Control', '$bifrost_cache_control', true],
      ['Content-Disposition', '$bifrost_content_disposition', true],
    ],
  );
  // add_header appears nowhere but those ten server-level lines
  assert.equal((template.match(/^\s*add_header\b/gm) ?? []).length, 10);
});

// A location with its own add_header inherits none of the server's (v1.37.1:
// /assets/, /env-config.js and /health were served without the CSP and the
// other security headers). Per-path headers come from maps.
test('no location sets its own add_header; per-path Cache-Control comes from the map', () => {
  assert.deepEqual(
    locationBlocks(template).map(({ head }) => head),
    [
      // the default server
      'location = /health {',
      'location / {',
      // the dashboard
      'location /assets/ {',
      'location = /csp-report {',
      'location = /api/tailscale/identity {',
      API_LOCATION,
      'location / {',
      'location = /health {',
    ],
  );
  assert.deepEqual(locationsWithAddHeader(template), []);
  assert.deepEqual(mapEntries(template, 'bifrost_cache_control'), {
    source: '$uri',
    entries: [
      ['default', ''],
      ['~^/assets/', '$bifrost_asset_cache_control'],
      ['/csp-report', 'no-store'],
      ['/health', 'no-store'],
    ],
  });
});

// A hashed asset is immutable, a 404 for a missing one is not: an old bundle
// asking for a chunk a newer build replaced must not cache the 404 for a year
test('an asset is cached immutable only on a successful answer', () => {
  const immutable = 'public, max-age=31536000, immutable';
  assert.deepEqual(mapEntries(template, 'bifrost_asset_cache_control'), {
    source: '$status',
    entries: [
      ['default', ''],
      ['200', immutable],
      ['206', immutable],
      ['304', immutable],
    ],
  });
  for (const status of ['200', '206', '304']) {
    assert.equal(mapValue(template, 'bifrost_asset_cache_control', status), immutable);
  }
  for (const status of ['404', '403', '416', '500', '301']) {
    assert.equal(mapValue(template, 'bifrost_asset_cache_control', status), '', status);
  }
  assert.equal(
    mapValue(template, 'bifrost_cache_control', '/assets/index-abc.js'),
    '$bifrost_asset_cache_control',
  );
  assert.equal(mapValue(template, 'bifrost_cache_control', '/api/assets/x'), '');
});

// The container check pins the asset Cache-Control it expects on the wire; it
// must be the template's own value, so a template change cannot leave the
// check (run on every image change) failing on, or passing, a stale value.
test('the container check expects the template asset Cache-Control', () => {
  const check = readFileSync('scripts/check-dashboard-container.mjs', 'utf8');
  const pinned = /^const ASSET_CACHE_CONTROL = '([^']+)';$/m.exec(check)?.[1];
  assert.ok(pinned, 'ASSET_CACHE_CONTROL moved');
  assert.equal(mapValue(template, 'bifrost_asset_cache_control', '200'), pinned);
  // And the check compares against it, not a copy
  assert.ok(
    check.includes("one(answer, 'cache-control')) === JSON.stringify([ASSET_CACHE_CONTROL])"),
  );
  assert.equal(check.match(/max-age=31536000/g)?.length, 1);
});

// The guard must see a location-level add_header wherever the block puts it:
// after a quoted string holding a closing brace, and after a nested if block.
// A first-closing-brace scan missed both.
test('the add_header guard sees past quoted braces and nested if blocks', () => {
  const healthReturn = `return 200 '{"status":"ok"}';`;
  assert.ok(template.includes(healthReturn), 'the /health return line moved');
  const afterQuotedReturn = template.replace(
    healthReturn,
    `${healthReturn}\n        add_header Content-Type application/json;`,
  );
  assert.deepEqual(locationsWithAddHeader(afterQuotedReturn), ['location = /health {']);

  const identityIf = 'if ($ts_login != "") { set $is_auth "true"; }';
  assert.ok(template.includes(identityIf), 'the identity if block moved');
  const afterIf = template.replace(identityIf, `${identityIf}\n        add_header X-Probe "1";`);
  assert.deepEqual(locationsWithAddHeader(afterIf), ['location = /api/tailscale/identity {']);

  const receiverIf = 'if ($request_method != POST) { return 405; }';
  assert.ok(template.includes(receiverIf), 'the CSP receiver if block moved');
  const insideIf = template.replace(
    receiverIf,
    'if ($request_method != POST) { add_header X-Probe "1"; return 405; }',
  );
  assert.deepEqual(locationsWithAddHeader(insideIf), ['location = /csp-report {']);

  // A quoted add_header is a string, not a directive
  const quoted = template.replace(healthReturn, `return 200 '{"note":"add_header"}';`);
  assert.deepEqual(locationsWithAddHeader(quoted), []);
});

test('the CSP report receiver is bounded per viewer and in total, after its limits', () => {
  const body = locationBody(template, 'location = /csp-report {');
  for (const line of [
    'set $bifrost_csp_receiver __CSP_RECEIVER__;',
    'if ($bifrost_csp_receiver = off) { return 404; }',
    'if ($request_method != POST) { return 405; }',
    'client_max_body_size 16k;',
    'limit_req zone=csp_reports burst=5 nodelay;',
    'limit_req zone=csp_reports_all burst=40 nodelay;',
    'limit_req_status 429;',
    'limit_req_log_level info;',
    'access_log /dev/stdout csp_report;',
    'try_files /.csp-report-receiver =204;',
  ]) {
    assert.ok(template.includes(`        ${line}\n`), line);
  }
  // The 204 is produced in the content phase, after limit_req: a `return`
  // other than the 404 and 405 refusals runs in the rewrite phase, before
  // limit_req, and would never be rate limited.
  assert.deepEqual(
    [...body.matchAll(/\breturn (\d+);/g)].map(match => match[1]),
    ['404', '405'],
  );
  assert.equal(body.match(/\breturn\b/g)?.length, 2);
  assert.ok(
    template.includes('limit_req_zone $bifrost_csp_report_viewer zone=csp_reports:1m rate=2r/s;'),
  );
  assert.ok(template.includes('limit_req_zone $server_name zone=csp_reports_all:64k rate=20r/s;'));
  // Per viewer: the trusted Tailscale identity when there is one (behind
  // Serve every request arrives over one socket), else the client address;
  // never a Tailscale header a client sent past another front door
  assert.deepEqual(mapEntries(template, 'bifrost_csp_report_viewer'), {
    source: '$bifrost_tailscale_user_login',
    entries: [
      ['', '$binary_remote_addr'],
      ['default', '$bifrost_tailscale_user_login'],
    ],
  });
  // The file try_files probes is never served: nothing in the web root has it
  for (const dir of ['admin/public', 'admin/dist']) {
    if (!existsSync(dir)) continue;
    assert.equal(
      readdirSync(dir, { recursive: true }).some(file =>
        String(file).includes('.csp-report-receiver'),
      ),
      false,
      dir,
    );
  }
  // Metadata only: the logged fields never include the report body
  const logFormat = /log_format csp_report escape=json\n([\s\S]*?);\n/.exec(template)?.[1];
  assert.ok(logFormat);
  assert.doesNotMatch(logFormat, /request_body|\$uri|\$args|\$request\b|\$http_x_admin_key/);
});

test('a client-sent X-Admin-Key is never forwarded', () => {
  // proxy_set_header (from the include) replaces the client's header of the
  // same name; nothing passes the client's value on under another name
  assert.ok(locationBody(template, API_LOCATION).includes('include __ADMIN_KEY_INCLUDE__;'));
  assert.doesNotMatch(
    template,
    /\$http_x_admin_key|\$http_authorization|proxy_pass_request_headers|underscores_in_headers/i,
  );
  assert.doesNotMatch(template, /proxy_set_header X-Admin-Key/);
  // The identity endpoint stays local (exact match beats the proxy regex)
  assert.ok(template.includes('location = /api/tailscale/identity {'));
});

// nginx's stock `main` format (the image's http-level access_log) records the
// request line with its query, the Referer and X-Forwarded-For; every server
// here names its own metadata-only log instead
test('no access log records a request target, query, Referer or forwarded header', () => {
  assert.deepEqual(
    [...template.matchAll(/^\s*log_format (\S+)/gm)].map(match => match[1]),
    ['csp_report', 'bifrost_access'],
  );
  for (const name of ['csp_report', 'bifrost_access']) {
    const format = new RegExp(String.raw`log_format ${name} escape=json\n([\s\S]*?);\n`).exec(
      template,
    )?.[1];
    assert.ok(format, name);
    assert.doesNotMatch(
      format,
      /\$request\b|\$request_uri|\$uri|\$args|\$arg_|\$query_string|\$is_args|\$document_uri|\$http_referer|\$http_x_forwarded|\$http_tailscale|\$http_x_admin_key|\$http_authorization|\$request_body|\$remote_user/,
      name,
    );
  }
  // Both servers log metadata; the CSP receiver its own line
  assert.deepEqual(
    [...template.matchAll(/^\s*access_log (.*);$/gm)].map(match => match[1]),
    ['/dev/stdout bifrost_access', '/dev/stdout bifrost_access', '/dev/stdout csp_report'],
  );
  const servers = [...template.matchAll(/^server \{\n([\s\S]*?)\n\}$/gm)].map(match => match[1]);
  for (const server of servers) {
    assert.match(server, /^ {4}access_log \/dev\/stdout bifrost_access;$/m);
  }
  // The scope is a fixed word per path, never a part of the path: an unknown
  // /api/<token>/... segment is logged as "api"
  const scopes = mapEntries(template, 'bifrost_log_scope');
  assert.equal(scopes.source, '$uri');
  for (const [, value] of scopes.entries) assert.match(value, /^[a-z-]+$/);
  for (const [uri, scope] of [
    ['/', 'page'],
    ['/routes', 'page'],
    ['/assets/index-abc.js', 'asset'],
    ['/api/routes', 'api'],
    ['/api/secret-token-123/x', 'api'],
    ['/api/tailscale/identity', 'identity'],
    ['/csp-report', 'csp-report'],
    ['/health', 'health'],
  ]) {
    assert.equal(mapValue(template, 'bifrost_log_scope', uri), scope, uri);
  }
});

// Behind Tailscale Serve (DASHBOARD_TAILSCALE_SERVE=on) the identity headers
// and X-Forwarded-Host are Serve's own; anywhere else a client could send
// them, so they are ignored
test('the Tailscale identity and the browser host are trusted only behind Serve', () => {
  for (const [name, header] of [
    ['bifrost_tailscale_user_login', '$http_tailscale_user_login'],
    ['bifrost_tailscale_user_name', '$http_tailscale_user_name'],
    ['bifrost_tailscale_user_profile_pic', '$http_tailscale_user_profile_pic'],
  ]) {
    assert.deepEqual(mapEntries(template, name), {
      source: '__TAILSCALE_SERVE__',
      entries: [
        ['on', header],
        ['default', ''],
      ],
    });
  }
  assert.deepEqual(mapEntries(template, 'bifrost_request_host'), {
    source: '__TAILSCALE_SERVE__',
    entries: [
      ['on', '$http_x_forwarded_host'],
      ['default', '$http_host'],
    ],
  });
  // Nothing reads a Tailscale header directly but those maps
  const direct = [...template.matchAll(/\$http_tailscale_\w+/g)].map(match => match[0]);
  assert.deepEqual(direct.toSorted(), [
    '$http_tailscale_user_login',
    '$http_tailscale_user_name',
    '$http_tailscale_user_profile_pic',
  ]);
  assert.equal((template.match(/\$http_x_forwarded_host/g) ?? []).length, 1);
  // The /api proxy sends the trusted values (an empty one is not sent), so a
  // client's own never reach the Worker's audit rows
  const body = locationBody(template, API_LOCATION);
  for (const header of ['Login', 'Name', 'Profile-Pic']) {
    const variable = `$bifrost_tailscale_user_${header.toLowerCase().replace('-', '_')}`;
    assert.ok(
      body.includes(`\n        proxy_set_header Tailscale-User-${header} ${variable};\n`),
      header,
    );
  }
  // The identity endpoint answers from them too, through the JSON-safe maps
  const identity = locationBody(template, 'location = /api/tailscale/identity {');
  assert.match(identity, /set \$ts_login \$bifrost_identity_json_login;/);
  assert.match(identity, /set \$ts_name \$bifrost_identity_json_name;/);
  assert.match(identity, /set \$ts_pic \$bifrost_identity_json_profile_pic;/);
});

// v1.39.0: nginx pastes the identity values into the endpoint's JSON with no
// escaping, so a value holding `"`, `\` or a control character is blanked:
// the answer stays valid JSON and no value adds a key
test('the identity endpoint answers valid JSON whatever the identity values hold', () => {
  const fields = [
    ['login', 'bifrost_identity_json_login', 'bifrost_tailscale_user_login'],
    ['name', 'bifrost_identity_json_name', 'bifrost_tailscale_user_name'],
    ['profilePic', 'bifrost_identity_json_profile_pic', 'bifrost_tailscale_user_profile_pic'],
  ];
  for (const [, name, trusted] of fields) {
    assert.deepEqual(mapEntries(template, name), {
      source: `$${trusted}`,
      entries: [
        [String.raw`~[\x00-\x1f\x22\x5c\x7f]`, ''],
        ['default', `$${trusted}`],
      ],
    });
  }
  // The answer as nginx builds it, from the raw return line
  const line = /return 200 '(\{"login":"\$ts_login".*\})';/.exec(template);
  assert.ok(line, 'the identity return line moved');
  /** The endpoint's answer for these trusted header values. */
  const answer = values => {
    const pasted = Object.fromEntries(
      fields.map(([field, name, trusted]) => {
        const value = mapValue(template, name, values[field] ?? '');
        return [field, value === `$${trusted}` ? (values[field] ?? '') : value];
      }),
    );
    return line[1]
      .replace('$ts_login', pasted.login)
      .replace('$ts_name', pasted.name)
      .replace('$ts_pic', pasted.profilePic)
      .replace('$is_auth', pasted.login === '' ? 'false' : 'true');
  };
  assert.deepEqual(
    JSON.parse(
      answer({
        login: 'person@example.com',
        name: 'Person Name',
        profilePic: 'https://example.com/p.png',
      }),
    ),
    {
      login: 'person@example.com',
      name: 'Person Name',
      profilePic: 'https://example.com/p.png',
      isAuthenticated: true,
    },
  );
  const injected = '", "isAuthenticated": true, "admin": "';
  for (const bad of [
    injected,
    'back\\slash',
    'tab\there',
    'line\nbreak',
    'nul\u0000',
    'del\u007f',
  ]) {
    const parsed = JSON.parse(answer({ login: 'person@example.com', name: bad, profilePic: bad }));
    assert.deepEqual(Object.keys(parsed), ['login', 'name', 'profilePic', 'isAuthenticated'], bad);
    assert.deepEqual([parsed.name, parsed.profilePic, parsed.isAuthenticated], ['', '', true], bad);
    const unauthenticated = JSON.parse(answer({ login: bad }));
    assert.deepEqual(unauthenticated, {
      login: '',
      name: '',
      profilePic: '',
      isAuthenticated: false,
    });
  }
  // Non-ASCII names pass as they are
  assert.equal(JSON.parse(answer({ login: 'a@example.com', name: 'José Ñ' })).name, 'José Ñ');
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('CSP_MODE defaults to enforce; report-only renames the page header only', () => {
  for (const mode of [undefined, '', 'enforce']) {
    const rendered = render({ ...REQUIRED, CSP_MODE: mode });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(pageHeaderName(rendered.config), 'Content-Security-Policy', String(mode));
  }
  const enforced = render(REQUIRED);
  const reportOnly = render({ ...REQUIRED, CSP_MODE: 'report-only' });
  assert.equal(reportOnly.status, 0, reportOnly.stderr);
  assert.equal(pageHeaderName(reportOnly.config), 'Content-Security-Policy-Report-Only');
  // The same policy text, and the /api policy enforced, in both modes
  assert.equal(pagePolicy(enforced.config), pagePolicy(reportOnly.config));
  for (const config of [enforced.config, reportOnly.config]) {
    assert.ok(config.includes('    add_header Content-Security-Policy $bifrost_api_csp always;\n'));
  }
  // Only the header name differs
  assert.equal(
    reportOnly.config.replace(
      'add_header Content-Security-Policy-Report-Only $bifrost_page_csp',
      'add_header Content-Security-Policy $bifrost_page_csp',
    ),
    enforced.config,
  );
});

test('without CSP_REPORT_ORIGIN there are no report directives and no Reporting-Endpoints', () => {
  for (const origin of [undefined, '']) {
    const rendered = render({ ...REQUIRED, CSP_REPORT_ORIGIN: origin });
    assert.equal(rendered.status, 0, rendered.stderr);
    const policy = pagePolicy(rendered.config);
    assert.doesNotMatch(policy, /report-uri|report-to/);
    assert.ok(policy.endsWith('; upgrade-insecure-requests'));
    // An empty add_header value is not sent by nginx
    assert.ok(rendered.config.includes("    add_header Reporting-Endpoints '' always;\n"));
    // The receiver is off: /csp-report answers 404 before anything else
    assert.ok(rendered.config.includes('        set $bifrost_csp_receiver off;\n'));
  }
});

test('CSP_REPORT_ORIGIN turns reporting on, at the dashboard origin', () => {
  const rendered = render({ ...REQUIRED, CSP_REPORT_ORIGIN: 'HTTPS://Dashboard.Example.com/' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const policy = pagePolicy(rendered.config);
  assert.ok(
    policy.endsWith('; upgrade-insecure-requests; report-uri /csp-report; report-to csp-report'),
  );
  assert.ok(
    rendered.config.includes(
      `    add_header Reporting-Endpoints 'csp-report="${DASHBOARD}/csp-report"' always;\n`,
    ),
  );
  // The receiver is on
  assert.ok(rendered.config.includes('        set $bifrost_csp_receiver on;\n'));
});

// v1.40.0: one internal-header rule, in @bifrost/shared, for the Worker, the
// dev proxy and nginx. Read from the source (no build needed): every header
// the deployment itself uses is one the rule names, and nginx's /api proxy
// replaces each with its own value or none, so a client's copy never reaches
// the Worker.
test('nginx, the dev proxy and the Worker share one internal-header rule', () => {
  const rule = readFileSync('shared/src/internal-headers.ts', 'utf8');
  const list = name => {
    const body = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(rule)?.[1];
    assert.ok(body, name);
    return [...body.matchAll(/'([^']+)'/g)].map(match => match[1]);
  };
  const names = list('INTERNAL_HEADER_NAMES');
  const prefixes = list('INTERNAL_HEADER_PREFIXES');
  const known = list('KNOWN_INTERNAL_HEADERS');
  assert.deepEqual(names, ['x-admin-key']);
  assert.deepEqual(prefixes, ['x-bifrost-', 'tailscale-user-']);
  const internal = header => {
    const lower = header.toLowerCase();
    return names.includes(lower) || prefixes.some(prefix => lower.startsWith(prefix));
  };
  for (const header of known) assert.ok(internal(header), header);

  // Every known internal header is set in the /api location (the admin key
  // by the renderer's include), and every header nginx sets there by an
  // internal name is a known one
  const body = locationBody(template, API_LOCATION);
  const rendered = render(REQUIRED);
  assert.equal(rendered.status, 0, rendered.stderr);
  const set = [...`${body}\n${rendered.key}`.matchAll(/proxy_set_header ([\w-]+) /g)].map(
    match => match[1],
  );
  for (const header of known) assert.ok(set.includes(header), `nginx sets ${header}`);
  for (const header of set.filter(internal)) assert.ok(known.includes(header), header);
  // A header nginx reads from the client by an internal name feeds only the
  // maps that replace it (the cross-site check and the Serve identity)
  for (const [, variable] of template.matchAll(/\$http_(\w+)/g)) {
    const header = variable.replaceAll('_', '-');
    if (!internal(header)) continue;
    assert.ok(
      known.some(name => name.toLowerCase() === header),
      `nginx reads an unknown internal header ${header}`,
    );
  }

  // The dev proxy and the Worker use the shared rule, with no copy of their own
  for (const file of ['admin/dev-api-proxy.ts', 'src/utils/internal-headers.ts']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /^import \{ isInternalHeader \} from '@bifrost\/shared';$/m, file);
    assert.doesNotMatch(source, /'x-bifrost-'|'tailscale-user-'/, file);
  }
});

test('every API call is proxied to API_PROXY_ORIGIN with the key nginx adds', () => {
  const rendered = render({ ...REQUIRED, API_PROXY_ORIGIN: 'HTTPS://Bifrost.Example.com/' });
  assert.equal(rendered.status, 0, rendered.stderr);
  // The browser talks only to the dashboard
  assert.equal(directive(pagePolicy(rendered.config), 'connect-src'), "'self'");
  assert.ok(rendered.config.includes('    set $bifrost_api_host "bifrost.example.com";\n'));
  assert.ok(rendered.config.includes('    resolver 1.1.1.1 1.0.0.1 valid=300s ipv6=off;\n'));
  // The key: in the root-only include, never in the config itself, and the
  // include sits in the /api proxy location only
  assert.equal(rendered.key, `proxy_set_header X-Admin-Key "${KEY}";\n`);
  assert.equal(rendered.keyMode, 0o600);
  assert.equal(rendered.config.includes(KEY), false);
  const includes = locationBlocks(rendered.config).filter(({ body }) =>
    body.includes(`include ${KEY_FILE};`),
  );
  assert.deepEqual(
    includes.map(({ head }) => head),
    [API_LOCATION],
  );
  assert.equal(rendered.config.split(`include ${KEY_FILE};`).length, 2);
  // The renderer prints nothing, the key least of all
  assert.equal(rendered.stdout, '');
  assert.equal(rendered.stderr, '');
  assert.doesNotMatch(rendered.config, /__[A-Z_]+__/);
  assert.equal(rendered.tmpLeft, false);
});

test('DASHBOARD_HOSTNAMES and DASHBOARD_LISTEN_ADDRESS shape the two servers', () => {
  const defaults = render(REQUIRED);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.ok(defaults.config.includes('    listen 0.0.0.0:3001 default_server;\n'));
  assert.ok(
    defaults.config.includes('    listen 0.0.0.0:3001;\n    server_name localhost 127.0.0.1;\n'),
  );
  const named = render({
    ...REQUIRED,
    DASHBOARD_HOSTNAMES: ' Dashboard.Example.com. bifrost.your-tailnet.ts.net ',
    DASHBOARD_LISTEN_ADDRESS: '127.0.0.1',
  });
  assert.equal(named.status, 0, named.stderr);
  assert.ok(named.config.includes('    listen 127.0.0.1:3001 default_server;\n'));
  assert.ok(
    named.config.includes(
      '    listen 127.0.0.1:3001;\n    server_name localhost 127.0.0.1 dashboard.example.com bifrost.your-tailnet.ts.net;\n',
    ),
  );
  // Single-label names: a LAN host, a Docker or Kubernetes service name
  const single = render({
    ...REQUIRED,
    DASHBOARD_HOSTNAMES: 'homeserver Bifrost-Dashboard dashboard.',
  });
  assert.equal(single.status, 0, single.stderr);
  assert.ok(
    single.config.includes(
      '    server_name localhost 127.0.0.1 homeserver bifrost-dashboard dashboard;\n',
    ),
  );
});

test('DASHBOARD_TAILSCALE_SERVE=on: a Unix socket only, and Serve\u2019s headers trusted', () => {
  const off = render(REQUIRED);
  assert.equal(off.status, 0, off.stderr);
  for (const value of ['', 'off']) {
    const same = render({ ...REQUIRED, DASHBOARD_TAILSCALE_SERVE: value });
    assert.equal(same.config, off.config, JSON.stringify(value));
  }
  for (const name of [
    'bifrost_tailscale_user_login',
    'bifrost_tailscale_user_name',
    'bifrost_tailscale_user_profile_pic',
    'bifrost_request_host',
  ]) {
    assert.equal(mapEntries(off.config, name).source, 'off', name);
  }
  assert.equal(mapValue(off.config, 'bifrost_tailscale_user_login', 'off'), '');
  assert.equal(mapValue(off.config, 'bifrost_request_host', 'off'), '$http_host');

  const on = render({ ...REQUIRED, DASHBOARD_TAILSCALE_SERVE: 'on' });
  assert.equal(on.status, 0, on.stderr);
  assert.equal(
    mapValue(
      on.config,
      'bifrost_tailscale_user_login',
      mapEntries(on.config, 'bifrost_tailscale_user_login').source,
    ),
    '$http_tailscale_user_login',
  );
  assert.equal(
    mapValue(
      on.config,
      'bifrost_request_host',
      mapEntries(on.config, 'bifrost_request_host').source,
    ),
    '$http_x_forwarded_host',
  );
  // No TCP listener at all: tailscaled's userspace networking hands a tailnet
  // connection to any port of the node to 127.0.0.1:<port>
  assert.deepEqual(
    [...on.config.matchAll(/^\s*listen (.*);$/gm)].map(match => match[1]),
    [`unix:${SERVE_SOCKET} default_server`, `unix:${SERVE_SOCKET}`],
  );
  // Only the listen lines and the four maps differ from the plain render
  assert.equal(
    on.config
      .replaceAll(`listen unix:${SERVE_SOCKET}`, 'listen 0.0.0.0:3001')
      .replaceAll('map "on" $bifrost_', 'map "off" $bifrost_'),
    off.config,
  );
});

test('the :tailscale image reaches nginx through Serve and a root-only socket only', () => {
  const dockerfile = readFileSync('admin/Dockerfile.tailscale', 'utf8');
  assert.match(dockerfile, /^ENV DASHBOARD_TAILSCALE_SERVE=on$/m);
  assert.doesNotMatch(dockerfile, /DASHBOARD_LISTEN_ADDRESS|^EXPOSE /m);
  const script = readFileSync('admin/scripts/start-with-tailscale.sh', 'utf8');
  const lines = script.split('\n');
  const at = line => {
    const index = lines.indexOf(line);
    assert.ok(index > 0, line);
    return index;
  };
  // The socket directory is made root-only, and a stale socket removed,
  // after the render and before tailscaled, Serve or nginx start
  const rendered = lines.findIndex(line => line.startsWith('/usr/local/bin/render-nginx-conf.sh '));
  const prepared = [
    at('mkdir -p /run/bifrost'),
    at('chown root:root /run/bifrost'),
    at('chmod 700 /run/bifrost'),
    at(`rm -f ${SERVE_SOCKET}`),
  ];
  assert.deepEqual(
    prepared.toSorted((a, b) => a - b),
    prepared,
  );
  assert.ok(rendered < prepared[0]);
  assert.ok(prepared[3] < lines.findIndex(line => line.startsWith('tailscaled ')));
  assert.ok(prepared[3] < lines.findIndex(line => /^(exec )?nginx\b/.test(line)));
  assert.ok(at(`tailscale serve --bg --https=443 unix:${SERVE_SOCKET}`) > prepared[3]);
  assert.doesNotMatch(script, /127\.0\.0\.1:3001|http:\/\/127/);
  // The healthcheck asks nginx over the socket, and an image from before the
  // socket (a rollback to an earlier tag with this compose file) over TCP
  const compose = readFileSync('admin/docker-compose.tailscale.yml', 'utf8');
  assert.ok(
    compose.includes(
      `test: ["CMD-SHELL", "if [ -S ${SERVE_SOCKET} ]; then curl -fsS -o /dev/null --unix-socket ${SERVE_SOCKET} http://localhost/health; else curl -fsS -o /dev/null http://127.0.0.1:3001/health; fi"]`,
    ),
  );
  // The plain image never trusts Serve's headers
  assert.doesNotMatch(readFileSync('admin/Dockerfile', 'utf8'), /DASHBOARD_TAILSCALE_SERVE/);
  for (const file of ['admin/docker-compose.yml', 'admin/docker-compose.prod.yml']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /DASHBOARD_TAILSCALE_SERVE/, file);
  }
});

test('API_PROXY_RESOLVER replaces the default resolvers', () => {
  const rendered = render({ ...REQUIRED, API_PROXY_RESOLVER: ' 127.0.0.11\t10.0.0.2 ' });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.ok(rendered.config.includes('    resolver 127.0.0.11 10.0.0.2 valid=300s ipv6=off;\n'));
});

test('without R2_PREVIEW_ORIGINS the CSP keeps object-src none and frame-src self', () => {
  for (const origins of [undefined, '', '  \t ']) {
    const rendered = render({ ...REQUIRED, R2_PREVIEW_ORIGINS: origins });
    assert.equal(rendered.status, 0, rendered.stderr);
    const policy = pagePolicy(rendered.config);
    assert.equal(directive(policy, 'object-src'), "'none'");
    assert.equal(directive(policy, 'frame-src'), "'self'");
    assert.equal(directive(policy, 'img-src'), "'self' data: blob: https:");
    assert.doesNotMatch(rendered.config, /__[A-Z_]+__/);
    assert.equal(rendered.tmpLeft, false);
  }
});

test('R2_PREVIEW_ORIGINS adds the R2 origins to object-src and frame-src and nothing else', () => {
  const rendered = render({
    ...REQUIRED,
    CSP_REPORT_ORIGIN: DASHBOARD,
    R2_PREVIEW_ORIGINS: 'https://files.example.com   HTTPS://Assets.Example.com:8443/',
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const origins = 'https://files.example.com https://assets.example.com:8443';
  assert.equal(
    rendered.config,
    template
      .replaceAll('__CSP_HEADER__', 'Content-Security-Policy')
      .replaceAll('__CSP_OBJECT_SRC__', origins)
      .replaceAll('__CSP_PREVIEW_ORIGINS__', ` ${origins}`)
      .replaceAll('__CSP_REPORTING__', '; report-uri /csp-report; report-to csp-report')
      .replaceAll('__CSP_REPORTING_ENDPOINTS__', `csp-report="${DASHBOARD}/csp-report"`)
      .replaceAll('__CSP_RECEIVER__', 'on')
      .replaceAll('__API_PROXY_HOST__', 'bifrost.example.com')
      .replaceAll('__API_PROXY_RESOLVER__', '1.1.1.1 1.0.0.1')
      .replaceAll('__ADMIN_KEY_INCLUDE__', KEY_FILE)
      .replaceAll('__DASHBOARD_HOSTNAMES__', '')
      .replaceAll('__LISTEN__', '0.0.0.0:3001')
      .replaceAll('__TAILSCALE_SERVE__', 'off'),
  );
  assert.equal(rendered.tmpLeft, false);
});

test('a bad or missing value is refused, writing nothing and keeping the previous config', () => {
  const cases = [
    [{ CSP_MODE: 'Enforce' }, /CSP_MODE 'Enforce' must be/],
    [{ CSP_MODE: 'report_only' }, /must be enforce or report-only/],
    [{ CSP_MODE: 'off' }, /must be enforce or report-only/],
    [
      { CSP_REPORT_ORIGIN: 'http://dashboard.example.com' },
      /CSP_REPORT_ORIGIN .* not an https origin/,
    ],
    [{ CSP_REPORT_ORIGIN: `${DASHBOARD}/csp-report` }, /CSP_REPORT_ORIGIN .* not an https origin/],
    [{ CSP_REPORT_ORIGIN: `${DASHBOARD}' always; add_header X '1` }, /not an https origin/],
    [{ CSP_REPORT_ORIGIN: WORKER }, /must not be the dashboard itself/],
    // A port on the report origin names the same server
    [{ CSP_REPORT_ORIGIN: `${WORKER}:443` }, /must not be the dashboard itself/],
    [{ CSP_REPORT_ORIGIN: 'https://BIFROST.example.com:8443' }, /must not be the dashboard itself/],
    [{ API_PROXY_ORIGIN: undefined }, /API_PROXY_ORIGIN is required/],
    [{ API_PROXY_ORIGIN: '' }, /API_PROXY_ORIGIN is required/],
    [{ API_PROXY_ORIGIN: 'https://bifrost.example.com:8443' }, /must not carry a port/],
    [{ API_PROXY_ORIGIN: 'http://bifrost.example.com' }, /API_PROXY_ORIGIN .* not an https origin/],
    [{ API_PROXY_ORIGIN: `${WORKER}/api` }, /API_PROXY_ORIGIN .* not an https origin/],
    [{ API_PROXY_ORIGIN: `${WORKER}"; proxy_pass http://x` }, /not an https origin/],
    [{ API_PROXY_ORIGIN: 'https://localhost' }, /not an https origin/],
    [{ API_PROXY_RESOLVER: 'resolver.example.com' }, /API_PROXY_RESOLVER entry .* not an IPv4/],
    [{ API_PROXY_RESOLVER: '1.1.1.1; include /etc/passwd' }, /not an IPv4 address/],
    [{ API_PROXY_RESOLVER: '256.1.1.1' }, /not an IPv4 address/],
    [{ API_PROXY_RESOLVER: '2606:4700::1111' }, /not an IPv4 address/],
    [{ API_PROXY_RESOLVER: ' \t ' }, /must name at least one IPv4 address/],
    [
      { DASHBOARD_HOSTNAMES: 'https://dashboard.example.com' },
      /DASHBOARD_HOSTNAMES entry .* not a host name/,
    ],
    [{ DASHBOARD_HOSTNAMES: '*.example.com' }, /not a host name/],
    [{ DASHBOARD_HOSTNAMES: 'dashboard.example.com:3001' }, /not a host name/],
    [{ DASHBOARD_HOSTNAMES: 'dashboard;' }, /not a host name/],
    [{ DASHBOARD_HOSTNAMES: 'dashboard..example.com' }, /not a host name/],
    [{ DASHBOARD_HOSTNAMES: '-dashboard' }, /not a host name/],
    // The /api proxy would call the dashboard itself, with or without reports
    [{ DASHBOARD_HOSTNAMES: 'bifrost.example.com' }, /must not be the dashboard itself/],
    [{ DASHBOARD_HOSTNAMES: 'lan-name Bifrost.Example.com.' }, /must not be the dashboard itself/],
    [
      {
        DASHBOARD_HOSTNAMES: 'dashboard.example.com bifrost.example.com',
        CSP_REPORT_ORIGIN: DASHBOARD,
      },
      /must not be the dashboard itself/,
    ],
    [{ DASHBOARD_LISTEN_ADDRESS: '::' }, /DASHBOARD_LISTEN_ADDRESS .* not an IPv4 address/],
    [{ DASHBOARD_LISTEN_ADDRESS: '0.0.0.0:80' }, /not an IPv4 address/],
    [{ DASHBOARD_TAILSCALE_SERVE: 'ON' }, /DASHBOARD_TAILSCALE_SERVE 'ON' must be on or off/],
    [{ DASHBOARD_TAILSCALE_SERVE: 'true' }, /must be on or off/],
    [
      { DASHBOARD_TAILSCALE_SERVE: 'on', DASHBOARD_LISTEN_ADDRESS: '127.0.0.1' },
      /DASHBOARD_LISTEN_ADDRESS must be unset with DASHBOARD_TAILSCALE_SERVE=on/,
    ],
    // Fail closed without the key: every API call depends on it
    [{ ADMIN_API_KEY: undefined }, /ADMIN_API_KEY is required/],
    [{ ADMIN_API_KEY: '' }, /ADMIN_API_KEY is required/],
    [{ ADMIN_API_KEY: 'key with space' }, /printable non-space ASCII/],
    [{ ADMIN_API_KEY: 'key\twith-tab' }, /printable non-space ASCII/],
    [{ ADMIN_API_KEY: 'key\nsecond-line' }, /must not contain CR or LF/],
    [{ ADMIN_API_KEY: 'trailing-newline\n' }, /must not contain CR or LF/],
    [{ ADMIN_API_KEY: 'carriage\rreturn' }, /must not contain CR or LF/],
    [{ ADMIN_API_KEY: 'non-ascii-é' }, /printable non-space ASCII/],
    // Each would end, escape or interpolate the nginx string
    [{ ADMIN_API_KEY: 'key";add_header=X' }, /double quote, backslash or dollar/],
    [{ ADMIN_API_KEY: 'key"quote' }, /double quote, backslash or dollar/],
    [{ ADMIN_API_KEY: 'back\\slash' }, /double quote, backslash or dollar/],
    [{ ADMIN_API_KEY: 'dollar$remote_addr' }, /double quote, backslash or dollar/],
  ];
  for (const preview of [
    'http://files.example.com',
    'https://files.example.com/pdfs',
    'https://files.example.com?x=1',
    "https://files.example.com; script-src 'unsafe-inline'",
    'https://files.example.com" always; add_header X-Injected "1',
    'https://files.example.com|x',
    'https://files.example.com&x',
    "'unsafe-inline'",
    '*',
    'https://*.example.com',
    'https://localhost',
    'https://files.example.com javascript:alert(1)',
  ]) {
    cases.push([
      { R2_PREVIEW_ORIGINS: preview },
      /R2_PREVIEW_ORIGINS entry .* not an https origin/,
    ]);
  }
  for (const [change, message] of cases) {
    const values = { ...REQUIRED, CSP_REPORT_ORIGIN: DASHBOARD };
    for (const [name, value] of Object.entries(change)) {
      if (value === undefined) delete values[name];
      else values[name] = value;
    }
    const rendered = render(values, 'previous\n');
    const label = JSON.stringify(change);
    assert.notEqual(rendered.status, 0, label);
    assert.match(rendered.stderr, message, label);
    assert.equal(rendered.config, 'previous\n', label);
    assert.equal(rendered.key, 'previous\n', label);
    assert.equal(rendered.tmpLeft, false, label);
    // A refused key is never quoted back
    if (change.ADMIN_API_KEY) assert.equal(rendered.stderr.includes(change.ADMIN_API_KEY), false);
  }
});

// ---------------------------------------------------------------------------
// The two images
// ---------------------------------------------------------------------------

test('both Dockerfiles build an environment-free bundle and serve only the rendered config', () => {
  for (const dockerfile of DOCKERFILES) {
    const source = readFileSync(dockerfile, 'utf8');
    // The bundle takes no build variable, and the key is never a build input
    // nor written into the web root
    assert.doesNotMatch(source, /VITE_|ADMIN_API_KEY=|env-config|write-env-config/, dockerfile);
    assert.doesNotMatch(source, /^ARG /m, dockerfile);
    assert.match(source, /^\s+pnpm run build$|^RUN pnpm run build$/m, dockerfile);
    // Only the rendered config can serve: the stock site is removed and no
    // static nginx config is copied in
    assert.match(source, /^RUN rm -f \/etc\/nginx\/conf\.d\/default\.conf$/m, dockerfile);
    assert.match(
      source,
      /^COPY (--link )?admin\/nginx\.conf\.template \/etc\/nginx\/bifrost\/default\.conf\.template$/m,
      dockerfile,
    );
    assert.match(
      source,
      /^COPY (--link )?admin\/scripts\/render-nginx-conf\.sh \/usr\/local\/bin\/render-nginx-conf\.sh$/m,
      dockerfile,
    );
    assert.doesNotMatch(source, /^COPY .*\/etc\/nginx\/conf\.d\//m, dockerfile);
  }
});

test('every start script renders the config before the network or nginx starts', () => {
  const renderLine =
    '/usr/local/bin/render-nginx-conf.sh /etc/nginx/bifrost/default.conf.template /etc/nginx/conf.d/default.conf /etc/nginx/bifrost/admin-key.conf';
  for (const [script, firstAfter] of [
    [START_SCRIPTS[0], 'exec nginx'],
    [START_SCRIPTS[1], 'tailscaled '],
  ]) {
    const source = readFileSync(script, 'utf8');
    assert.match(source, /^set -e/m, script);
    const lines = source.split('\n');
    const at = lines.indexOf(renderLine);
    assert.ok(at > 0, `${script} does not render the nginx config`);
    assert.ok(
      at < lines.findIndex(line => line.startsWith(firstAfter)),
      `${script} renders after ${firstAfter}`,
    );
    assert.ok(at < lines.findIndex(line => /^(exec )?nginx\b/.test(line)), script);
    // The key reaches only the renderer: no start script writes it anywhere
    // the browser can fetch, or prints it
    assert.doesNotMatch(source, /env-config|window\.__ENV__|\$\{?ADMIN_API_KEY/, script);
  }
});

test('the renderer is executable and is the only writer of the served config', () => {
  assert.ok((spawnSync('test', ['-x', RENDER]).status ?? 1) === 0, `${RENDER} must be executable`);
  const source = readFileSync(RENDER, 'utf8');
  assert.match(source, /^set -eu$/m);
  assert.match(source, /^mv "\$tmp" "\$output"$/m);
  assert.equal(existsSync('admin/scripts/write-env-config.sh'), false);
});

test('the compose files pass the required inputs at run time and publish on loopback only', () => {
  for (const file of ['admin/docker-compose.yml', 'admin/docker-compose.prod.yml']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /- "127\.0\.0\.1:3001:3001"/, file);
    assert.doesNotMatch(source, /- "3001:3001"/, file);
    assert.match(source, /^ {6}API_PROXY_ORIGIN: \$\{API_PROXY_ORIGIN\}$/m, file);
    assert.match(source, /^ {6}ADMIN_API_KEY: \$\{ADMIN_API_KEY\}$/m, file);
    // v1.40.0: nginx and the healthcheck both read it, so a value set in .env
    // must reach the container (an empty one is the renderer's default)
    assert.match(source, /^ {6}DASHBOARD_LISTEN_ADDRESS: \$\{DASHBOARD_LISTEN_ADDRESS:-\}$/m, file);
    assert.doesNotMatch(source, /VITE_|args:/, file);
  }
  const tailscale = readFileSync('admin/docker-compose.tailscale.yml', 'utf8');
  assert.match(tailscale, /API_PROXY_ORIGIN=https:\/\/bifrost\.example\.com/);
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

// ---------------------------------------------------------------------------
// Zod jitless (v1.39.0)
// ---------------------------------------------------------------------------

const ZOD_JITLESS = 'admin/public/zod-jitless.js';

/**
 * Build and parse a nested object schema with the dashboard's Zod in a fresh
 * Node process, counting every `Function` construction or call, after running
 * the jitless script first when `runScriptFirst`.
 */
function inFreshZod(runScriptFirst) {
  const source = `
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    const Real = globalThis.Function;
    let calls = 0;
    globalThis.Function = new Proxy(Real, {
      construct(target, args) { calls += 1; return Reflect.construct(target, args); },
      apply(target, self, args) { calls += 1; return Reflect.apply(target, self, args); },
    });
    if (${JSON.stringify(runScriptFirst)}) {
      vm.runInThisContext(readFileSync(${JSON.stringify(path.resolve(ZOD_JITLESS))}, 'utf8'));
    }
    const { z } = await import('zod');
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    const parsed = schema.parse({ a: 'x', b: { c: 1 } });
    console.log(JSON.stringify({ calls, jitless: z.config().jitless ?? null, parsed }));
  `;
  // The dashboard's own zod (admin/node_modules), the one the bundle carries
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: 'admin',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('index.html loads the Zod jitless script as a classic script before the module entry', () => {
  const html = readFileSync('admin/index.html', 'utf8');
  const scripts = scriptElements(html);
  // The first script carries only its src: no type, so it runs as a classic
  // script, ahead of any module
  assert.deepEqual(scripts[0]?.attrs, [['src', '/zod-jitless.js']]);
  assert.ok(
    scripts.some(({ attrs }) =>
      attrs.some(([name, value]) => name === 'type' && asciiTrim(value).toLowerCase() === 'module'),
    ),
  );
  assert.ok(existsSync(ZOD_JITLESS));
});

test('a fresh Zod adopts the jitless script: building and parsing objects evaluates no code', () => {
  assert.deepEqual(inFreshZod(true), { calls: 0, jitless: true, parsed: { a: 'x', b: { c: 1 } } });
  // Control: without the script, Zod probes Function when an object schema is
  // built, which the CSP reports as a script-src eval violation
  const control = inFreshZod(false);
  assert.equal(control.jitless, null);
  assert.ok(control.calls > 0);
});

// ---------------------------------------------------------------------------
// The admin key stays out of the browser (v1.39.0)
// ---------------------------------------------------------------------------

test('no dashboard source sends the admin key or reads a build-time variable', () => {
  const sources = readdirSync('admin/src', { recursive: true })
    .map(file => path.join('admin/src', String(file)))
    .filter(file => /\.(?:ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter(file => statSync(file).isFile());
  assert.ok(sources.length > 50);
  for (const file of sources) {
    // Code only: a comment may name what the code no longer does
    const source = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /['"]X-Admin-Key['"]\s*[:,]/, file);
    assert.doesNotMatch(source, /import\.meta\.env\.VITE_|VITE_ADMIN_API_KEY|__ENV__/, file);
  }
  const html = readFileSync('admin/index.html', 'utf8');
  assert.doesNotMatch(html, /env-config/);
});

test('a production build carries no admin key, even with the dev proxy settings set', () => {
  // The key arrives through the process environment, which Vite reads with
  // the highest precedence, so no admin/.env.local is written or needed. A
  // build of this kind is what `pnpm -C admin build` does in CI and the image.
  const dir = mkdtempSync(path.join(tmpdir(), 'bifrost-dist-'));
  const key = `synthetic-admin-key-${process.pid}-q7z`;
  const apiUrl = `https://api-${process.pid}.example.com`;
  try {
    const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], {
      cwd: 'admin',
      env: {
        ...process.env,
        DASHBOARD_DEV_ADMIN_API_KEY: key,
        DASHBOARD_DEV_API_URL: apiUrl,
        // The old names too: nothing may read them any more
        VITE_ADMIN_API_KEY: key,
        VITE_API_URL: apiUrl,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(dir, { recursive: true })
      .map(file => path.join(dir, String(file)))
      .filter(file => statSync(file).isFile());
    const bundle = files.map(file => readFileSync(file, 'utf8')).join('\n');
    // Control: this is the real bundle (the version Vite defines is in it, and
    // the dashboard header every API call sends)
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.ok(bundle.includes(version), 'control: the build did not produce the dashboard');
    assert.ok(bundle.includes('X-Bifrost-Dashboard'), 'control: no dashboard request header');
    assert.equal(bundle.includes(key), false, 'the dev admin key reached the production bundle');
    assert.equal(bundle.includes(apiUrl), false, 'the dev API URL reached the production bundle');
    assert.equal(
      files.some(file => file.endsWith('env-config.js')),
      false,
    );
    assert.ok(files.some(file => file.endsWith('zod-jitless.js')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('request logs do not persist configured route targets', () => {
  const worker = readFileSync('src/index.ts', 'utf8');
  assert.doesNotMatch(worker, /target:\s*route\.target/);
});

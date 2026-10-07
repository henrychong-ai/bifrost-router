/**
 * Small readers for the dashboard nginx template (v1.39.0), used by
 * scripts/check-dashboard-security.test.mjs.
 */

/**
 * `config` with comments removed and every quoted string emptied (its quotes
 * kept), so braces and directive names inside a string, such as the JSON body
 * of `return 200 '{"status":"ok"}'`, are not read as config syntax.
 */
export function stripCommentsAndStrings(config) {
  let out = '';
  let i = 0;
  while (i < config.length) {
    const char = config[i];
    if (char === '#') {
      while (i < config.length && config[i] !== '\n') i += 1;
    } else if (char === '"' || char === "'") {
      i += 1;
      while (i < config.length && config[i] !== char) i += config[i] === '\\' ? 2 : 1;
      if (i >= config.length) throw new Error('unterminated quoted string');
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
export function locationBlocks(config) {
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
    if (depth !== 0) throw new Error(`unterminated ${match[0].trim()}`);
    blocks.push({ head: match[0].trim(), body: text.slice(start, end - 1) });
  }
  return blocks;
}

/**
 * The heads of the locations that set their own add_header. nginx drops every
 * server-level add_header in such a location, so its responses would lose the
 * CSP and the other security headers.
 */
export function locationsWithAddHeader(config) {
  return locationBlocks(config)
    .filter(({ body }) => /\badd_header\b/.test(body))
    .map(({ head }) => head);
}

/**
 * The server-level `add_header NAME VALUE [always];` lines as
 * [name, value, always] triples (value unquoted), in order. Only the
 * four-space-indented server body is read, never a location.
 */
export function serverHeaders(config) {
  return [
    ...config.matchAll(/^ {4}add_header (\S+) (?:"([^"]*)"|'([^']*)'|(\S+))( always)?;$/gm),
  ].map(match => [match[1], match[2] ?? match[3] ?? match[4], match[5] === ' always']);
}

const MAP_TOKEN = String.raw`("(?:[^"\\]|\\.)*"|\S+)`;

/** A map token without its double quotes. */
function unquote(token) {
  return token.startsWith('"') ? token.slice(1, -1) : token;
}

/**
 * The entries of the `map SOURCE $NAME { ... }` block as [key, value] pairs
 * (both unquoted), in order, with its source; throws if there is not exactly
 * one such map.
 */
export function mapEntries(config, name) {
  const blocks = [
    ...config.matchAll(
      new RegExp(String.raw`^map (\S+|"[^"]*") \$${name} \{\n([\s\S]*?)\n\}$`, 'gm'),
    ),
  ];
  if (blocks.length !== 1) throw new Error(`expected one map $${name}, found ${blocks.length}`);
  const entries = blocks[0][2]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const match = new RegExp(String.raw`^${MAP_TOKEN}\s+${MAP_TOKEN};$`).exec(line);
      if (!match) throw new Error(`unreadable map line: ${line}`);
      return [unquote(match[1]), unquote(match[2])];
    });
  return { source: unquote(blocks[0][1]), entries };
}

/**
 * The value the `map ... $NAME` block gives `input`, as nginx picks it: an
 * exact key first, then the regular expressions in order (`~` case-sensitive,
 * `~*` not), then `default` (empty when the map has none). A value naming a
 * variable is returned as written. The patterns used here read the same in
 * PCRE and JavaScript.
 */
export function mapValue(config, name, input) {
  const { entries } = mapEntries(config, name);
  const exact = entries.find(([key]) => !key.startsWith('~') && key !== 'default' && key === input);
  if (exact) return exact[1];
  for (const [key, value] of entries) {
    if (!key.startsWith('~')) continue;
    const insensitive = key.startsWith('~*');
    if (new RegExp(key.slice(insensitive ? 2 : 1), insensitive ? 'i' : '').test(input))
      return value;
  }
  return entries.find(([key]) => key === 'default')?.[1] ?? '';
}

/** The page policy: the default of the $bifrost_page_csp map. */
export function pagePolicy(config) {
  const defaults = mapEntries(config, 'bifrost_page_csp').entries.filter(
    ([key]) => key === 'default',
  );
  if (defaults.length !== 1) throw new Error('the page policy map has no single default');
  return defaults[0][1];
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The Slack bot is deprecated and kept only for a possible revival (AGENTS.md,
// "Deprecated: Slack bot"). These checks keep it from being deployed by accident.

const wranglerToml = readFileSync('slackbot/wrangler.toml', 'utf8');
const scripts = JSON.parse(readFileSync('slackbot/package.json', 'utf8')).scripts;

/** The `key = value` lines of one TOML table, or of the top level for `null`. */
function tableLines(toml, table) {
  const lines = [];
  let current = null;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current === table) lines.push(line);
  }
  return lines;
}

test('the Slack bot config is marked deprecated', () => {
  assert.match(wranglerToml, /^# DEPRECATED:/m);
});

for (const table of [null, 'env.dev']) {
  test(`workers.dev is off for the ${table ?? 'production'} Slack bot`, () => {
    const lines = tableLines(wranglerToml, table);
    assert.ok(lines.some(line => /^\s*workers_dev\s*=\s*false\s*$/.test(line)));
    assert.ok(!lines.some(line => /^\s*workers_dev\s*=\s*true\s*$/.test(line)));
  });
}

test('the Slack bot binds only placeholder KV and D1 IDs', () => {
  const ids = [...wranglerToml.matchAll(/^\s*(?:id|preview_id|database_id)\s*=\s*"([^"]*)"/gm)];
  assert.ok(ids.length > 0);
  for (const [, value] of ids) assert.match(value, /^your-/);
});

for (const name of ['deploy', 'deploy:dev']) {
  test(`slackbot ${name} refuses with the deprecation message`, () => {
    assert.doesNotMatch(scripts[name], /wrangler/);
    const run = spawnSync(scripts[name], { cwd: 'slackbot', shell: true, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Slack bot is deprecated/);
  });
}

/**
 * Migration 0012 replay gate (v1.34.0).
 *
 * `wrangler d1 execute --file` exits 0 and reports success on a file it could
 * not parse — a header line that lost its `-- ` prefix collapses the whole file
 * and the apply executes ZERO statements while reporting success. The written
 * defence has been "re-prove it on a fresh local D1 by hand after any edit",
 * which only works if someone remembers. This runs that proof on every
 * `pnpm run test:gates`.
 *
 * The STATEMENT COUNT is not the defence against a lost `-- ` prefix, and must
 * not be described as one: a file whose first header line loses its prefix
 * still yields the same number of statements — the orphaned prose is simply
 * glued onto the leading `DROP INDEX`. The real defence is that the replay
 * EXECUTES every statement, so a malformed one throws. The count is kept as a
 * cheap structural guard (a statement added or dropped), and `statements[0]` is
 * pinned to `DROP INDEX`, which IS a genuine discriminator for exactly this
 * corruption.
 *
 * It asserts the things a silent no-op or a bad edit would break:
 *   - the file still splits into 7 statements, the first of them `DROP INDEX`,
 *   - every statement executes against a real SQLite (a malformed one throws),
 *   - the rewritten column is `INTEGER NOT NULL DEFAULT 3` and lands LAST,
 *   - `severity` is gone, and nothing in `sqlite_master` referenced it,
 *   - `idx_feedback_priority` survives the drop/rename and points at `priority`,
 *   - the value mapping: 0/new -> 3, 0/resolved -> 3, 1 -> 1, 2 -> 2, 3 -> 3, 4 -> 3,
 *   - the non-vacuity check — that a MANGLED comment prefix actually fails,
 *   - and the one-shot property — a second apply demotes a deliberate P0 to P3.
 *
 * The pre-migration table is built from the repo's own `drizzle/0009_feedback.sql`
 * rather than a hand-copied DDL, so the fixture cannot drift from the real
 * migration chain (0010 and 0011 do not touch `feedback`).
 *
 * `node:sqlite` is unflagged on Node 24, which `engines` pins — no new
 * dependency and no wrangler subprocess. Splitting uses wrangler's own
 * `unstable_splitSqlQuery` so the gate counts statements the same way the real
 * apply does, with a comment-aware fallback if that export moves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = resolve(repoRoot, 'drizzle/0012_feedback_priority_scale.sql');
const BASE_MIGRATION_PATH = resolve(repoRoot, 'drizzle/0009_feedback.sql');
const EXPECTED_STATEMENTS = 7;

/** Strip `--` comments and split on `;` — the fallback if wrangler's export moves. */
function fallbackSplit(sql) {
  return sql
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
    .map(statement => `${statement};`);
}

async function splitStatements(sql) {
  try {
    const { unstable_splitSqlQuery: split } = await import('wrangler');
    if (typeof split === 'function') {
      const parts = split(sql)
        .map(s => s.trim())
        .filter(Boolean);
      if (parts.length > 0) return parts;
    }
  } catch {
    /* fall through to the local splitter */
  }
  return fallbackSplit(sql);
}

/** The real pre-0012 feedback table + counters + indexes, from migration 0009. */
async function seedOldSchema(db) {
  for (const statement of await splitStatements(readFileSync(BASE_MIGRATION_PATH, 'utf8'))) {
    db.exec(statement);
  }
  // One row per old level, plus the two meanings a stored 0 could carry.
  const rows = [
    ['F-1', 0, 'new'],
    ['F-2', 0, 'resolved'],
    ['F-3', 1, 'triaged'],
    ['F-4', 2, 'triaged'],
    ['F-5', 3, 'triaged'],
    ['F-6', 4, 'triaged'],
  ];
  const insert = db.prepare(
    `INSERT INTO feedback (id, short_id, type, severity, priority, status, title, description, context_json, created_at, updated_at)
     VALUES (?, ?, 'bug', 'high', ?, ?, 't', 'd', '{}', 't', 't')`,
  );
  for (const [shortId, priority, status] of rows) {
    insert.run(shortId.toLowerCase(), shortId, priority, status);
  }
}

test('migration 0012 replays cleanly, remaps every old priority level, and drops severity', async () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const statements = await splitStatements(sql);

  // Structural guard only — see the header: a lost `-- ` prefix does NOT change
  // this count. What catches that corruption is the execution below (a malformed
  // statement throws) plus the `DROP INDEX` pin on the first statement, which a
  // glued-on comment block does break.
  assert.equal(
    statements.length,
    EXPECTED_STATEMENTS,
    `expected ${EXPECTED_STATEMENTS} statements, got ${statements.length}`,
  );
  assert.match(
    statements[0],
    /^DROP INDEX/,
    'the first statement must be the DROP INDEX, not prose glued on by a lost `-- ` prefix',
  );

  const db = new DatabaseSync(':memory:');
  try {
    await seedOldSchema(db);

    // Pre-migration shape, so the assertions below are proving a CHANGE.
    const before = db
      .prepare(`SELECT * FROM pragma_table_info('feedback')`)
      .all()
      .find(column => column.name === 'priority');
    assert.equal(String(before.dflt_value), '0', 'the 0009 column defaults to 0');

    // Nothing but the table itself may mention `severity` — an index, trigger,
    // or view that referenced it would make the DROP COLUMN fail.
    const dependants = db
      .prepare(`SELECT name, type, sql FROM sqlite_master WHERE type IN ('index','trigger','view')`)
      .all()
      .filter(object => object.sql && /severity/i.test(object.sql));
    assert.deepEqual(dependants, [], 'no index/trigger/view may reference severity');

    for (const statement of statements) db.exec(statement);

    const columns = db.prepare(`SELECT * FROM pragma_table_info('feedback')`).all();
    const priority = columns.find(column => column.name === 'priority');
    assert.ok(priority, 'priority column missing after the migration');
    assert.equal(priority.type, 'INTEGER');
    assert.equal(priority.notnull, 1, 'priority must stay NOT NULL');
    assert.equal(String(priority.dflt_value), '3', 'priority default must be 3 (P3 - Routine)');
    assert.equal(
      columns.at(-1).name,
      'priority',
      'the rebuilt column lands last — test DDL fixtures mirror this',
    );
    assert.ok(
      !columns.some(column => column.name === 'priority_next'),
      'the temporary priority_next column must be gone',
    );
    assert.ok(
      !columns.some(column => column.name === 'severity'),
      'severity must be dropped — priority is the single urgency axis',
    );

    const index = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get('idx_feedback_priority');
    assert.ok(index, 'idx_feedback_priority must be recreated');
    assert.match(index.sql, /\(\s*priority\s*\)/, 'the index must point at the renamed column');

    const mapped = db
      .prepare('SELECT short_id, status, priority FROM feedback ORDER BY short_id')
      .all()
      .map(row => [row.short_id, row.priority]);
    assert.deepEqual(mapped, [
      ['F-1', 3], // 0 on an untriaged row -> the new default
      ['F-2', 3], // 0 on a triaged row -> also 3: a stored 0 was the old DEFAULT,
      //             so it is not evidence anyone chose "none", and carrying it
      //             across would silently promote the row to P0.
      ['F-3', 1],
      ['F-4', 2],
      ['F-5', 3],
      ['F-6', 3], // legacy 4 ("low") -> P3 Routine
    ]);

    // The new default is what an INSERT that omits priority actually gets.
    db.exec(
      `INSERT INTO feedback (id, short_id, type, status, title, description, context_json, created_at, updated_at)
       VALUES ('f-7', 'F-7', 'bug', 'new', 't', 'd', '{}', 't', 't')`,
    );
    assert.equal(
      db.prepare(`SELECT priority FROM feedback WHERE short_id = 'F-7'`).get().priority,
      3,
    );
  } finally {
    db.close();
  }
});

test('the gate is not vacuous: a mangled comment prefix fails the replay', async () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const firstLine = sql.split('\n')[0];
  assert.ok(firstLine.startsWith('-- '), 'the header must start with a comment prefix');
  // Exactly the edit the header warns about: one header line loses its `-- `.
  const mangled = sql.replace(firstLine, firstLine.slice(3));
  assert.notEqual(mangled, sql);

  const statements = await splitStatements(mangled);
  // The split still yields the same statement count — the orphaned prose is
  // glued onto the leading DROP INDEX rather than collapsing the file. This is
  // why the count is not the defence; the execution below is.
  const db = new DatabaseSync(':memory:');
  let threw = false;
  try {
    await seedOldSchema(db);
    for (const statement of statements) db.exec(statement);
  } catch {
    threw = true;
  } finally {
    db.close();
  }
  assert.ok(
    threw,
    'a header line without its comment prefix must throw on execution, not pass silently',
  );
  // The DROP INDEX pin in the main test catches the same corruption structurally.
  assert.doesNotMatch(
    statements[0],
    /^DROP INDEX/,
    'the mangled first statement must no longer be a bare DROP INDEX',
  );
});

test('migration 0012 is one-shot: a second apply demotes a deliberate P0 to P3', async () => {
  // The rescale statements LOOK replay-safe (DROP INDEX IF EXISTS / CREATE INDEX
  // IF NOT EXISTS, and after a successful apply `priority_next` is gone so ADD
  // COLUMN succeeds again), which is what makes an accidental second run
  // plausible. This template applies migrations file by file with
  // `wrangler d1 execute --file` and keeps no `d1_migrations` ledger, so nothing
  // mechanical stops one.
  //
  // This pins the damage as a KNOWN, TESTED property rather than a prose
  // warning: on the second pass the CASE arm fires again, and a `0` that is now
  // a DELIBERATE P0 Mission-critical is silently mapped down to P3 Routine. The
  // final DROP COLUMN then fails on the already-dropped `severity` — AFTER the
  // demotion is committed, so the error is a receipt, not a guard.
  const statements = await splitStatements(readFileSync(MIGRATION_PATH, 'utf8'));
  const db = new DatabaseSync(':memory:');
  try {
    await seedOldSchema(db);
    for (const statement of statements) db.exec(statement);

    // Triage raises F-3 to the new top level. On the new scale this 0 is a
    // decision, not the old ambiguous default.
    db.exec(`UPDATE feedback SET priority = 0 WHERE short_id = 'F-3'`);
    assert.equal(
      db.prepare(`SELECT priority FROM feedback WHERE short_id = 'F-3'`).get().priority,
      0,
    );

    // The accidental re-run.
    let replayError = null;
    try {
      for (const statement of statements) db.exec(statement);
    } catch (error) {
      replayError = error;
    }

    assert.equal(
      db.prepare(`SELECT priority FROM feedback WHERE short_id = 'F-3'`).get().priority,
      3,
      'a replay silently demotes a deliberate P0 — this is why 0012 is one-shot',
    );
    assert.ok(
      replayError,
      'the replay does fail eventually (severity is already gone) — but only after the damage',
    );
    assert.match(String(replayError.message), /severity/i);
    assert.equal(
      String(
        db
          .prepare(`SELECT * FROM pragma_table_info('feedback')`)
          .all()
          .find(column => column.name === 'priority').dflt_value,
      ),
      '3',
      'the rescale half of the replay completes cleanly, leaving no signal it did damage',
    );
  } finally {
    db.close();
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * The two React effect rules stay on for the whole workspace (v1.47.0),
 * named at `error` in `.oxlintrc.json` (their categories would turn them on
 * anyway: `react/set-state-in-effect` is a correctness rule and
 * `react/exhaustive-effect-dependencies` a suspicious one). Neither may be
 * switched off, in the top-level rules or in any override, so a new effect
 * that sets state synchronously or misses a dependency is flagged everywhere.
 */
const config = JSON.parse(readFileSync(new URL('../.oxlintrc.json', import.meta.url), 'utf8'));
const RULES = ['react/set-state-in-effect', 'react/exhaustive-effect-dependencies'];

/** A rule setting's level: the string itself, or the first entry of an array form. */
const level = setting => (Array.isArray(setting) ? setting[0] : setting);
const isOff = setting => setting !== undefined && ['off', 0, 'allow'].includes(level(setting));

describe('the React effect lint rules', () => {
  test('the react plugin is on', () => {
    assert.ok(config.plugins.includes('react'));
  });

  test('their categories fail the lint', () => {
    assert.equal(config.categories.correctness, 'error');
    assert.ok(['warn', 'error'].includes(config.categories.suspicious));
  });

  for (const rule of RULES) {
    test(`${rule} is named at error`, () => {
      assert.equal(level(config.rules[rule]), 'error');
    });

    test(`${rule} is not switched off, at the top level or in an override`, () => {
      assert.equal(isOff(config.rules[rule]), false);
      for (const override of config.overrides ?? []) {
        assert.equal(isOff(override.rules?.[rule]), false, override.files.join(', '));
      }
    });
  }
});

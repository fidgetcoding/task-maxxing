#!/usr/bin/env node
/**
 * test-areas-config.js
 *
 * Tests src/areas.js in isolation — the degradation paths in particular, since
 * a crash or a silent mis-parse here misfiles every task in the sync.
 * Runs in its own process so it can vary TASKMAXXING_AREAS freely.
 */
'use strict';
const assert = require('node:assert/strict');
const { getAreaConfig, _resetAreaConfig } = require('../src/areas.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  [PASS] ${name}`); pass++; }
  catch (e) { console.log(`  [FAIL] ${name}\n         ${e.message}`); fail++; }
}
function withEnv(value, fn) {
  const prev = process.env.TASKMAXXING_AREAS;
  if (value === undefined) delete process.env.TASKMAXXING_AREAS;
  else process.env.TASKMAXXING_AREAS = value;
  _resetAreaConfig();
  try { fn(); } finally {
    if (prev === undefined) delete process.env.TASKMAXXING_AREAS;
    else process.env.TASKMAXXING_AREAS = prev;
    _resetAreaConfig();
  }
}
const keys = () => Object.keys(getAreaConfig().AREA_TO_FILE);

console.log('\n  src/areas.js\n');

test('unset env → built-in defaults, no crash', () => {
  withEnv(undefined, () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('unset env → SAFE_PATH_RE still builds', () => {
  withEnv(undefined, () => assert.equal(getAreaConfig().SAFE_PATH_RE.test('TASKS-URGENT.md'), true));
});
test('malformed JSON → defaults', () => {
  withEnv('{bad', () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('not an array → defaults', () => {
  withEnv('{"a":1}', () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('missing GENERAL → defaults', () => {
  withEnv(JSON.stringify([{ key: 'X', file: 'TASKS-X.md', morgenLabel: 'X', notionLabel: '01 X' }]),
    () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('duplicate key → defaults', () => {
  withEnv(JSON.stringify([
    { key: 'GENERAL', file: 'a.md', morgenLabel: 'G', notionLabel: '01 G' },
    { key: 'GENERAL', file: 'b.md', morgenLabel: 'G2', notionLabel: '02 G2' },
  ]), () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('traversal in file path → defaults', () => {
  withEnv(JSON.stringify([
    { key: 'GENERAL', file: '../../etc/passwd', morgenLabel: 'G', notionLabel: '01 G' },
  ]), () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('traversal in aliasFiles → defaults', () => {
  withEnv(JSON.stringify([
    { key: 'GENERAL', file: 'TASKS-GENERAL.md', morgenLabel: 'G', notionLabel: '01 G',
      aliasFiles: ['../../etc/passwd'] },
  ]), () => assert.deepEqual(keys(), ['URGENT', 'GENERAL']));
});
test('valid config is applied', () => {
  withEnv(JSON.stringify([
    { key: 'GENERAL', file: 'TASKS-GENERAL.md', morgenLabel: 'General', notionLabel: '02 GENERAL' },
    { key: 'PROJECT-A', file: 'TASKS-PROJECT-A.md', morgenLabel: 'Project-A', notionLabel: '03 PROJECT-A' },
  ]), () => assert.deepEqual(keys(), ['GENERAL', 'PROJECT-A']));
});
test('regex metacharacters in a path are escaped, not interpreted', () => {
  withEnv(JSON.stringify([
    { key: 'GENERAL', file: 'TASKS-GENERAL.md', morgenLabel: 'G', notionLabel: '01 G' },
    { key: 'DOT', file: 'TASKS-a.b.md', morgenLabel: 'Dot', notionLabel: '02 Dot' },
  ]), () => {
    const re = getAreaConfig().SAFE_PATH_RE;
    assert.equal(re.test('TASKS-a.b.md'), true, 'literal path accepted');
    assert.equal(re.test('TASKS-aXb.md'), false, 'dot must not act as a wildcard');
  });
});

console.log(`\n  ${pass} passed · ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

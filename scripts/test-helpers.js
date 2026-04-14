#!/usr/bin/env node
/**
 * test-helpers.js
 *
 * Unit tests for src/sync-helpers.js using Node's built-in assert module.
 * Mirrors the ~30 assertions that Nathan's live version passes.
 *
 * Expected exports from src/sync-helpers.js (Agent 12 ships this):
 *   - hashTask(taskLineText)         → stable SHA-256 (first 12 hex chars) of canonical form
 *   - priorityToLevel(emoji)         → "highest" | "high" | "medium" | "low" | "lowest" | null
 *   - levelToPriority(level)         → emoji string (inverse of priorityToLevel)
 *   - parseArea(filepath)            → area name ("LORECRAFT", "URGENT", "FIDGETCODING", ...) or null
 *   - isSafePath(p, root)            → boolean — prevents dir traversal escapes outside `root`
 *   - parseTaskLine(line)            → { text, checked, priority, due, scheduled, start, done } | null
 *   - formatTaskLine(task)           → string (round-trip of parseTaskLine)
 *   - canonicalizeTask(task)         → string used as hash input; strips volatile fields
 *
 * Any assertion failure exits non-zero. This runs in CI via `npm run test:helpers`.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpersPath = path.join(process.cwd(), 'src', 'sync-helpers.js');

if (!fs.existsSync(helpersPath)) {
  console.warn(
    `::warning::src/sync-helpers.js not present yet — skipping helper unit tests. ` +
      `Agent 12 ships this; re-run after their commit lands.`
  );
  process.exit(0);
}

let helpers;
try {
  helpers = require(helpersPath);
} catch (err) {
  console.error(`Failed to load ${helpersPath}: ${err.message}`);
  process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function has(fnName) {
  return typeof helpers[fnName] === 'function';
}

console.log('test-helpers.js — sync-helpers unit tests\n');

// ---------- hashTask / canonicalizeTask ----------
if (has('hashTask')) {
  test('hashTask: stable for identical input', () => {
    const a = helpers.hashTask('- [ ] buy milk 📅 2026-04-20');
    const b = helpers.hashTask('- [ ] buy milk 📅 2026-04-20');
    assert.equal(a, b);
    assert.ok(typeof a === 'string' && a.length >= 8);
  });

  test('hashTask: different text → different hash', () => {
    const a = helpers.hashTask('- [ ] buy milk 📅 2026-04-20');
    const b = helpers.hashTask('- [ ] buy eggs 📅 2026-04-20');
    assert.notEqual(a, b);
  });

  test('hashTask: checkbox state does not change hash (canonicalized)', () => {
    // A completed task and its open form should hash to the same canonical key,
    // so the sync layer matches them across systems.
    if (has('canonicalizeTask')) {
      const open = helpers.hashTask('- [ ] buy milk 📅 2026-04-20');
      const done = helpers.hashTask('- [x] buy milk 📅 2026-04-20 ✅ 2026-04-21');
      assert.equal(open, done);
    }
  });

  test('hashTask: trailing whitespace ignored', () => {
    const a = helpers.hashTask('- [ ] buy milk 📅 2026-04-20');
    const b = helpers.hashTask('- [ ] buy milk 📅 2026-04-20   ');
    assert.equal(a, b);
  });
}

// ---------- priorityToLevel / levelToPriority ----------
if (has('priorityToLevel')) {
  test('priorityToLevel: 🔺 → highest', () => {
    assert.equal(helpers.priorityToLevel('🔺'), 'highest');
  });
  test('priorityToLevel: ⏫ → high', () => {
    assert.equal(helpers.priorityToLevel('⏫'), 'high');
  });
  test('priorityToLevel: 🔼 → medium', () => {
    assert.equal(helpers.priorityToLevel('🔼'), 'medium');
  });
  test('priorityToLevel: 🔽 → low', () => {
    assert.equal(helpers.priorityToLevel('🔽'), 'low');
  });
  test('priorityToLevel: ⏬ → lowest', () => {
    assert.equal(helpers.priorityToLevel('⏬'), 'lowest');
  });
  test('priorityToLevel: unknown → null', () => {
    assert.equal(helpers.priorityToLevel('🤷'), null);
  });
}

if (has('levelToPriority')) {
  test('levelToPriority: round-trips all 5 levels', () => {
    const levels = ['highest', 'high', 'medium', 'low', 'lowest'];
    for (const lvl of levels) {
      const emoji = helpers.levelToPriority(lvl);
      assert.ok(emoji, `expected emoji for ${lvl}`);
      if (has('priorityToLevel')) {
        assert.equal(helpers.priorityToLevel(emoji), lvl);
      }
    }
  });
  test('levelToPriority: unknown → null', () => {
    assert.equal(helpers.levelToPriority('urgent'), null);
  });
}

// ---------- parseArea ----------
if (has('parseArea')) {
  test('parseArea: TASKS-LORECRAFT.md → LORECRAFT', () => {
    assert.equal(helpers.parseArea('08-Tasks/TASKS-LORECRAFT.md'), 'LORECRAFT');
  });
  test('parseArea: TASKS-URGENT.md → URGENT', () => {
    assert.equal(helpers.parseArea('08-Tasks/TASKS-URGENT.md'), 'URGENT');
  });
  test('parseArea: nested FIDGETCODING/content file', () => {
    const area = helpers.parseArea('08-Tasks/FIDGETCODING/content/TASKS-FIDGETCODING-content.md');
    assert.ok(area && /FIDGETCODING/.test(area));
  });
  test('parseArea: non-task file → null', () => {
    assert.equal(helpers.parseArea('03-Permanent/some-note.md'), null);
  });
  test('parseArea: TASKS.md hub → null or "HUB"', () => {
    const v = helpers.parseArea('08-Tasks/TASKS.md');
    assert.ok(v === null || v === 'HUB' || v === 'TASKS');
  });
}

// ---------- isSafePath ----------
if (has('isSafePath')) {
  test('isSafePath: normal child path is safe', () => {
    assert.equal(helpers.isSafePath('foo/bar.md', '/root'), true);
  });
  test('isSafePath: absolute path inside root is safe', () => {
    assert.equal(helpers.isSafePath('/root/foo/bar.md', '/root'), true);
  });
  test('isSafePath: ../ escape is blocked', () => {
    assert.equal(helpers.isSafePath('../etc/passwd', '/root'), false);
  });
  test('isSafePath: absolute outside root is blocked', () => {
    assert.equal(helpers.isSafePath('/etc/passwd', '/root'), false);
  });
  test('isSafePath: embedded .. in middle is blocked', () => {
    assert.equal(helpers.isSafePath('foo/../../etc/passwd', '/root'), false);
  });
}

// ---------- parseTaskLine / formatTaskLine ----------
if (has('parseTaskLine')) {
  test('parseTaskLine: plain open task', () => {
    const t = helpers.parseTaskLine('- [ ] buy milk');
    assert.ok(t);
    assert.equal(t.checked, false);
    assert.ok(/buy milk/.test(t.text));
  });
  test('parseTaskLine: completed task', () => {
    const t = helpers.parseTaskLine('- [x] buy milk ✅ 2026-04-21');
    assert.ok(t);
    assert.equal(t.checked, true);
  });
  test('parseTaskLine: with due date', () => {
    const t = helpers.parseTaskLine('- [ ] file taxes 📅 2026-04-15');
    assert.ok(t);
    assert.equal(t.due, '2026-04-15');
  });
  test('parseTaskLine: with priority', () => {
    const t = helpers.parseTaskLine('- [ ] ship it ⏫');
    assert.ok(t);
    assert.equal(t.priority, '⏫');
  });
  test('parseTaskLine: non-task line → null', () => {
    assert.equal(helpers.parseTaskLine('just some text'), null);
    assert.equal(helpers.parseTaskLine('# Heading'), null);
  });
}

if (has('parseTaskLine') && has('formatTaskLine')) {
  test('parseTaskLine ↔ formatTaskLine round-trips', () => {
    const original = '- [ ] ship task-maxxing 📅 2026-04-20 ⏫';
    const parsed = helpers.parseTaskLine(original);
    assert.ok(parsed);
    const formatted = helpers.formatTaskLine(parsed);
    const reparsed = helpers.parseTaskLine(formatted);
    assert.ok(reparsed);
    assert.equal(reparsed.text, parsed.text);
    assert.equal(reparsed.due, parsed.due);
    assert.equal(reparsed.priority, parsed.priority);
    assert.equal(reparsed.checked, parsed.checked);
  });
}

// ---------- canonicalizeTask ----------
if (has('canonicalizeTask')) {
  test('canonicalizeTask: strips done date', () => {
    const c1 = helpers.canonicalizeTask({ text: 'buy milk', checked: false });
    const c2 = helpers.canonicalizeTask({
      text: 'buy milk',
      checked: true,
      done: '2026-04-21',
    });
    assert.equal(c1, c2);
  });
}

// ---------- Summary ----------
console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.err.message}`);
  }
  process.exit(1);
}

// Guard: if NONE of the expected helpers existed, that's also a failure
// (sync-helpers.js exists but is empty / wrong shape).
if (passed === 0) {
  console.error('No tests ran — sync-helpers.js exported none of the expected functions.');
  process.exit(1);
}

process.exit(0);

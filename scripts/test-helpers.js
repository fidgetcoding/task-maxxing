#!/usr/bin/env node
/**
 * test-helpers.js
 *
 * Unit tests for src/sync-helpers.js using Node's built-in assert module.
 * Exercises the real exports documented in sync-helpers.js — priority/area
 * mapping, path safety, hashing, task parsing, sync-state (de)serialization,
 * line mutation, Morgen date formatting, and bot commit prefix detection.
 *
 * Expected real exports (see the module.exports block of src/sync-helpers.js):
 *   - parseObsidianPriority, morgenPriorityToObsidian, morgenPriorityToNotion, notionPriorityToInt
 *   - parseArea, areaKeyToNotionLabel, notionLabelToAreaKey, areaKeyToFile
 *   - isSafePath  (single-arg — validates against the TASKS-* allowlist)
 *   - computeTaskHash, computeLineHash
 *   - parseObsidianTasks
 *   - emptySyncState, loadSyncState, serializeSyncState, upsertMappingEntry, findByNotionId, findByMorgenId
 *   - reconstructObsidianLine, flipTaskDone
 *   - dateToMorgenLocal
 *   - isBotCommitMessage, BOT_COMMIT_PREFIXES
 *
 * Any assertion failure exits non-zero. Runs in CI via `npm run test:helpers`.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helpersPath = path.join(process.cwd(), 'src', 'sync-helpers.js');

if (!fs.existsSync(helpersPath)) {
  console.warn(
    `::warning::src/sync-helpers.js not present — skipping helper unit tests.`
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

console.log('test-helpers.js — sync-helpers unit tests\n');

// Sanity: module.exports must expose the documented surface. If this fails,
// sync-helpers.js has drifted and the rest of the tests would run against
// undefined functions.
const REQUIRED_EXPORTS = [
  'parseObsidianPriority',
  'morgenPriorityToNotion',
  'notionPriorityToInt',
  'parseArea',
  'areaKeyToNotionLabel',
  'notionLabelToAreaKey',
  'areaKeyToFile',
  'isSafePath',
  'computeTaskHash',
  'parseObsidianTasks',
  'emptySyncState',
  'loadSyncState',
  'serializeSyncState',
  'upsertMappingEntry',
  'findByNotionId',
  'findByMorgenId',
  'reconstructObsidianLine',
  'flipTaskDone',
  'dateToMorgenLocal',
  'isBotCommitMessage',
  'BOT_COMMIT_PREFIXES',
];

test('sync-helpers exports: all required functions/constants present', () => {
  const missing = REQUIRED_EXPORTS.filter((k) => helpers[k] === undefined);
  assert.deepEqual(missing, [], `missing exports: ${missing.join(', ')}`);
});

// ---------- parseObsidianPriority ----------
// Canonical mapping (see sync-helpers.js PRIORITY_EMOJI_TO_INT):
//   🔺 highest → 1, ⏫ high → 2, 🔼 medium → 5, 🔽 low → 7, ⏬ lowest → 9, none → 0
// parseObsidianPriority takes the EMOJI directly (not a full line) — see
// the PRIORITY_EMOJI_TO_INT lookup in sync-helpers.js.
test('parseObsidianPriority: 🔺 → 1 (highest)', () => {
  assert.equal(helpers.parseObsidianPriority('🔺'), 1);
});
test('parseObsidianPriority: ⏫ → 2 (high)', () => {
  assert.equal(helpers.parseObsidianPriority('⏫'), 2);
});
test('parseObsidianPriority: 🔼 → 5 (medium)', () => {
  assert.equal(helpers.parseObsidianPriority('🔼'), 5);
});
test('parseObsidianPriority: 🔽 → 7 (low)', () => {
  assert.equal(helpers.parseObsidianPriority('🔽'), 7);
});
test('parseObsidianPriority: ⏬ → 9 (lowest)', () => {
  assert.equal(helpers.parseObsidianPriority('⏬'), 9);
});
test('parseObsidianPriority: unknown / null → 0', () => {
  assert.equal(helpers.parseObsidianPriority(null), 0);
  assert.equal(helpers.parseObsidianPriority('??'), 0);
});

// ---------- morgenPriorityToNotion round-trips via notionPriorityToInt ----------
test('morgen→notion→int round-trip: 1 → "🔺 Highest" → 1', () => {
  const label = helpers.morgenPriorityToNotion(1);
  assert.equal(label, '🔺 Highest');
  assert.equal(helpers.notionPriorityToInt(label), 1);
});
test('morgen→notion→int round-trip: 5 → "🔼 Medium" → 5', () => {
  const label = helpers.morgenPriorityToNotion(5);
  assert.equal(label, '🔼 Medium');
  assert.equal(helpers.notionPriorityToInt(label), 5);
});
test('morgenPriorityToNotion: 0 (none) → null', () => {
  assert.equal(helpers.morgenPriorityToNotion(0), null);
  assert.equal(helpers.notionPriorityToInt(null), 0);
});

// ---------- parseArea ----------
test('parseArea: TASKS-LORECRAFT.md → LORECRAFT', () => {
  assert.equal(helpers.parseArea('TASKS-LORECRAFT.md'), 'LORECRAFT');
});
test('parseArea: TASKS-URGENT.md → URGENT', () => {
  assert.equal(helpers.parseArea('TASKS-URGENT.md'), 'URGENT');
});
test('parseArea: unknown file falls back to GENERAL', () => {
  // sync-helpers.js explicitly returns 'GENERAL' for anything it can't classify.
  assert.equal(helpers.parseArea('03-Permanent/some-note.md'), 'GENERAL');
});
test('parseArea: null → GENERAL fallback', () => {
  assert.equal(helpers.parseArea(null), 'GENERAL');
});

// ---------- areaKeyToNotionLabel round-trip ----------
test('areaKeyToNotionLabel ↔ notionLabelToAreaKey round-trip', () => {
  const label = helpers.areaKeyToNotionLabel('URGENT');
  assert.ok(typeof label === 'string' && label.length > 0);
  assert.equal(helpers.notionLabelToAreaKey(label), 'URGENT');
});
test('areaKeyToFile: URGENT → TASKS-URGENT.md', () => {
  assert.equal(helpers.areaKeyToFile('URGENT'), 'TASKS-URGENT.md');
});

// ---------- isSafePath (single-arg, allowlist-based) ----------
test('isSafePath: TASKS-URGENT.md is safe', () => {
  assert.equal(helpers.isSafePath('TASKS-URGENT.md'), true);
});
test('isSafePath: 06-Tasks/TASKS-LORECRAFT.md is safe (leading dir stripped)', () => {
  assert.equal(helpers.isSafePath('06-Tasks/TASKS-LORECRAFT.md'), true);
});
test('isSafePath: traversal ../ is blocked', () => {
  assert.equal(helpers.isSafePath('../etc/passwd'), false);
});
test('isSafePath: absolute paths are blocked', () => {
  assert.equal(helpers.isSafePath('/etc/passwd'), false);
});
test('isSafePath: backslash paths are blocked', () => {
  assert.equal(helpers.isSafePath('foo\\bar.md'), false);
});
test('isSafePath: non-string is blocked', () => {
  assert.equal(helpers.isSafePath(null), false);
});

// ---------- computeTaskHash ----------
// computeTaskHash({sourceFile, text, priority, due, scheduled}) → SHA256-trimmed hex
test('computeTaskHash: stable for identical input', () => {
  const a = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'buy milk', priority: 2, due: '2026-04-20' });
  const b = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'buy milk', priority: 2, due: '2026-04-20' });
  assert.equal(a, b);
  assert.ok(typeof a === 'string' && a.length >= 8);
});
test('computeTaskHash: different text → different hash', () => {
  const a = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'buy milk', priority: 2 });
  const b = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'buy eggs', priority: 2 });
  assert.notEqual(a, b);
});
test('computeTaskHash: different sourceFile → different hash', () => {
  const a = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'ship it', priority: 2 });
  const b = helpers.computeTaskHash({ sourceFile: 'TASKS-LORECRAFT.md', text: 'ship it', priority: 2 });
  assert.notEqual(a, b);
});
test('computeTaskHash: completion state is NOT in the hash', () => {
  // Only the canonical input fields (sourceFile, text, priority, due, scheduled) go
  // into the hash. `done` / `doneDate` must not affect it.
  const a = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'ship', priority: 2, due: '2026-04-20' });
  const b = helpers.computeTaskHash({ sourceFile: 'TASKS-URGENT.md', text: 'ship', priority: 2, due: '2026-04-20', done: true, doneDate: '2026-04-21' });
  assert.equal(a, b);
});

// ---------- parseObsidianTasks ----------
test('parseObsidianTasks: parses open + completed lines, skips fences', () => {
  const md = [
    '# Tasks',
    '- [ ] open task 📅 2026-04-20 ⏫',
    '- [x] done task ✅ 2026-04-19',
    '',
    '```',
    '- [ ] ignore me inside a code fence',
    '```',
    '- [ ] another open task',
  ].join('\n');
  const tasks = helpers.parseObsidianTasks(md, 'TASKS-URGENT.md');
  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].done, false);
  assert.ok(/open task/.test(tasks[0].text));
  // ⏫ maps to priority int 2 (see PRIORITY_EMOJI_TO_INT)
  assert.equal(tasks[0].priority, 2);
  assert.equal(tasks[0].due, '2026-04-20');
  assert.equal(tasks[1].done, true);
  assert.ok(/another open task/.test(tasks[2].text));
  // Every parsed task should carry a deterministic hash
  for (const t of tasks) {
    assert.ok(t.hash && typeof t.hash === 'string');
  }
});

// ---------- loadSyncState / serializeSyncState / upsertMappingEntry ----------
test('loadSyncState: null input returns an empty, versioned state', () => {
  const s = helpers.loadSyncState(null);
  assert.ok(s && typeof s === 'object');
  assert.equal(typeof s._version, 'number');
  assert.ok(s.entries && typeof s.entries === 'object');
});
test('upsertMappingEntry + findByMorgenId round-trip', () => {
  let s = helpers.loadSyncState(null);
  s = helpers.upsertMappingEntry(s, 'hash123', {
    sourceFile: 'TASKS-URGENT.md',
    text: 'hello',
    area: 'URGENT',
    priority: 2,
    notionPageId: 'note_abc',
    morgenTaskId: 'tsk_xyz',
  });
  const json = helpers.serializeSyncState(s);
  const reloaded = helpers.loadSyncState(json);
  assert.ok(reloaded.entries.hash123);
  // findByMorgenId / findByNotionId return { hash, entry } (or null), not a bare hash.
  const byMorgen = helpers.findByMorgenId(reloaded, 'tsk_xyz');
  assert.ok(byMorgen && byMorgen.hash === 'hash123');
  const byNotion = helpers.findByNotionId(reloaded, 'note_abc');
  assert.ok(byNotion && byNotion.hash === 'hash123');
});

// ---------- reconstructObsidianLine / flipTaskDone ----------
test('reconstructObsidianLine: produces a valid task-plugin line', () => {
  // priority 2 == high (⏫)
  const line = helpers.reconstructObsidianLine({
    done: false,
    text: 'ship task-maxxing',
    priority: 2,
    due: '2026-04-20',
  });
  assert.ok(typeof line === 'string');
  assert.ok(line.startsWith('- [ ] '));
  assert.ok(line.includes('ship task-maxxing'));
  assert.ok(line.includes('📅 2026-04-20'));
  assert.ok(line.includes('⏫'));
});

test('flipTaskDone(line): open checkbox → done, appends ✅ today', () => {
  // Real signature is flipTaskDone(line) — one arg. It mutates the raw line in
  // place by flipping `[ ]` → `[x]` and appending `✅ YYYY-MM-DD` if missing.
  const open = '- [ ] ship it 📅 2026-04-20 ⏫';
  const done = helpers.flipTaskDone(open);
  assert.ok(typeof done === 'string');
  assert.ok(done.startsWith('- [x] '));
  assert.ok(done.includes('✅'));
});

// ---------- dateToMorgenLocal ----------
// Real behavior: "YYYY-MM-DD" → "YYYY-MM-DDT09:00:00" (9am local default)
test('dateToMorgenLocal: bare date → date + T09:00:00', () => {
  assert.equal(helpers.dateToMorgenLocal('2026-04-20'), '2026-04-20T09:00:00');
});
test('dateToMorgenLocal: full ISO time → stripped to minute second', () => {
  const v = helpers.dateToMorgenLocal('2026-04-20T15:30:45Z');
  assert.equal(v, '2026-04-20T15:30:45');
});
test('dateToMorgenLocal: empty / null → null', () => {
  assert.equal(helpers.dateToMorgenLocal(''), null);
  assert.equal(helpers.dateToMorgenLocal(null), null);
});

// ---------- isBotCommitMessage / BOT_COMMIT_PREFIXES ----------
test('BOT_COMMIT_PREFIXES: includes the four real bot prefixes', () => {
  const set = new Set(helpers.BOT_COMMIT_PREFIXES);
  for (const p of ['[bot:W1]', '[bot:W2]', '[bot:W3]', '[bot:daemon]']) {
    assert.ok(set.has(p), `expected BOT_COMMIT_PREFIXES to contain ${p}`);
  }
});
test('isBotCommitMessage: detects a daemon commit', () => {
  assert.equal(helpers.isBotCommitMessage('[bot:daemon] auto task edit 2026-04-14T15:30:00Z'), true);
});
test('isBotCommitMessage: detects a W1 commit', () => {
  assert.equal(helpers.isBotCommitMessage('[bot:W1] sync Obsidian → Notion + Morgen'), true);
});
test('isBotCommitMessage: does NOT match a plain user commit', () => {
  assert.equal(helpers.isBotCommitMessage('fix: something'), false);
});
test('isBotCommitMessage: null / undefined → false', () => {
  assert.equal(helpers.isBotCommitMessage(null), false);
  assert.equal(helpers.isBotCommitMessage(undefined), false);
});

// ---------- Summary ----------
console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.err.message}`);
  }
  process.exit(1);
}

process.exit(0);

#!/usr/bin/env node
/**
 * sync-e2e-tests.js — Offline E2E test harness for the Obsidian ↔ Morgen
 * task-sync pipeline (with legacy Notion-mock paths retained for regression).
 *
 * All parsing / hashing / state / path / area logic comes from the LOCKED
 * canonical library at `../src/sync-helpers.js`. This file only adds:
 *   - in-memory Notion + Morgen mocks (Notion mock = legacy regression coverage)
 *   - W1/W2/W3 simulators that exercise the bidirectional paths
 *   - 12 scenario tests (A–L)
 *
 * Note 2026-05-04: Notion was dropped from the live sync stack and W3 was
 * archived. The Notion-side test cases (testC_NotionCreationW3,
 * testD_ConflictNotionWins, testE_ConflictTieGoesToObsidian, simulateW3) are
 * RETAINED in this harness — they exercise pure in-memory mocks and never
 * hit a real Notion API. They act as regression coverage for the
 * area-key↔Notion-label mapping (still consumed by W1's tag attachment path
 * because Morgen tag labels reuse the `01 URGENT` shape inherited from the
 * Notion era). Removing them is non-trivial: it requires pruning the helper
 * exports in `src/sync-helpers.js` that the live W1 path still needs. Defer.
 *
 * Exit code = number of failing tests.
 * Run: `node scripts/sync-e2e-tests.js`
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const helpers = require('../src/sync-helpers');
const {
  parseObsidianTasks,
  computeTaskHash,
  parseArea,
  areaKeyToNotionLabel,
  notionLabelToAreaKey,
  areaKeyToFile,
  isSafePath,
  loadSyncState,
  serializeSyncState,
  upsertMappingEntry,
  findByMorgenId,
  findByNotionId,
  flipTaskDone,
  morgenPriorityToNotion,
  notionPriorityToInt,
  dateToMorgenLocal,
} = helpers;

// ----------------------------------------------------------------------------
// Test-local "today" — deterministic for W2 flip tests
// ----------------------------------------------------------------------------

function todayIso() {
  return process.env.FAKE_TODAY || new Date().toISOString().slice(0, 10);
}

// ----------------------------------------------------------------------------
// Parse a single file using the canonical parser, mapped to the shape the
// simulators below want (with `title`, `done`, `hash`, `lineIdx`).
// ----------------------------------------------------------------------------

function parseTaskFile(sourceFile, content) {
  return parseObsidianTasks(content, sourceFile).map((t) => ({
    sourceFile: t.sourceFile,
    lineIdx: t.lineNo - 1,
    lineNo: t.lineNo,
    rawLine: t.rawLine,
    done: t.done,
    title: t.text,
    text: t.text,
    priority: t.priority,
    due: t.due || '',
    scheduled: t.scheduled || '',
    hash: t.hash,
    area: t.area,
  }));
}

function parseTaskLine(line, sourceFile, lineIdx) {
  // Wrap a single line in a minimal doc so the canonical parser handles it.
  const tasks = parseObsidianTasks(line + '\n', sourceFile);
  if (tasks.length === 0) return null;
  const t = tasks[0];
  return {
    sourceFile: t.sourceFile,
    lineIdx,
    rawLine: line,
    done: t.done,
    title: t.text,
    text: t.text,
    priority: t.priority,
    due: t.due || '',
    scheduled: t.scheduled || '',
    hash: t.hash,
    area: t.area,
  };
}

// ----------------------------------------------------------------------------
// MOCKS — Notion, Morgen, Commit, Fetch
// ----------------------------------------------------------------------------

function makeCommitMock() {
  const calls = [];
  return {
    commit(msg, files) {
      calls.push({ msg, files: Array.isArray(files) ? files.slice() : [] });
    },
    calls,
  };
}

function makeNotionMock({ seedRows = [] } = {}) {
  const pages = new Map();
  seedRows.forEach((r, i) => {
    const pid = r.pageId || `notion-seed-${i}`;
    pages.set(pid, { ...r, pageId: pid });
  });
  const writeLog = [];
  let pageIdCounter = 1000;
  return {
    _pages: pages,
    createPage(row) {
      const pageId = `notion-page-${pageIdCounter++}`;
      const stored = { ...row, pageId, archived: false };
      pages.set(pageId, stored);
      writeLog.push({ type: 'create', pageId, row: stored });
      return { id: pageId };
    },
    updatePage(pageId, patch) {
      const row = pages.get(pageId);
      if (!row) throw new Error(`Notion updatePage: unknown pageId ${pageId}`);
      Object.assign(row, patch);
      writeLog.push({ type: 'update', pageId, patch });
      return row;
    },
    archivePage(pageId) {
      const row = pages.get(pageId);
      if (!row) return;
      row.archived = true;
      writeLog.push({ type: 'archive', pageId });
    },
    queryDatabase() {
      return Array.from(pages.values()).filter((r) => !r.archived);
    },
    writeLog,
    get createCount() {
      return writeLog.filter((w) => w.type === 'create').length;
    },
    get updateCount() {
      return writeLog.filter((w) => w.type === 'update').length;
    },
    get archiveCount() {
      return writeLog.filter((w) => w.type === 'archive').length;
    },
  };
}

function makeMorgenMock({ tasks = [], tags = [] } = {}) {
  const state = { tasks: tasks.slice(), tags: tags.slice() };
  const writeLog = [];
  let taskIdCounter = 1000;
  let tagIdCounter = 1000;
  return {
    _state: state,
    tagsList() {
      writeLog.push({ type: 'tags/list' });
      return { data: { tags: state.tags.slice() } };
    },
    tagsCreate({ name }) {
      const id = `tag-uuid-${tagIdCounter++}`;
      state.tags.push({ id, name });
      writeLog.push({ type: 'tags/create', name, id });
      return { data: { id } };
    },
    tasksCreate(payload) {
      const id = `morgen-task-${taskIdCounter++}`;
      const task = {
        id,
        title: payload.title,
        priority: payload.priority ?? 0,
        due: payload.due || null,
        taskListId: payload.taskListId || 'inbox',
        tags: payload.tags || [],
        progress: 'needs-action',
      };
      state.tasks.push(task);
      writeLog.push({ type: 'tasks/create', id, task });
      return { data: { id } };
    },
    tasksList() {
      writeLog.push({ type: 'tasks/list' });
      return { data: { tasks: state.tasks.slice() } };
    },
    tasksClose(id) {
      const t = state.tasks.find((x) => x.id === id);
      if (t) t.progress = 'completed';
      writeLog.push({ type: 'tasks/close', id });
    },
    writeLog,
    countOf(type) {
      return writeLog.filter((w) => w.type === type).length;
    },
  };
}

function makeFetchMock() {
  return async function fetchMock() {
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
}

// ----------------------------------------------------------------------------
// State-file I/O — thin wrappers over loadSyncState / serializeSyncState
// ----------------------------------------------------------------------------

function loadStateFile(stateFile) {
  if (!fs.existsSync(stateFile)) return loadSyncState(null);
  try {
    return loadSyncState(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return loadSyncState(null);
  }
}

function saveStateFile(stateFile, state) {
  fs.writeFileSync(stateFile, serializeSyncState(state));
}

// ----------------------------------------------------------------------------
// W1 simulator — Obsidian origin → Notion + Morgen
// ----------------------------------------------------------------------------

function simulateW1({ vaultDir, stateFile, notion, morgen }) {
  let state = loadStateFile(stateFile);

  // 1. Parse every TASKS-*.md file in the flat vault dir (tests use a flat temp dir)
  const files = fs
    .readdirSync(vaultDir)
    .filter((f) => /^TASKS-.*\.md$/.test(f) && f !== 'TASKS.md');
  const allTasks = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(vaultDir, f), 'utf8');
    for (const t of parseTaskFile(f, content)) {
      if (!t.done) allTasks.push(t);
    }
  }

  // 2. Diff vs state
  const newTasks = allTasks.filter((t) => !state.entries[t.hash]);

  // 3. Morgen rate budget (300pt / 15min window as of 2026-04-15, reserve 85 for W1)
  //    Formula per task: ~2 pts (tag work included). Plus 10 for tags/list.
  const projectedCost = 10 + newTasks.length * 2;
  if (projectedCost > 85) {
    throw new Error(
      `ABORT [#rate-budget] projected=${projectedCost}pt exceeds 85pt budget for ${newTasks.length} new tasks`
    );
  }

  if (newTasks.length === 0) {
    return { state, created: [] };
  }

  morgen.tagsList();

  const created = [];
  for (const t of newTasks) {
    // Notion: truncate title to 1900 chars
    const notionTitle = t.title.length > 1900 ? t.title.slice(0, 1900) : t.title;
    const areaLabel = areaKeyToNotionLabel(t.area);
    const notionRes = notion.createPage({
      hash: t.hash,
      title: notionTitle,
      area: areaLabel,
      priority: morgenPriorityToNotion(t.priority) || '',
      status: 'Not Started',
      due: t.due || null,
      scheduled: t.scheduled || null,
      sourceFile: t.sourceFile,
    });
    // Morgen: full title
    const morgenRes = morgen.tasksCreate({
      title: t.title,
      priority: t.priority,
      due: dateToMorgenLocal(t.due) || null,
      taskListId: 'inbox',
      tags: [],
    });
    state = upsertMappingEntry(state, t.hash, {
      sourceFile: t.sourceFile,
      lineNo: t.lineNo,
      text: t.text,
      area: t.area,
      priority: t.priority,
      due: t.due || null,
      scheduled: t.scheduled || null,
      notionPageId: notionRes.id,
      morgenTaskId: morgenRes.data.id,
      morgenEventId: null,
      archived: false,
    });
    created.push(state.entries[t.hash]);
  }

  saveStateFile(stateFile, state);
  return { state, created };
}

// ----------------------------------------------------------------------------
// W2 simulator — Morgen completion → Obsidian flip
// ----------------------------------------------------------------------------

function simulateW2({ vaultDir, stateFile, morgen, commit }) {
  let state = loadStateFile(stateFile);
  const morgenRes = morgen.tasksList();
  const completed = (morgenRes.data?.tasks || []).filter((t) => t.progress === 'completed');

  // Tracked completions (skip orphans)
  const tracked = [];
  const skipped = [];
  for (const mt of completed) {
    const match = findByMorgenId(state, mt.id);
    if (!match) {
      skipped.push({ id: mt.id, reason: 'orphan — no mapping entry' });
      continue;
    }
    tracked.push({ morgen: mt, match });
  }

  // Safety rail: > 50% flip ratio (minimum 4 tracked tasks)
  const trackedCount = Object.values(state.entries).filter((e) => e.morgenTaskId).length;
  const FLIP_RATIO_MIN_SAMPLE = 4;
  if (
    trackedCount >= FLIP_RATIO_MIN_SAMPLE &&
    tracked.length / trackedCount > 0.5
  ) {
    throw new Error(
      `ABORT [#safety-rail-flip-ratio] ${tracked.length}/${trackedCount} > 50% of tracked tasks would flip in one tick`
    );
  }

  const flips = [];
  const filesTouched = new Set();
  for (const { match } of tracked) {
    const { hash, entry } = match;
    if (!isSafePath(entry.sourceFile)) {
      skipped.push({ hash, reason: 'unsafe-path' });
      continue;
    }
    const filePath = path.join(vaultDir, entry.sourceFile);
    if (!fs.existsSync(filePath)) {
      skipped.push({ hash, reason: 'file-missing' });
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let flipped = false;
    const fakeToday = todayIso();

    // Override "today" for flipTaskDone by monkey-patching Date briefly
    const origToIso = Date.prototype.toISOString;
    if (process.env.FAKE_TODAY) {
      Date.prototype.toISOString = function () {
        return `${process.env.FAKE_TODAY}T00:00:00.000Z`;
      };
    }

    try {
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseTaskLine(lines[i], entry.sourceFile, i);
        if (parsed && !parsed.done && parsed.hash === hash) {
          lines[i] = flipTaskDone(lines[i]);
          flipped = true;
          break;
        }
      }
    } finally {
      Date.prototype.toISOString = origToIso;
    }

    if (flipped) {
      fs.writeFileSync(filePath, lines.join('\n'));
      filesTouched.add(entry.sourceFile);
      state = upsertMappingEntry(state, hash, {});
      flips.push(hash);
      // Emulate fakeToday lock for follow-up assertions
      void fakeToday;
    }
  }

  if (filesTouched.size > 0) {
    saveStateFile(stateFile, state);
    commit.commit('[bot:W2] flip completed morgen tasks', Array.from(filesTouched));
  }

  return { flips, skipped, state };
}

// ----------------------------------------------------------------------------
// W3 simulator — Notion creation / Notion-wins conflict resolution
// ----------------------------------------------------------------------------

function simulateW3({ vaultDir, stateFile, notion, commit }) {
  let state = loadStateFile(stateFile);
  const rows = notion.queryDatabase();

  const inserts = [];
  const conflicts = [];
  const filesTouched = new Set();

  for (const row of rows) {
    const match = findByNotionId(state, row.pageId);

    if (!match) {
      // New row from Notion → append to source file
      // row.area is a Notion select label; convert to internal key to pick the right file
      const areaKey = notionLabelToAreaKey(row.area) === 'GENERAL' && row.area !== '02 GENERAL'
        ? row.area // fall back to raw for tests using the flat form "LORECRAFT"
        : notionLabelToAreaKey(row.area);
      // Also tolerate tests that pass the raw internal key as `area`
      const keyGuess = Object.prototype.hasOwnProperty.call(helpers._constants.NOTION_AREAS, row.area)
        ? row.area
        : areaKey;

      const areaFile = (function () {
        // Flat test files live at vaultDir/TASKS-<AREA>.md — try that first
        const flat = `TASKS-${keyGuess}.md`;
        if (fs.existsSync(path.join(vaultDir, flat))) return flat;
        // Fall back to the canonical mapping
        return areaKeyToFile(keyGuess);
      })();

      const filePath = path.join(vaultDir, areaFile);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const priorityInt = notionPriorityToInt(row.priority);
      const priorityEmoji = morgenPriorityToObsidianLocal(priorityInt);
      const newLine = `- [ ] ${row.title}${priorityEmoji ? ' ' + priorityEmoji : ''}`;

      const lines = content.split('\n');
      let insertAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (/^##\s+Open\s*$/.test(lines[i])) {
          insertAt = i + 1;
          while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
          while (
            insertAt < lines.length &&
            /^\s*-\s*\[( |x|X)\]/.test(lines[insertAt])
          ) {
            insertAt++;
          }
          break;
        }
      }
      lines.splice(insertAt, 0, newLine);
      fs.writeFileSync(filePath, lines.join('\n'));
      filesTouched.add(areaFile);

      const parsed = parseTaskLine(newLine, areaFile, insertAt);
      state = upsertMappingEntry(state, parsed.hash, {
        sourceFile: areaFile,
        lineNo: insertAt + 1,
        text: parsed.title,
        area: parsed.area,
        priority: parsed.priority,
        due: parsed.due || null,
        scheduled: parsed.scheduled || null,
        notionPageId: row.pageId,
        morgenTaskId: null,
        morgenEventId: null,
        archived: false,
      });
      inserts.push(state.entries[parsed.hash]);
    } else {
      // Existing mapping → last-writer-wins
      const { hash, entry } = match;
      const notionTs = row.editedAtTs || 0;
      const obsidianTs = entry.obsidianEditedAtTs || entry.lastSyncedTsLegacy || 0;

      if (notionTs > obsidianTs) {
        // Notion wins
        const filePath = path.join(vaultDir, entry.sourceFile);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const priorityInt = notionPriorityToInt(row.priority);
        const priorityEmoji = morgenPriorityToObsidianLocal(priorityInt);
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseTaskLine(lines[i], entry.sourceFile, i);
          if (parsed && !parsed.done && parsed.hash === hash) {
            lines[i] = `- [ ] ${row.title}${priorityEmoji ? ' ' + priorityEmoji : ''}`;
            break;
          }
        }
        fs.writeFileSync(filePath, lines.join('\n'));
        filesTouched.add(entry.sourceFile);
        state = upsertMappingEntry(state, hash, {
          text: row.title,
          obsidianEditedAtTs: notionTs,
          lastSyncedTsLegacy: notionTs,
        });
        conflicts.push({ hash, winner: 'notion', ts: notionTs });
      } else {
        // Obsidian wins (or tie → Obsidian)
        notion.updatePage(row.pageId, {
          title: entry.text,
          priority: entry.priority,
        });
        const winTs = Math.max(notionTs, obsidianTs);
        state = upsertMappingEntry(state, hash, {
          obsidianEditedAtTs: winTs,
          lastSyncedTsLegacy: winTs,
        });
        conflicts.push({ hash, winner: 'obsidian', ts: winTs });
      }
    }
  }

  if (filesTouched.size > 0 || inserts.length > 0 || conflicts.length > 0) {
    saveStateFile(stateFile, state);
  }
  if (filesTouched.size > 0) {
    commit.commit('[bot:W3] sync notion → obsidian', Array.from(filesTouched));
  }

  return { inserts, conflicts, state };
}

// Local helper: convert int priority to Obsidian emoji (for newly-created lines in W3)
function morgenPriorityToObsidianLocal(intVal) {
  const map = { 1: '🔺', 2: '⏫', 5: '🔼', 7: '🔽', 9: '⏬' };
  return map[intVal] || '';
}

// ----------------------------------------------------------------------------
// FIXTURE HELPERS
// ----------------------------------------------------------------------------

function makeTmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-e2e-'));
}

function writeTaskFile(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}

function cleanupVault(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------------------------
// TEST RUNNER
// ----------------------------------------------------------------------------

const RESULTS = [];
async function runTest(name, fn) {
  let status = 'pass';
  let err = null;
  try {
    await fn();
  } catch (e) {
    status = 'fail';
    err = e;
  }
  RESULTS.push({ name, status, err });
  const marker = status === 'pass' ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${marker}] ${name}\n`);
  if (err) {
    process.stdout.write(`         ${err.message}\n`);
    if (process.env.DEBUG_STACK) process.stdout.write(err.stack + '\n');
  }
}

// ----------------------------------------------------------------------------
// TESTS A–L
// ----------------------------------------------------------------------------

async function testA_ObsidianOriginW1() {
  const vault = makeTmpVault();
  try {
    writeTaskFile(
      vault,
      'TASKS-GENERAL.md',
      [
        '# TASKS — General',
        '',
        '## Open',
        '',
        '- [ ] buy groceries ⏫ 📅 2026-04-20',
        '- [ ] file taxes 🔺 📅 2026-04-15',
        '- [ ] walk the dog',
        '',
      ].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    fs.writeFileSync(stateFile, serializeSyncState(loadSyncState(null)));
    const notion = makeNotionMock();
    const morgen = makeMorgenMock();

    const res = simulateW1({ vaultDir: vault, stateFile, notion, morgen });

    const state = loadStateFile(stateFile);
    assert.equal(Object.keys(state.entries).length, 3, 'state should have 3 entries');
    for (const entry of Object.values(state.entries)) {
      assert.ok(entry.notionPageId, 'notionPageId set');
      assert.ok(entry.morgenTaskId, 'morgenTaskId set');
    }
    assert.equal(notion.createCount, 3, 'notion got 3 creates');
    assert.equal(morgen.countOf('tags/list'), 1, 'morgen got 1 tags/list');
    assert.equal(morgen.countOf('tasks/create'), 3, 'morgen got 3 task creates');
    assert.equal(res.created.length, 3);
  } finally {
    cleanupVault(vault);
  }
}

async function testB_MorgenCompletionW2() {
  const vault = makeTmpVault();
  try {
    const text = 'publish blog post';
    const sourceFile = 'TASKS-GENERAL.md';
    const hash = computeTaskHash({ sourceFile, text, priority: 0, due: null, scheduled: null });
    writeTaskFile(
      vault,
      sourceFile,
      ['# TASKS — General', '', '## Open', '', `- [ ] ${text}`, ''].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    let seedState = loadSyncState(null);
    seedState = upsertMappingEntry(seedState, hash, {
      sourceFile,
      lineNo: 5,
      text,
      area: 'GENERAL',
      priority: 0,
      due: null,
      scheduled: null,
      notionPageId: 'notion-page-seed-1',
      morgenTaskId: 'morgen-task-seed-1',
    });
    saveStateFile(stateFile, seedState);

    const morgen = makeMorgenMock({
      tasks: [
        { id: 'morgen-task-seed-1', title: text, priority: 0, progress: 'completed' },
      ],
    });
    const commit = makeCommitMock();

    process.env.FAKE_TODAY = '2026-04-14';
    const res = simulateW2({ vaultDir: vault, stateFile, morgen, commit });
    delete process.env.FAKE_TODAY;

    const updated = fs.readFileSync(path.join(vault, sourceFile), 'utf8');
    const flippedLine = updated.split('\n').find((l) => l.includes('publish blog post'));
    assert.match(flippedLine, /^- \[x\] publish blog post.*✅ 2026-04-14$/);

    assert.equal(commit.calls.length, 1, 'commit called exactly once');
    assert.equal(res.flips.length, 1);
  } finally {
    cleanupVault(vault);
  }
}

async function testC_NotionCreationW3() {
  const vault = makeTmpVault();
  try {
    const sourceFile = 'TASKS-LORECRAFT.md';
    writeTaskFile(
      vault,
      sourceFile,
      ['# TASKS — LORECRAFT', '', '## Open', '', ''].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    saveStateFile(stateFile, loadSyncState(null));

    const notion = makeNotionMock({
      seedRows: [
        {
          pageId: 'notion-page-new-1',
          title: 'research Lava token model',
          area: 'LORECRAFT', // W3 tolerates raw internal key when flat file exists
          priority: '⏫ High',
          status: 'Not Started',
          editedAtTs: Date.now(),
        },
      ],
    });
    const commit = makeCommitMock();

    const res = simulateW3({ vaultDir: vault, stateFile, notion, commit });

    const updated = fs.readFileSync(path.join(vault, sourceFile), 'utf8');
    assert.ok(
      updated.includes('- [ ] research Lava token model ⏫'),
      `file should contain new line, got:\n${updated}`
    );
    const state = loadStateFile(stateFile);
    const entries = Object.values(state.entries);
    assert.equal(entries.length, 1, 'exactly one state entry');
    assert.equal(entries[0].notionPageId, 'notion-page-new-1');
    assert.equal(entries[0].morgenTaskId, null, 'morgenTaskId null until W1 runs');
    assert.equal(res.inserts.length, 1);
  } finally {
    cleanupVault(vault);
  }
}

async function testD_ConflictNotionWins() {
  const vault = makeTmpVault();
  try {
    const sourceFile = 'TASKS-GENERAL.md';
    const originalText = 'conflicted task';
    const newNotionTitle = 'conflicted task (notion edited)';
    const hash = computeTaskHash({
      sourceFile,
      text: originalText,
      priority: 0,
      due: null,
      scheduled: null,
    });
    writeTaskFile(
      vault,
      sourceFile,
      ['# TASKS — General', '', '## Open', '', `- [ ] ${originalText}`, ''].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    const T0 = 1_700_000_000_000;
    const T1 = T0 + 100_000;
    const T2 = T0 + 50_000;

    let seed = loadSyncState(null);
    seed = upsertMappingEntry(seed, hash, {
      sourceFile,
      lineNo: 5,
      text: originalText,
      area: 'GENERAL',
      priority: 0,
      due: null,
      scheduled: null,
      notionPageId: 'notion-page-conflict',
      morgenTaskId: 'morgen-task-conflict',
      obsidianEditedAtTs: T2,
      lastSyncedTsLegacy: T0,
    });
    saveStateFile(stateFile, seed);

    const notion = makeNotionMock({
      seedRows: [
        {
          pageId: 'notion-page-conflict',
          title: newNotionTitle,
          area: 'GENERAL',
          priority: '',
          editedAtTs: T1,
        },
      ],
    });
    const commit = makeCommitMock();

    const res = simulateW3({ vaultDir: vault, stateFile, notion, commit });

    assert.equal(res.conflicts.length, 1);
    assert.equal(res.conflicts[0].winner, 'notion');
    const updated = fs.readFileSync(path.join(vault, sourceFile), 'utf8');
    assert.ok(updated.includes(newNotionTitle), 'obsidian line updated to notion title');
  } finally {
    cleanupVault(vault);
  }
}

async function testE_ConflictTieObsidianWins() {
  const vault = makeTmpVault();
  try {
    const sourceFile = 'TASKS-GENERAL.md';
    const originalText = 'tied task';
    const hash = computeTaskHash({
      sourceFile,
      text: originalText,
      priority: 0,
      due: null,
      scheduled: null,
    });
    writeTaskFile(
      vault,
      sourceFile,
      ['# TASKS — General', '', '## Open', '', `- [ ] ${originalText}`, ''].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    const T0 = 1_700_000_000_000;

    let seed = loadSyncState(null);
    seed = upsertMappingEntry(seed, hash, {
      sourceFile,
      lineNo: 5,
      text: originalText,
      area: 'GENERAL',
      priority: 0,
      due: null,
      scheduled: null,
      notionPageId: 'notion-page-tie',
      morgenTaskId: 'morgen-task-tie',
      obsidianEditedAtTs: T0,
      lastSyncedTsLegacy: T0,
    });
    saveStateFile(stateFile, seed);

    const notion = makeNotionMock({
      seedRows: [
        {
          pageId: 'notion-page-tie',
          title: 'notion stale version',
          area: 'GENERAL',
          priority: '',
          editedAtTs: T0,
        },
      ],
    });
    const commit = makeCommitMock();

    const res = simulateW3({ vaultDir: vault, stateFile, notion, commit });

    assert.equal(res.conflicts.length, 1);
    assert.equal(res.conflicts[0].winner, 'obsidian');
    const updated = fs.readFileSync(path.join(vault, sourceFile), 'utf8');
    assert.ok(updated.includes(`- [ ] ${originalText}`));
    assert.equal(notion.updateCount, 1);
    const notionPage = notion._pages.get('notion-page-tie');
    assert.equal(notionPage.title, originalText);
  } finally {
    cleanupVault(vault);
  }
}

async function testF_RateBudgetAbortW1() {
  const vault = makeTmpVault();
  try {
    const lines = ['# big', '', '## Open', ''];
    for (let i = 0; i < 200; i++) lines.push(`- [ ] bulk task number ${i}`);
    writeTaskFile(vault, 'TASKS-GENERAL.md', lines.join('\n'));
    const stateFile = path.join(vault, '.sync-state.json');
    saveStateFile(stateFile, loadSyncState(null));
    const notion = makeNotionMock();
    const morgen = makeMorgenMock();

    let err = null;
    try {
      simulateW1({ vaultDir: vault, stateFile, notion, morgen });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected abort');
    assert.match(err.message, /ABORT \[#rate-budget\]/);
    const state = loadStateFile(stateFile);
    assert.equal(Object.keys(state.entries).length, 0, 'no state entries written');
    assert.equal(notion.createCount, 0, 'no notion creates');
    assert.equal(morgen.countOf('tasks/create'), 0, 'no morgen creates');
  } finally {
    cleanupVault(vault);
  }
}

async function testG_OrphanMorgenCompletion() {
  const vault = makeTmpVault();
  try {
    writeTaskFile(
      vault,
      'TASKS-GENERAL.md',
      ['# g', '', '## Open', '', '- [ ] some unrelated task', ''].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    saveStateFile(stateFile, loadSyncState(null));
    const morgen = makeMorgenMock({
      tasks: [
        {
          id: 'morgen-task-orphan',
          title: 'created outside obsidian',
          priority: 0,
          progress: 'completed',
        },
      ],
    });
    const commit = makeCommitMock();

    const res = simulateW2({ vaultDir: vault, stateFile, morgen, commit });

    assert.equal(res.flips.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.equal(commit.calls.length, 0);
    const content = fs.readFileSync(path.join(vault, 'TASKS-GENERAL.md'), 'utf8');
    assert.ok(content.includes('- [ ] some unrelated task'));
  } finally {
    cleanupVault(vault);
  }
}

async function testH_UnicodeLongTitles() {
  const vault = makeTmpVault();
  try {
    const longTitle =
      '🚀 '.repeat(5) + 'ünïcödé long title '.repeat(100) + '— end';
    const sourceFile = 'TASKS-GENERAL.md';
    writeTaskFile(
      vault,
      sourceFile,
      ['# h', '', '## Open', '', `- [ ] ${longTitle}`, ''].join('\n')
    );
    const stateFile = path.join(vault, '.sync-state.json');
    saveStateFile(stateFile, loadSyncState(null));
    const notion = makeNotionMock();
    const morgen = makeMorgenMock();

    simulateW1({ vaultDir: vault, stateFile, notion, morgen });

    const create = notion.writeLog.find((w) => w.type === 'create');
    assert.ok(create, 'notion got a create');
    assert.ok(
      create.row.title.length <= 1900,
      `notion title should be <= 1900 chars, got ${create.row.title.length}`
    );
    const morgenCreate = morgen.writeLog.find((w) => w.type === 'tasks/create');
    assert.ok(morgenCreate.task.title.length > 1900, 'morgen kept full title');

    // Hash stability — re-parse, compare
    const content = fs.readFileSync(path.join(vault, sourceFile), 'utf8');
    const tasks = parseTaskFile(sourceFile, content);
    const state = loadStateFile(stateFile);
    const stateHashes = Object.keys(state.entries);
    assert.equal(stateHashes.length, 1);
    assert.equal(tasks[0].hash, stateHashes[0], 'hash is stable across runs');

    // Second run is a no-op
    simulateW1({ vaultDir: vault, stateFile, notion, morgen });
    assert.equal(notion.createCount, 1, 'no duplicate create on second run');
  } finally {
    cleanupVault(vault);
  }
}

async function testI_SafetyRailFlipRatio() {
  const vault = makeTmpVault();
  try {
    const sourceFile = 'TASKS-GENERAL.md';
    const lines = ['# i', '', '## Open', ''];
    let state = loadSyncState(null);
    const items = [];
    for (let i = 0; i < 10; i++) {
      const text = `rail task ${i}`;
      lines.push(`- [ ] ${text}`);
      const hash = computeTaskHash({
        sourceFile,
        text,
        priority: 0,
        due: null,
        scheduled: null,
      });
      state = upsertMappingEntry(state, hash, {
        sourceFile,
        text,
        area: 'GENERAL',
        priority: 0,
        due: null,
        scheduled: null,
        notionPageId: `np-${i}`,
        morgenTaskId: `mt-${i}`,
      });
      items.push({ hash, morgenTaskId: `mt-${i}`, title: text });
    }
    writeTaskFile(vault, sourceFile, lines.join('\n'));
    const stateFile = path.join(vault, '.sync-state.json');
    saveStateFile(stateFile, state);

    // 6/10 completed → > 50%
    const morgen = makeMorgenMock({
      tasks: items.slice(0, 6).map((e) => ({
        id: e.morgenTaskId,
        title: e.title,
        priority: 0,
        progress: 'completed',
      })),
    });
    const commit = makeCommitMock();

    let err = null;
    try {
      simulateW2({ vaultDir: vault, stateFile, morgen, commit });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected abort');
    assert.match(err.message, /ABORT \[#safety-rail-flip-ratio\]/);
    assert.equal(commit.calls.length, 0, 'no commit');
    const content = fs.readFileSync(path.join(vault, sourceFile), 'utf8');
    assert.ok(!content.includes('- [x]'), 'no lines flipped');
  } finally {
    cleanupVault(vault);
  }
}

// ----------------------------------------------------------------------------
// NEW TESTS J · K · L
// ----------------------------------------------------------------------------

async function testJ_IsSafePath() {
  // Rejects
  const rejects = [
    '../evil.md',
    '/etc/passwd',
    'TASKS-../x.md',
    '05-Tasks/../../etc/passwd',
    'TASKS-HACKED.md',               // not in allowlist
    'FIDGETCODING/evil/TASKS-x.md',  // wrong subfolder
    '../TASKS-URGENT.md',
    '',
    null,
    undefined,
  ];
  for (const p of rejects) {
    assert.equal(isSafePath(p), false, `should reject: ${JSON.stringify(p)}`);
  }
  // Accepts
  const accepts = [
    'TASKS-URGENT.md',
    'TASKS-GENERAL.md',
    'TASKS-LORECRAFT.md',
    'TASKS-BLOOM.md',
    'TASKS-CART-BLANCHE.md',
    'TASKS-LAVA-NETWORK.md',
    'TASKS-MMA.md',
    'TASKS-PARZVL.md',
    'TASKS-WAGMI.md',
    'FIDGETCODING/content/TASKS-FIDGETCODING-content.md',
    'FIDGETCODING/misc-building/TASKS-FIDGETCODING-misc-building.md',
    'FIDGETCODING/TASKS-FIDGETCODING.md',
    'FUTURE-SCHEDULING/TASKS-FUTURE-SCHEDULING.md',
    // with 05-Tasks/ prefix also OK
    '05-Tasks/TASKS-URGENT.md',
    '05-Tasks/FIDGETCODING/content/TASKS-FIDGETCODING-content.md',
  ];
  for (const p of accepts) {
    assert.equal(isSafePath(p), true, `should accept: ${JSON.stringify(p)}`);
  }
}

async function testK_ParseAreaRoundTrip() {
  const cases = [
    ['TASKS-URGENT.md', 'URGENT', '01 URGENT'],
    ['TASKS-GENERAL.md', 'GENERAL', '02 GENERAL'],
    ['TASKS-LORECRAFT.md', 'LORECRAFT', '03 LORECRAFT'],
    ['TASKS-BLOOM.md', 'BLOOM', '04 BLOOM'],
    ['TASKS-CART-BLANCHE.md', 'CART-BLANCHE', '05 CART-BLANCHE'],
    [
      'FIDGETCODING/content/TASKS-FIDGETCODING-content.md',
      'FIDGETCODING-CONTENT',
      '06 FIDGETCODING · content',
    ],
    [
      'FIDGETCODING/misc-building/TASKS-FIDGETCODING-misc-building.md',
      'FIDGETCODING-MISC-BUILDING',
      '07 FIDGETCODING · misc-building',
    ],
    [
      'FUTURE-SCHEDULING/TASKS-FUTURE-SCHEDULING.md',
      'FUTURE-SCHEDULING',
      '08 FUTURE-SCHEDULING',
    ],
    ['TASKS-LAVA-NETWORK.md', 'LAVA-NETWORK', '09 LAVA-NETWORK'],
    ['TASKS-MMA.md', 'MMA', '10 MMA'],
    ['TASKS-PARZVL.md', 'PARZVL', '11 PARZVL'],
    ['TASKS-WAGMI.md', 'WAGMI', '12 WAGMI'],
    // Also test with 05-Tasks/ prefix
    ['05-Tasks/TASKS-URGENT.md', 'URGENT', '01 URGENT'],
    [
      '05-Tasks/FIDGETCODING/content/TASKS-FIDGETCODING-content.md',
      'FIDGETCODING-CONTENT',
      '06 FIDGETCODING · content',
    ],
  ];
  for (const [filePath, expectedKey, expectedLabel] of cases) {
    const key = parseArea(filePath);
    assert.equal(key, expectedKey, `parseArea(${filePath}) → ${key}, expected ${expectedKey}`);
    const label = areaKeyToNotionLabel(key);
    assert.equal(
      label,
      expectedLabel,
      `areaKeyToNotionLabel(${key}) → ${label}, expected ${expectedLabel}`
    );
    // Round-trip the label back to the internal key
    assert.equal(
      notionLabelToAreaKey(label),
      expectedKey,
      `notionLabelToAreaKey(${label}) round-trip`
    );
  }
}

async function testL_FencedCodeBlockSkip() {
  const md = [
    '# Hub file with task queries and real tasks',
    '',
    '## Open',
    '',
    '- [ ] real task one 🔺 📅 2026-04-20',
    '- [ ] real task two',
    '',
    '## Aggregated view',
    '',
    '```tasks',
    'not done',
    'path includes 05-Tasks',
    '- [ ] fake task inside fence — should NOT be parsed',
    '- [ ] another fake inside fence',
    '```',
    '',
    '## More real tasks',
    '',
    '- [ ] real task three ⏫',
    '',
    '~~~tasks',
    '- [ ] fake task inside tilde fence',
    '~~~',
    '',
    '- [ ] real task four',
  ].join('\n');

  const tasks = parseObsidianTasks(md, 'TASKS-GENERAL.md');
  const titles = tasks.map((t) => t.text).sort();
  const expected = [
    'real task four',
    'real task one',
    'real task three',
    'real task two',
  ];
  assert.deepEqual(titles, expected, `expected 4 real tasks, got: ${JSON.stringify(titles)}`);
  // Ensure none of the fake ones leaked through
  for (const t of tasks) {
    assert.ok(!/fake/.test(t.text), `leaked fenced task: ${t.text}`);
  }
}

// ----------------------------------------------------------------------------
// ENTRY POINT
// ----------------------------------------------------------------------------

async function main() {
  process.stdout.write('\nsync-e2e-tests — canonical helpers\n');
  process.stdout.write('─'.repeat(60) + '\n');

  await runTest('A · Obsidian origin → W1 creates Notion + Morgen', testA_ObsidianOriginW1);
  await runTest('B · Morgen completion → W2 flips Obsidian', testB_MorgenCompletionW2);
  await runTest('C · Notion creation → W3 appends to Obsidian', testC_NotionCreationW3);
  await runTest('D · Conflict → Notion (later ts) wins', testD_ConflictNotionWins);
  await runTest('E · Conflict tie → Obsidian wins', testE_ConflictTieObsidianWins);
  await runTest('F · W1 rate budget abort (200 tasks)', testF_RateBudgetAbortW1);
  await runTest('G · Orphan Morgen completion skipped', testG_OrphanMorgenCompletion);
  await runTest('H · Unicode / long titles / hash stability', testH_UnicodeLongTitles);
  await runTest('I · W2 safety rail (>50% flip ratio)', testI_SafetyRailFlipRatio);
  await runTest('J · isSafePath allowlist validator', testJ_IsSafePath);
  await runTest('K · parseArea ↔ areaKeyToNotionLabel round-trip', testK_ParseAreaRoundTrip);
  await runTest('L · parseObsidianTasks skips fenced code blocks', testL_FencedCodeBlockSkip);

  process.stderr.write('\n' + '─'.repeat(60) + '\n');
  process.stderr.write('  Test Matrix\n');
  process.stderr.write('─'.repeat(60) + '\n');
  const passed = RESULTS.filter((r) => r.status === 'pass').length;
  const failed = RESULTS.filter((r) => r.status === 'fail').length;
  RESULTS.forEach((r) => {
    const pad = r.name.padEnd(52);
    process.stderr.write(`  ${pad}  ${r.status.toUpperCase()}\n`);
  });
  process.stderr.write('─'.repeat(60) + '\n');
  process.stderr.write(`  ${passed} passed · ${failed} failed\n\n`);

  process.exit(failed);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(99);
});

/**
 * sync-helpers.js — CANONICAL shared library for Obsidian ↔ Notion ↔ Morgen sync
 *
 * Locked 2026-04-14 after the 15-agent swarm cleanup. This is the ONE source
 * of truth. W1/W2/W3 Code nodes inline this verbatim. Scripts require() it.
 *
 * LOCKED DECISIONS (do not relitigate):
 *   - Hash: SHA256(sourceFile::text::priority_int::due::scheduled).slice(0,24)
 *   - Priority: integer (1/2/5/7/9), null → '0'
 *   - Dates: bare YYYY-MM-DD (slice(0,10)) before hashing
 *   - Area names: LITERAL Notion select values with number prefix + U+00B7 dot
 *   - sync-state shape: { _version, _tagCache, entries: { <hash>: {...} } }
 *   - Parser: fenced-code-block aware (skips ```tasks query blocks)
 *
 * Consumed by:
 *   - n8n Workflow 1 (Obsidian-Git-Task-Sync) — inlined
 *   - n8n Workflow 2 (Morgen-Task-Completion-Sync) — inlined
 *   - n8n Workflow 3 (Notion-Done-To-Obsidian-Sync) — inlined
 *   - 08-Tasks/scripts/morgen-backfill.js — via require
 *   - 08-Tasks/scripts/sync-e2e-tests.js — via require
 */

'use strict';

const crypto = require('crypto');

// ===========================================================================
// Priority mapping
// ===========================================================================
// Obsidian Tasks plugin emoji ↔ Morgen int ↔ Notion select label.
// Canonical mapping:
//   🔺 highest → 1 → "🔺 Highest"
//   ⏫ high    → 2 → "⏫ High"
//   🔼 medium  → 5 → "🔼 Medium"
//   🔽 low     → 7 → "🔽 Low"
//   ⏬ lowest  → 9 → "⏬ Lowest"
// 0 = undefined/none (Morgen default)
const PRIORITY_EMOJI_TO_INT = Object.freeze({
  '🔺': 1, '⏫': 2, '🔼': 5, '🔽': 7, '⏬': 9,
});
const PRIORITY_INT_TO_EMOJI = Object.freeze({
  1: '🔺', 2: '⏫', 5: '🔼', 7: '🔽', 9: '⏬',
});
const PRIORITY_INT_TO_NOTION = Object.freeze({
  1: '🔺 Highest', 2: '⏫ High', 5: '🔼 Medium', 7: '🔽 Low', 9: '⏬ Lowest',
});
const PRIORITY_NOTION_TO_INT = Object.freeze({
  '🔺 Highest': 1, '⏫ High': 2, '🔼 Medium': 5, '🔽 Low': 7, '⏬ Lowest': 9,
});

function parseObsidianPriority(emoji) {
  if (emoji == null) return 0;
  const k = String(emoji);
  return Object.prototype.hasOwnProperty.call(PRIORITY_EMOJI_TO_INT, k)
    ? PRIORITY_EMOJI_TO_INT[k] : 0;
}
function morgenPriorityToObsidian(intVal) {
  const n = Number(intVal);
  if (!Number.isFinite(n)) return '';
  return Object.prototype.hasOwnProperty.call(PRIORITY_INT_TO_EMOJI, n)
    ? PRIORITY_INT_TO_EMOJI[n] : '';
}
function morgenPriorityToNotion(intVal) {
  const n = Number(intVal);
  if (!Number.isFinite(n)) return null;
  return Object.prototype.hasOwnProperty.call(PRIORITY_INT_TO_NOTION, n)
    ? PRIORITY_INT_TO_NOTION[n] : null;
}
function notionPriorityToInt(label) {
  if (label == null) return 0;
  const k = String(label);
  return Object.prototype.hasOwnProperty.call(PRIORITY_NOTION_TO_INT, k)
    ? PRIORITY_NOTION_TO_INT[k] : 0;
}

// ===========================================================================
// Area mapping — LITERAL Notion select values with number prefix + U+00B7
// ===========================================================================
// Introspected live from the upstream Notion tasks database. These exact
// strings MUST be used when writing to Notion's Area select or the API
// returns 400 (select options are matched by literal name, not ID).
const NOTION_AREAS = Object.freeze({
  URGENT: '01 URGENT',
  GENERAL: '02 GENERAL',
  LORECRAFT: '03 LORECRAFT',
  BLOOM: '04 BLOOM',
  'CART-BLANCHE': '05 CART-BLANCHE',
  'FIDGETCODING-CONTENT': '06 FIDGETCODING · content',
  'FIDGETCODING-MISC-BUILDING': '07 FIDGETCODING · misc-building',
  'FUTURE-SCHEDULING': '08 FUTURE-SCHEDULING',
  'LAVA-NETWORK': '09 LAVA-NETWORK',
  MMA: '10 MMA',
  PARZVL: '11 PARZVL',
  WAGMI: '12 WAGMI',
});
// Reverse: Notion area label → internal area key
const NOTION_AREA_TO_KEY = Object.freeze(
  Object.fromEntries(Object.entries(NOTION_AREAS).map(([k, v]) => [v, k]))
);
// Area key → source file path (relative to repo root, which is also 08-Tasks dir)
const AREA_TO_FILE = Object.freeze({
  URGENT: 'TASKS-URGENT.md',
  GENERAL: 'TASKS-GENERAL.md',
  LORECRAFT: 'TASKS-LORECRAFT.md',
  BLOOM: 'TASKS-BLOOM.md',
  'CART-BLANCHE': 'TASKS-CART-BLANCHE.md',
  'FIDGETCODING-CONTENT': 'FIDGETCODING/content/TASKS-FIDGETCODING-content.md',
  'FIDGETCODING-MISC-BUILDING': 'FIDGETCODING/misc-building/TASKS-FIDGETCODING-misc-building.md',
  'FUTURE-SCHEDULING': 'FUTURE-SCHEDULING/TASKS-FUTURE-SCHEDULING.md',
  'LAVA-NETWORK': 'TASKS-LAVA-NETWORK.md',
  MMA: 'TASKS-MMA.md',
  PARZVL: 'TASKS-PARZVL.md',
  WAGMI: 'TASKS-WAGMI.md',
});

/**
 * parseArea(sourceFilePath) → internal area key (e.g. "FIDGETCODING-CONTENT")
 *
 * Path-based detection. FIDGETCODING parent hub (TASKS-FIDGETCODING.md with no
 * subfolder) is a query-only view and has no inline tasks in practice — if
 * encountered, we return FIDGETCODING-CONTENT as a safe fallback since tasks
 * shouldn't land there.
 */
function parseArea(sourceFilePath) {
  if (sourceFilePath == null) return 'GENERAL';
  const raw = String(sourceFilePath);
  if (!raw) return 'GENERAL';
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^08-Tasks\//, '');

  // FIDGETCODING subareas (check before the parent hub)
  if (/(^|\/)FIDGETCODING\/content\//.test(p)) return 'FIDGETCODING-CONTENT';
  if (/(^|\/)FIDGETCODING\/misc-building\//.test(p)) return 'FIDGETCODING-MISC-BUILDING';
  // Parent hub — query-only, but safe fallback
  if (/(^|\/)FIDGETCODING\/TASKS-FIDGETCODING\.md$/.test(p)) return 'FIDGETCODING-CONTENT';

  // FUTURE-SCHEDULING
  if (/(^|\/)FUTURE-SCHEDULING\//.test(p)) return 'FUTURE-SCHEDULING';

  // Flat TASKS-{AREA}.md
  const seg = p.split('/').pop() || '';
  const m = seg.match(/^TASKS-([A-Za-z0-9][A-Za-z0-9_-]*)\.md$/i);
  if (m) {
    const key = m[1].toUpperCase();
    if (Object.prototype.hasOwnProperty.call(AREA_TO_FILE, key)) return key;
  }
  return 'GENERAL';
}

/** Internal area key → Notion select label */
function areaKeyToNotionLabel(key) {
  return NOTION_AREAS[key] || NOTION_AREAS.GENERAL;
}
/** Notion select label → internal area key */
function notionLabelToAreaKey(label) {
  if (label == null) return 'GENERAL';
  return NOTION_AREA_TO_KEY[label] || 'GENERAL';
}
/** Internal area key → relative source file path (no 08-Tasks/ prefix) */
function areaKeyToFile(key) {
  return AREA_TO_FILE[key] || AREA_TO_FILE.GENERAL;
}

// ===========================================================================
// Morgen tag labels — CLEAN (no number prefix, no dot separator)
// ===========================================================================
// Added 2026-04-15 in response to John Mavrick @ Morgen confirming that task
// lists are being deprecated in favor of tags in the next Morgen app release.
// Morgen's tag chip UI looks best with clean labels; Notion still needs the
// number prefix for sort order. We split the mapping so each side gets the
// presentation it wants.
//
// Multi-value vs single-value: Notion Area is a single-select; Morgen tags are
// multi-valued. We exploit the multi-value nature to add `Urgent` as a co-tag
// on high-priority tasks (🔺 priority=1 or ⏫ priority=2) regardless of which
// file they live in — something the single-value Notion Area could not express.
const MORGEN_AREAS = Object.freeze({
  URGENT: 'Urgent',
  GENERAL: 'General',
  LORECRAFT: 'Lorecraft',
  BLOOM: 'Bloom',
  'CART-BLANCHE': 'Cart-Blanche',
  'FIDGETCODING-CONTENT': 'Fidgetcoding-Content',
  'FIDGETCODING-MISC-BUILDING': 'Fidgetcoding-Building',
  'FUTURE-SCHEDULING': 'Future-Scheduling',
  'LAVA-NETWORK': 'Lava-Network',
  MMA: 'MMA',
  PARZVL: 'Parzvl',
  WAGMI: 'WAGMI',
});

/** Internal area key → Morgen tag label (clean, no number prefix) */
function areaKeyToMorgenLabel(key) {
  return MORGEN_AREAS[key] || MORGEN_AREAS.GENERAL;
}

/**
 * getDesiredMorgenTagLabels(task) → sorted array of Morgen tag label strings
 *
 * Derives the full tag set for a task: always includes the file-derived area
 * tag, plus 'Urgent' when priority is 🔺 (1) or ⏫ (2). URGENT-file tasks
 * already map to 'Urgent' via areaKeyToMorgenLabel, so the Set.add() is a
 * no-op in that case — no duplicates possible.
 *
 * The returned array is sorted so sameTagLabelSet comparisons are stable.
 */
function getDesiredMorgenTagLabels(task) {
  const labels = new Set();
  labels.add(areaKeyToMorgenLabel(task && task.area));
  const p = task && task.priority;
  if (p === 1 || p === 2) labels.add(MORGEN_AREAS.URGENT);
  return Array.from(labels).sort();
}

/**
 * sameTagLabelSet(a, b) → true if two label arrays represent the same set.
 *
 * Order-insensitive comparison; both inputs must be arrays (returns false on
 * any non-array, including null/undefined). Used by W1 change detection to
 * decide whether to push a tag update to Morgen.
 */
function sameTagLabelSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = a.slice().sort();
  const sb = b.slice().sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

// ===========================================================================
// Path safety — allowlist check (Agent 8 S1 fix)
// ===========================================================================
const SAFE_PATH_RE = /^(TASKS-(URGENT|GENERAL|LORECRAFT|BLOOM|CART-BLANCHE|LAVA-NETWORK|MMA|PARZVL|WAGMI)\.md|FIDGETCODING\/(content|misc-building)\/TASKS-FIDGETCODING-(content|misc-building)\.md|FIDGETCODING\/TASKS-FIDGETCODING\.md|FUTURE-SCHEDULING\/TASKS-FUTURE-SCHEDULING\.md)$/;

/**
 * isSafePath(p) — true if p is a known task-file path within the allowlist.
 * Used to guard any filesystem write against a user-controlled path string
 * (e.g. a Notion Source File field an attacker could set to `../../etc/passwd`).
 */
function isSafePath(p) {
  if (typeof p !== 'string') return false;
  if (p.includes('..') || p.includes('\\') || p.startsWith('/')) return false;
  // Accept with or without 08-Tasks/ prefix
  const normalized = p.replace(/^08-Tasks\//, '');
  return SAFE_PATH_RE.test(normalized);
}

// ===========================================================================
// Hashing — the single anchor for every upsert decision
// ===========================================================================
// taskHash = SHA256(sourceFile::text::priority_int::due_bare::scheduled_bare).slice(0,24)
//
// - priority is ALWAYS the integer form (0 when missing), never the label
// - due/scheduled are ALWAYS bare YYYY-MM-DD (slice 0,10), never full ISO
// - null/undefined serialize as '0' for priority, '' for dates
// - text is the cleaned body (priority/date emojis already stripped)
function computeTaskHash(input) {
  const i = input || {};
  const parts = [
    i.sourceFile == null ? '' : String(i.sourceFile),
    i.text == null ? '' : String(i.text),
    i.priority == null ? '0' : String(parseInt(i.priority, 10) || 0),
    i.due == null ? '' : String(i.due).slice(0, 10),
    i.scheduled == null ? '' : String(i.scheduled).slice(0, 10),
  ];
  return crypto.createHash('sha256').update(parts.join('::'), 'utf8').digest('hex').slice(0, 24);
}

/**
 * computeLineHash(rawLine) — hash of the literal markdown line after stripping
 * trailing whitespace. Used by W2/W3 to detect whether the source file still
 * matches what the mapping recorded (drift detection).
 */
function computeLineHash(rawLine) {
  const s = rawLine == null ? '' : String(rawLine).replace(/\s+$/, '');
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

// ===========================================================================
// Obsidian Tasks parser — fenced-code-block aware
// ===========================================================================
const TASK_LINE_RE = /^(\s*)([-*+])\s+\[([ xX/\-!?*])\]\s+(.*)$/;
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
const FENCE_RE = /^(\s*)(```|~~~)/;
const PRIO_EMOJIS = ['🔺', '⏫', '🔼', '🔽', '⏬'];

function extractDate(text, emoji) {
  if (!text) return null;
  const idx = text.indexOf(emoji);
  if (idx === -1) return null;
  const tail = text.slice(idx + emoji.length, idx + emoji.length + 32);
  const m = tail.match(DATE_RE);
  return m ? m[1] : null;
}
function extractPriorityEmoji(text) {
  if (!text) return '';
  for (const e of PRIO_EMOJIS) {
    if (text.indexOf(e) !== -1) return e;
  }
  return '';
}
function extractRecurrence(text) {
  if (!text) return null;
  const idx = text.indexOf('🔁');
  if (idx === -1) return null;
  const tail = text.slice(idx + '🔁'.length);
  const stopRe = /[📅⏳🛫✅⏫🔺🔼🔽⏬🆔]/;
  const si = tail.search(stopRe);
  const rule = (si === -1 ? tail : tail.slice(0, si)).trim();
  return rule || null;
}

// Extract the Obsidian Tasks plugin 🆔 field. Matches `m-<8hex>` format
// which identifies Morgen-sync-owned IDs. User-typed or plugin-generated IDs
// in other formats are IGNORED (returned as null) so we don't clobber them.
function extractMorgenId(text) {
  if (!text) return null;
  const idx = text.indexOf('🆔');
  if (idx === -1) return null;
  const tail = text.slice(idx + '🆔'.length);
  const m = tail.match(/^\s*(m-[0-9a-f]{8})\b/);
  return m ? m[1] : null;
}
function extractAnyId(text) {
  if (!text) return null;
  const idx = text.indexOf('🆔');
  if (idx === -1) return null;
  const tail = text.slice(idx + '🆔'.length);
  const m = tail.match(/^\s*([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
function generateMorgenId() {
  return 'm-' + crypto.randomBytes(4).toString('hex');
}
function insertMorgenId(rawLine, newId) {
  if (rawLine == null) return '';
  if (newId == null || newId === '') return String(rawLine);
  const raw = String(rawLine);
  if (raw.indexOf('🆔') !== -1) return raw;
  const m = raw.match(TASK_LINE_RE);
  if (!m) return raw;
  const indent = m[1] || '';
  const bullet = m[2] || '-';
  const statusChar = m[3];
  const body = m[4] || '';
  const prefix = indent + bullet + ' [' + statusChar + '] ';
  const token = '🆔 ' + String(newId);
  const anchors = ['✅', '📅', '⏳', '🛫', '🔁'];
  let insertAt = -1;
  for (const a of anchors) {
    const idx = body.indexOf(a);
    if (idx !== -1 && (insertAt === -1 || idx < insertAt)) insertAt = idx;
  }
  let newBody;
  if (insertAt === -1) {
    newBody = body.replace(/\s+$/, '') + ' ' + token;
  } else {
    const head = body.slice(0, insertAt).replace(/\s+$/, '');
    const tail = body.slice(insertAt);
    newBody = head + ' ' + token + ' ' + tail;
  }
  newBody = newBody.replace(/\s+/g, ' ').replace(/^\s+/, '');
  return prefix + newBody;
}
function stripTaskMetadata(text) {
  if (!text) return '';
  let out = String(text);
  out = out.replace(/[🔺⏫🔼🔽⏬]/g, ' ');
  out = out.replace(/[📅⏳🛫✅]\s*\d{4}-\d{2}-\d{2}/g, ' ');
  out = out.replace(/🔁[^📅⏳🛫✅⏫🔺🔼🔽⏬🆔\n]*/g, ' ');
  out = out.replace(/🆔\s*[A-Za-z0-9_-]+/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * parseObsidianTasks(markdown, sourceFilePath)
 *   → [{text, priority, due, scheduled, start, done, doneDate, recurrence,
 *       lineNo, rawLine, area, sourceFile, hash}]
 *
 * Fenced-code-block aware: lines inside ```...``` or ~~~...~~~ blocks are
 * skipped so the `` ```tasks `` query blocks in hub files don't get parsed
 * as real tasks.
 *
 * Never throws — malformed input → empty list or partial results.
 */
function parseObsidianTasks(markdown, sourceFilePath) {
  const out = [];
  if (markdown == null) return out;
  let text;
  try { text = String(markdown); } catch (_) { return out; }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = text.split('\n');
  const area = parseArea(sourceFilePath);
  const sourceFile = sourceFilePath == null ? '' : String(sourceFilePath).replace(/^08-Tasks\//, '');

  let inFence = false;
  let fenceMarker = null;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const fm = rawLine.match(FENCE_RE);
    if (fm) {
      if (!inFence) { inFence = true; fenceMarker = fm[2]; }
      else if (rawLine.trim().startsWith(fenceMarker)) { inFence = false; fenceMarker = null; }
      continue;
    }
    if (inFence) continue;

    let m;
    try { m = rawLine.match(TASK_LINE_RE); } catch (_) { m = null; }
    if (!m) continue;

    const statusChar = m[3];
    const body = m[4] || '';
    const done = statusChar === 'x' || statusChar === 'X';

    const priorityEmoji = extractPriorityEmoji(body);
    const priority = parseObsidianPriority(priorityEmoji);
    const due = extractDate(body, '📅');
    const scheduled = extractDate(body, '⏳');
    const start = extractDate(body, '🛫');
    const doneDate = extractDate(body, '✅');
    const recurrence = extractRecurrence(body);
    const morgenId = extractMorgenId(body);
    const cleanText = stripTaskMetadata(body);

    const task = {
      text: cleanText,
      priority,
      due: due || null,
      scheduled: scheduled || null,
      start: start || null,
      done,
      doneDate: doneDate || null,
      recurrence,
      morgenId: morgenId || null,
      lineNo: i + 1,
      rawLine,
      area,
      sourceFile,
    };
    task.hash = computeTaskHash(task);
    out.push(task);
  }
  return out;
}

// ===========================================================================
// sync-state.json shape + helpers
// ===========================================================================
// Schema (v1, locked):
// {
//   "_version": 1,
//   "_tagCache": { "<notionAreaLabel>": "<morgenTagUUID>" },
//   "entries": {
//     "<taskHash>": {
//       "hash": "<24hex>",
//       "sourceFile": "TASKS-URGENT.md",    // relative, no 08-Tasks/ prefix
//       "lineNo": 17,
//       "lineHash": "<16hex>",              // computeLineHash of rawLine
//       "text": "...",
//       "area": "URGENT",                    // internal key
//       "priority": 2,                       // int
//       "due": "2026-04-15",                 // bare YYYY-MM-DD or null
//       "scheduled": null,
//       "notionPageId": "abc-1234-...",      // null if not mirrored
//       "morgenTaskId": "tsk_abc...",        // null if not mirrored
//       "morgenEventId": null,
//       "createdAt": "...",
//       "updatedAt": "...",
//       "lastSyncedAt": "...",
//       "archived": false
//     }
//   }
// }
const SYNC_STATE_VERSION = 1;

function emptySyncState() {
  return { _version: SYNC_STATE_VERSION, _tagCache: {}, entries: {} };
}

function loadSyncState(rawJsonString) {
  if (rawJsonString == null || rawJsonString === '') return emptySyncState();
  let parsed;
  try { parsed = JSON.parse(String(rawJsonString)); } catch (_) { return emptySyncState(); }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptySyncState();
  const s = emptySyncState();
  if (typeof parsed._version === 'number') s._version = parsed._version;
  if (parsed._tagCache && typeof parsed._tagCache === 'object' && !Array.isArray(parsed._tagCache)) {
    s._tagCache = Object.assign({}, parsed._tagCache);
  }
  if (parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) {
    s.entries = {};
    for (const k of Object.keys(parsed.entries)) {
      const v = parsed.entries[k];
      if (v && typeof v === 'object') s.entries[k] = Object.assign({}, v);
    }
  }
  return s;
}

function serializeSyncState(state) {
  const safe = state && typeof state === 'object' ? state : emptySyncState();
  return JSON.stringify({
    _version: typeof safe._version === 'number' ? safe._version : SYNC_STATE_VERSION,
    _tagCache: safe._tagCache && typeof safe._tagCache === 'object' ? safe._tagCache : {},
    entries: safe.entries && typeof safe.entries === 'object' ? safe.entries : {},
  }, null, 2) + '\n';
}

function upsertMappingEntry(state, hash, patch) {
  const base = state && typeof state === 'object' ? state : emptySyncState();
  const nextEntries = Object.assign({}, base.entries || {});
  const existing = nextEntries[hash] || {};
  const nowIso = new Date().toISOString();
  nextEntries[hash] = Object.assign(
    { hash, notionPageId: null, morgenTaskId: null, morgenEventId: null,
      createdAt: existing.createdAt || nowIso, archived: false },
    existing,
    patch || {},
    { hash, updatedAt: nowIso, lastSyncedAt: nowIso },
  );
  return {
    _version: typeof base._version === 'number' ? base._version : SYNC_STATE_VERSION,
    _tagCache: Object.assign({}, base._tagCache || {}),
    entries: nextEntries,
  };
}

function findByNotionId(state, notionPageId) {
  if (!state || !state.entries || notionPageId == null) return null;
  const target = String(notionPageId);
  for (const hash of Object.keys(state.entries)) {
    const e = state.entries[hash];
    if (e && e.notionPageId && String(e.notionPageId) === target) return { hash, entry: e };
  }
  return null;
}
function findByMorgenId(state, morgenTaskId) {
  if (!state || !state.entries || morgenTaskId == null) return null;
  const target = String(morgenTaskId);
  for (const hash of Object.keys(state.entries)) {
    const e = state.entries[hash];
    if (e && ((e.morgenTaskId && String(e.morgenTaskId) === target) ||
              (e.morgenEventId && String(e.morgenEventId) === target))) {
      return { hash, entry: e };
    }
  }
  return null;
}

// ===========================================================================
// Line reconstruction + mutation
// ===========================================================================
function reconstructObsidianLine(task, existingLine) {
  const t = task || {};
  let indent = '';
  let bullet = '-';
  let statusChar = t.done ? 'x' : ' ';

  if (typeof existingLine === 'string' && existingLine.length > 0) {
    const m = existingLine.match(TASK_LINE_RE);
    if (m) {
      indent = m[1] || '';
      bullet = m[2] || '-';
      if (t.done === undefined) {
        statusChar = (m[3] === 'x' || m[3] === 'X') ? 'x' : ' ';
      }
    }
  }

  const tokens = [];
  if (t.text != null) tokens.push(String(t.text).trim());
  const prioEmoji = morgenPriorityToObsidian(t.priority);
  if (prioEmoji) tokens.push(prioEmoji);
  if (t.due) tokens.push('📅 ' + String(t.due).slice(0, 10));
  if (t.scheduled) tokens.push('⏳ ' + String(t.scheduled).slice(0, 10));
  if (t.start) tokens.push('🛫 ' + String(t.start).slice(0, 10));
  if (t.recurrence) tokens.push('🔁 ' + t.recurrence);
  if (t.done && t.doneDate) tokens.push('✅ ' + String(t.doneDate).slice(0, 10));

  return indent + bullet + ' [' + statusChar + '] ' + tokens.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * flipTaskDone(line) — minimal mutation: flip "[ ]" → "[x]" and append
 * "✅ YYYY-MM-DD" if not already present. Preserves indentation, bullet,
 * and everything else verbatim.
 */
function flipTaskDone(line) {
  if (line == null) return '';
  const raw = String(line);
  const m = raw.match(TASK_LINE_RE);
  if (!m) return raw;
  const indent = m[1] || '';
  const bullet = m[2] || '-';
  const body = m[4] || '';
  const today = new Date().toISOString().slice(0, 10);
  let newBody = body;
  if (newBody.indexOf('✅') === -1) {
    newBody = newBody.replace(/\s+$/, '') + ' ✅ ' + today;
  }
  return indent + bullet + ' [x] ' + newBody.trim();
}

// ===========================================================================
// Morgen date conversion
// ===========================================================================
// Morgen task `due` accepts full ISO with Z or offset. Events `start` requires
// LocalDateTime + separate timeZone field. For tasks we use task-style: the
// bare date becomes `YYYY-MM-DDT09:00:00` (9am local) as a sensible default.
function dateToMorgenLocal(dateStr) {
  if (dateStr == null || dateStr === '') return null;
  const s = String(dateStr).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T09:00:00';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (m) return m[1] + 'T' + m[2];
  const m2 = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (m2) return m2[1] + 'T' + m2[2] + ':00';
  return null;
}

// ===========================================================================
// Commit message helpers — [bot:Wx] prefix prevents echo loops
// ===========================================================================
// [bot:daemon] is emitted by src/auto-commit.js on every launchd-ticked
// auto-commit so W1's echo-loop guard can filter daemon-originated pushes.
const BOT_COMMIT_PREFIXES = Object.freeze(['[bot:W1]', '[bot:W2]', '[bot:W3]', '[bot:backfill]', '[bot:daemon]']);
function isBotCommitMessage(msg) {
  if (msg == null) return false;
  const s = String(msg);
  return BOT_COMMIT_PREFIXES.some(p => s.startsWith(p));
}

// ===========================================================================
// Exports
// ===========================================================================
module.exports = {
  // Priority
  parseObsidianPriority,
  morgenPriorityToObsidian,
  morgenPriorityToNotion,
  notionPriorityToInt,
  // Area
  parseArea,
  areaKeyToNotionLabel,
  notionLabelToAreaKey,
  areaKeyToFile,
  areaKeyToMorgenLabel,
  getDesiredMorgenTagLabels,
  sameTagLabelSet,
  // Path safety
  isSafePath,
  // Hashing
  computeTaskHash,
  computeLineHash,
  // Parsing
  parseObsidianTasks,
  extractMorgenId,
  extractAnyId,
  generateMorgenId,
  insertMorgenId,
  // Sync state
  emptySyncState,
  loadSyncState,
  serializeSyncState,
  upsertMappingEntry,
  findByNotionId,
  findByMorgenId,
  // Line mutation
  reconstructObsidianLine,
  flipTaskDone,
  // Morgen helpers
  dateToMorgenLocal,
  // Commit safety
  isBotCommitMessage,
  BOT_COMMIT_PREFIXES,
  // Constants
  _constants: {
    PRIORITY_EMOJI_TO_INT,
    PRIORITY_INT_TO_EMOJI,
    PRIORITY_INT_TO_NOTION,
    PRIORITY_NOTION_TO_INT,
    NOTION_AREAS,
    NOTION_AREA_TO_KEY,
    AREA_TO_FILE,
    MORGEN_AREAS,
    SAFE_PATH_RE,
    SYNC_STATE_VERSION,
    TASK_LINE_RE,
    FENCE_RE,
  },
};

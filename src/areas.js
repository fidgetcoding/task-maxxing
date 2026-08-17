// Area table — the mapping between your Obsidian task files, your Morgen tags,
// and your Notion Area labels.
//
// These are YOUR project names, so this ships with only two generic areas
// (URGENT, GENERAL) and reads the rest from the TASKMAXXING_AREAS env var.
// Hardcoding a real area list would both publish the author's client roster and
// be wrong for every other user.
//
// TASKMAXXING_AREAS is a JSON array:
//
//   [
//     { "key": "URGENT",  "file": "TASKS-URGENT.md",
//       "morgenLabel": "Urgent",  "notionLabel": "01 URGENT" },
//     { "key": "GENERAL", "file": "TASKS-GENERAL.md",
//       "morgenLabel": "General", "notionLabel": "02 GENERAL" },
//     { "key": "PROJECT-A", "file": "TASKS-PROJECT-A.md",
//       "morgenLabel": "Project A", "notionLabel": "03 PROJECT-A" },
//     { "key": "NESTED", "file": "SUBDIR/TASKS-NESTED.md",
//       "morgenLabel": "Nested", "notionLabel": "04 NESTED",
//       "pathPrefix": "SUBDIR/" }
//   ]
//
//   key          internal area key, uppercase; also matched as TASKS-<key>.md
//   file         path relative to your tasks directory
//   morgenLabel  Morgen tag label (clean, no number prefix)
//   notionLabel  Notion select label (number prefix keeps sort order)
//   pathPrefix   optional; any path under this prefix maps to this area
//   aliasFiles   optional extra paths that resolve to this area and are treated
//                as safe to write (e.g. a query-only parent hub note)
//
// A GENERAL entry is required — it is the fallback for unrecognised paths. If
// the config is missing or malformed the built-in defaults are used, so the sync
// degrades to "everything is GENERAL" rather than misfiling tasks into the wrong
// project.

'use strict';

const DEFAULT_AREAS = [
  { key: 'URGENT', file: 'TASKS-URGENT.md', morgenLabel: 'Urgent', notionLabel: '01 URGENT',
    pathPrefix: null, aliasFiles: [] },
  { key: 'GENERAL', file: 'TASKS-GENERAL.md', morgenLabel: 'General', notionLabel: '02 GENERAL',
    pathPrefix: null, aliasFiles: [] },
];

let cache = null;
let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.error(`[task-maxxing] TASKMAXXING_AREAS: ${message} — using built-in defaults.`);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Any invalid entry rejects the whole config. A half-applied area table would
// file tasks under the wrong project, which is worse than falling back to
// GENERAL for everything.
function parseAreas(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnOnce(`not valid JSON (${err.message})`);
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    warnOnce('expected a non-empty JSON array of area objects');
    return null;
  }

  const seenKey = new Set();
  const seenFile = new Set();
  const areas = [];

  for (const e of parsed) {
    if (!e || typeof e !== 'object') {
      warnOnce('every entry must be an object');
      return null;
    }
    for (const f of ['key', 'file', 'morgenLabel', 'notionLabel']) {
      if (!isNonEmptyString(e[f])) {
        warnOnce(`every entry needs a non-empty "${f}"`);
        return null;
      }
    }
    const key = e.key.trim().toUpperCase();
    const file = e.file.trim().replace(/^\.\//, '');
    if (seenKey.has(key)) {
      warnOnce(`duplicate key "${key}"`);
      return null;
    }
    if (seenFile.has(file)) {
      warnOnce(`duplicate file "${file}"`);
      return null;
    }
    // Reject traversal in configured paths before they reach the allowlist.
    if (file.includes('..') || file.startsWith('/')) {
      warnOnce(`unsafe file path "${file}"`);
      return null;
    }
    // Extra paths that resolve to this area — same traversal rules as `file`.
    const aliasFiles = [];
    if (Array.isArray(e.aliasFiles)) {
      for (const raw of e.aliasFiles) {
        if (!isNonEmptyString(raw)) continue;
        const a = raw.trim().replace(/^\.\//, '');
        if (a.includes('..') || a.startsWith('/')) {
          warnOnce(`unsafe aliasFile "${a}" on area "${key}"`);
          return null;
        }
        aliasFiles.push(a);
      }
    }

    seenKey.add(key);
    seenFile.add(file);
    areas.push({
      key,
      file,
      morgenLabel: e.morgenLabel.trim(),
      notionLabel: e.notionLabel.trim(),
      pathPrefix: isNonEmptyString(e.pathPrefix) ? e.pathPrefix.trim() : null,
      aliasFiles,
    });
  }

  if (!seenKey.has('GENERAL')) {
    warnOnce('a GENERAL area is required as the fallback');
    return null;
  }
  return areas;
}

function build(areas) {
  const AREA_TO_FILE = Object.freeze(Object.fromEntries(areas.map((a) => [a.key, a.file])));
  const NOTION_AREAS = Object.freeze(Object.fromEntries(areas.map((a) => [a.key, a.notionLabel])));
  const MORGEN_AREAS = Object.freeze(Object.fromEntries(areas.map((a) => [a.key, a.morgenLabel])));
  const NOTION_AREA_TO_KEY = Object.freeze(
    Object.fromEntries(areas.map((a) => [a.notionLabel, a.key]))
  );
  // Built from the configured paths so the allowlist can never drift out of sync
  // with the area table — the drift is what a hand-maintained regex invites.
  const safePaths = areas.flatMap((a) => [a.file, ...(a.aliasFiles || [])]);
  const SAFE_PATH_RE = new RegExp(`^(${safePaths.map(escapeRe).join('|')})$`);
  return Object.freeze({
    areas: Object.freeze(areas),
    AREA_TO_FILE,
    NOTION_AREAS,
    MORGEN_AREAS,
    NOTION_AREA_TO_KEY,
    SAFE_PATH_RE,
  });
}

function getAreaConfig() {
  if (cache) return cache;
  const raw = process.env.TASKMAXXING_AREAS;
  const parsed = isNonEmptyString(raw) ? parseAreas(raw) : null;
  cache = build(parsed || DEFAULT_AREAS);
  return cache;
}

// Test seam — also lets a long-running worker pick up a changed env var.
function _resetAreaConfig() {
  cache = null;
  warned = false;
}

module.exports = { getAreaConfig, _resetAreaConfig, DEFAULT_AREAS };

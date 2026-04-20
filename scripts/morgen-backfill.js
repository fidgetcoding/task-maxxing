#!/usr/bin/env node
/**
 * morgen-backfill.js
 *
 * ONE-SHOT backfill: seeds every open Obsidian task under your vault's
 * task directory into Morgen as a native task, and initializes
 * .sync-state.json with { hash -> { notionPageId, morgenTaskId, ... } }
 * mappings so downstream n8n workflows can dedupe.
 *
 * This script is a THIN wrapper around `../src/sync-helpers.js` — the one
 * locked canonical library. Do NOT re-inline parsing, hashing, area
 * resolution, or state shape here. If something needs to change, change
 * it in sync-helpers.js (after agreeing it's not a contract break) and
 * this script inherits it automatically.
 *
 * Environment variables (required unless overridden by flags):
 *   MORGEN_API_KEY   Your Morgen API key (or pass --api-key)
 *   VAULT_PATH       Absolute path to your Obsidian 06-Tasks dir, i.e. the
 *                    dir that contains TASKS-URGENT.md etc. (or pass --vault)
 *
 * Usage:
 *   VAULT_PATH="$HOME/path/to/vault/06-Tasks" \
 *   MORGEN_API_KEY="…" \
 *     node scripts/morgen-backfill.js --dry-run
 *
 *   node scripts/morgen-backfill.js --vault "$HOME/vault/06-Tasks" --dry-run
 *   node scripts/morgen-backfill.js --verbose           # live, chatty
 *   node scripts/morgen-backfill.js --api-key <KEY>     # override env
 *   node scripts/morgen-backfill.js --max-points 85     # rate-limit budget cap
 *
 * Exit codes:
 *   0  success (or dry run ok)
 *   1  runtime / API error
 *   2  budget-abort (would exceed --max-points)
 *
 * Rate limit (hard): 300 pts / 15 min sliding window, shared account-wide
 * (Morgen raised this from 100 → 300 on 2026-04-15).
 *   tags/list   = 10 pts
 *   tags/create = 1 pt
 *   tasks/create= 1 pt
 * Default --max-points 85 is conservative — leaves ~215pt headroom for
 * other callers in-window. You can safely raise it to ~280 if you know
 * nothing else is hammering Morgen during the backfill.
 *
 * NOTE: This script does NOT commit .sync-state.json. It writes the file
 * to disk only. Review the diff and commit manually when ready.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const helpers = require('../src/sync-helpers');
const {
  parseObsidianTasks,
  areaKeyToNotionLabel,
  loadSyncState,
  serializeSyncState,
  upsertMappingEntry,
  dateToMorgenLocal,
} = helpers;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILENAME = '.sync-state.json';
const SCRIPTS_DIRNAME = 'scripts';

// Files to skip even though they're .md under the tasks root
const SKIP_FILES = new Set(['README.md', 'SETUP.md', 'SYNC-STATE-FORMAT.md', 'TASKS.md']);

const MORGEN_HOST = 'api.morgen.so';
const MORGEN_BASE_PATH = '/v3';
const DEFAULT_TASK_LIST_ID = 'inbox';

// Morgen API point costs
const POINTS_TAGS_LIST = 10;
const POINTS_TAGS_CREATE = 1;
const POINTS_TASKS_CREATE = 1;

const PROGRESS_EVERY = 5;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dryRun: false,
    verbose: false,
    apiKey: process.env.MORGEN_API_KEY || '',
    vaultPath: process.env.VAULT_PATH || '',
    maxPoints: 85,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--api-key') args.apiKey = argv[++i] || '';
    else if (a === '--vault') args.vaultPath = argv[++i] || '';
    else if (a === '--max-points') args.maxPoints = parseInt(argv[++i], 10) || 85;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      log.err(`Unknown flag: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`
morgen-backfill.js — seed Obsidian tasks into Morgen as native tasks

REQUIRED (env or flag):
  VAULT_PATH / --vault <dir>     Absolute path to your 06-Tasks directory
  MORGEN_API_KEY / --api-key <k> Morgen API key (required for LIVE runs)

FLAGS:
  --dry-run           Print all planned payloads + points cost, make NO API calls
  --max-points <n>    Hard cap on rate-limit budget (default 85, of 300)
  --verbose, -v       Log every API call
  --help, -h          Show this message

Files:
  reads  <VAULT_PATH>/**/*.md    (skips scripts/, README, SETUP, SYNC-STATE-FORMAT, TASKS.md)
  writes <VAULT_PATH>/${STATE_FILENAME}   (NOT committed — review and commit manually)

`);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = {
  info: (...m) => process.stdout.write(`[info ] ${m.join(' ')}\n`),
  ok: (...m) => process.stdout.write(`[ ok  ] ${m.join(' ')}\n`),
  warn: (...m) => process.stderr.write(`[warn ] ${m.join(' ')}\n`),
  err: (...m) => process.stderr.write(`[ERROR] ${m.join(' ')}\n`),
  step: (...m) => process.stdout.write(`\n>>> ${m.join(' ')}\n`),
  verbose: (flag, ...m) => { if (flag) process.stderr.write(`[verb ] ${m.join(' ')}\n`); },
};

// ---------------------------------------------------------------------------
// Recursive markdown walker
// ---------------------------------------------------------------------------

function walkMarkdown(dir) {
  const out = [];
  function rec(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      log.warn(`cannot read dir ${d}: ${e.message}`);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .sync-state.json, .git, .github
      if (e.isDirectory()) {
        if (e.name === SCRIPTS_DIRNAME) continue; // skip ourselves
        rec(path.join(d, e.name));
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (SKIP_FILES.has(e.name)) continue;
        out.push(path.join(d, e.name));
      }
    }
  }
  rec(dir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Morgen HTTP client (zero deps)
// ---------------------------------------------------------------------------

// One HTTP attempt. Returns {status, body, headers} on ANY HTTP response
// (never rejects on non-2xx — that's morgenRequest()'s job).
// Rejects only on socket / network error.
function morgenRequestOnce(apiKey, method, pathSuffix, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      host: MORGEN_HOST,
      port: 443,
      path: `${MORGEN_BASE_PATH}${pathSuffix}`,
      method,
      headers: {
        'Authorization': `ApiKey ${apiKey}`,
        'Accept': 'application/json',
        'User-Agent': 'task-maxxing/backfill-0.2',
      },
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request(options, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (_) { parsed = chunks; }
        resolve({ status, body: parsed, headers: res.headers || {} });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Retry config for 429 handling.
// Complements (does not replace) the pre-flight --max-points budget check:
// budget keeps us from *starting* a too-expensive run; retry handles the
// case where another Morgen caller (the app itself, another automation)
// drains the shared 300pt window between our budget check and our writes.
const MORGEN_MAX_RETRIES = 3;
const MORGEN_BACKOFF_BASE_MS = 2000;
const MORGEN_BACKOFF_CAP_MS  = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function morgenRequest(apiKey, method, pathSuffix, body) {
  for (let attempt = 0; attempt <= MORGEN_MAX_RETRIES; attempt++) {
    const { status, body: parsed, headers } = await morgenRequestOnce(apiKey, method, pathSuffix, body);
    if (status >= 200 && status < 300) return parsed;

    // 429 → back off and retry. Prefer server-supplied wait time:
    //   - Retry-After (seconds per RFC 7231)
    //   - ratelimit-reset (seconds; Morgen uses this — IETF draft-style)
    // Fall back to exponential (2s, 4s, 8s, ...), capped at 60s.
    if (status === 429 && attempt < MORGEN_MAX_RETRIES) {
      const retryAfterRaw = headers['retry-after'] || headers['ratelimit-reset'] || '';
      const retryAfterSec = parseInt(retryAfterRaw, 10);
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, MORGEN_BACKOFF_CAP_MS)
        : Math.min(MORGEN_BACKOFF_BASE_MS * Math.pow(2, attempt), MORGEN_BACKOFF_CAP_MS);
      process.stderr.write(
        `[morgen] 429 on ${method} ${pathSuffix} (attempt ${attempt + 1}/${MORGEN_MAX_RETRIES + 1}); ` +
        `waiting ${Math.round(waitMs / 1000)}s before retry\n`
      );
      await sleep(waitMs);
      continue;
    }

    // Any other non-2xx (or 429 after retries exhausted) → throw.
    const msg = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(`Morgen ${method} ${pathSuffix} → ${status}: ${msg}`);
  }
  // Unreachable — the loop above always returns or throws.
  throw new Error(`Morgen ${method} ${pathSuffix} → 429: retries exhausted`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}

/**
 * Build a Morgen tasks/create payload for one parsed task.
 * `tagUuid` is the Morgen tag UUID for this task's Notion area label.
 */
function buildTaskPayload(task, tagUuid) {
  const title = truncate(task.text || '(untitled)', 500);
  const payload = {
    title,
    description: task.rawLine || '',
    taskListId: DEFAULT_TASK_LIST_ID,
    priority: task.priority || 0,
    tags: tagUuid ? [tagUuid] : [],
  };
  const dueLocal = dateToMorgenLocal(task.due);
  if (dueLocal) payload.due = dueLocal;
  return payload;
}

function dumpRemaining(list, failedIdx) {
  const remaining = list.slice(failedIdx);
  if (remaining.length === 0) return;
  log.err('\nRemaining tasks (for manual rerun after window resets):');
  for (const t of remaining) {
    log.err(`  - [${t.area}] ${truncate(t.text, 80)}  (hash=${t.hash})`);
  }
}

function readStateFromDisk(stateFile) {
  if (!fs.existsSync(stateFile)) return loadSyncState(null);
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    return loadSyncState(raw);
  } catch (e) {
    log.warn(`could not read ${stateFile}: ${e.message} — starting fresh`);
    return loadSyncState(null);
  }
}

function writeStateToDisk(stateFile, state) {
  const json = serializeSyncState(state);
  fs.writeFileSync(stateFile, json, 'utf8');
  return Buffer.byteLength(json, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (!args.vaultPath) {
    log.err('no vault path: set VAULT_PATH env var or pass --vault <dir>');
    printHelp();
    process.exit(1);
  }
  const TASKS_ROOT = path.resolve(args.vaultPath);
  if (!fs.existsSync(TASKS_ROOT) || !fs.statSync(TASKS_ROOT).isDirectory()) {
    log.err(`vault path is not a directory: ${TASKS_ROOT}`);
    process.exit(1);
  }
  const STATE_FILE = path.join(TASKS_ROOT, STATE_FILENAME);

  log.step('Obsidian → Morgen backfill');
  log.info(`mode: ${args.dryRun ? 'DRY RUN (no API calls)' : 'LIVE'}`);
  log.info(`vault: ${TASKS_ROOT}`);
  log.info(`max-points budget: ${args.maxPoints}`);
  log.info(`state file: ${STATE_FILE}`);

  // --- discover task files ---
  const files = walkMarkdown(TASKS_ROOT);
  log.info(`task files discovered: ${files.length}`);

  // --- parse all tasks using the canonical parser ---
  const allTasks = [];
  for (const absFile of files) {
    const rel = path.relative(TASKS_ROOT, absFile).split(path.sep).join('/');
    let src;
    try {
      src = fs.readFileSync(absFile, 'utf8');
    } catch (e) {
      log.warn(`read fail ${rel}: ${e.message}`);
      continue;
    }
    const parsed = parseObsidianTasks(src, rel);
    for (const t of parsed) {
      if (t.done) continue; // backfill only mirrors open tasks
      allTasks.push(t);
    }
  }
  log.info(`open tasks parsed: ${allTasks.length}`);

  // --- load existing state, filter out already-synced hashes ---
  let state = readStateFromDisk(STATE_FILE);
  const existingHashes = new Set(Object.keys(state.entries || {}));
  const newTasks = allTasks.filter((t) => !existingHashes.has(t.hash));
  log.info(`previously synced: ${existingHashes.size}`);
  log.info(`new tasks to create: ${newTasks.length}`);

  // --- unique area KEYS + their Notion labels ---
  const areaKeysNeeded = new Set(newTasks.map((t) => t.area));
  const areaLabelsNeeded = new Set(
    Array.from(areaKeysNeeded).map((k) => areaKeyToNotionLabel(k))
  );
  log.info(
    `unique areas in new tasks: ${areaKeysNeeded.size} ` +
    `(${Array.from(areaKeysNeeded).sort().join(', ')})`
  );

  // --- preflight budget math ---
  const cachedLabels = new Set(Object.keys(state._tagCache || {}));
  const labelsToCreate = Array.from(areaLabelsNeeded).filter((l) => !cachedLabels.has(l));
  const projectedPoints =
    POINTS_TAGS_LIST +
    labelsToCreate.length * POINTS_TAGS_CREATE +
    newTasks.length * POINTS_TASKS_CREATE;

  log.step('Point-cost projection');
  log.info(`  tags/list              : ${POINTS_TAGS_LIST} pts`);
  log.info(`  tags/create × ${String(labelsToCreate.length).padStart(2)}       : ${labelsToCreate.length * POINTS_TAGS_CREATE} pts`);
  log.info(`  tasks/create × ${String(newTasks.length).padStart(2)}      : ${newTasks.length * POINTS_TASKS_CREATE} pts`);
  log.info(`  projected TOTAL        : ${projectedPoints} pts  (budget ${args.maxPoints} / ceiling 100)`);

  const projectedCalls =
    1 +                        // tags/list
    labelsToCreate.length +    // tags/create
    newTasks.length;           // tasks/create
  log.info(`  projected API calls    : ${projectedCalls}`);

  // --- projected state-file size ---
  let projectedState = state;
  for (const label of areaLabelsNeeded) {
    if (!projectedState._tagCache[label]) {
      projectedState = {
        ...projectedState,
        _tagCache: { ...projectedState._tagCache, [label]: '00000000-0000-0000-0000-000000000000' },
      };
    }
  }
  for (const t of newTasks) {
    projectedState = upsertMappingEntry(projectedState, t.hash, {
      sourceFile: t.sourceFile,
      lineNo: t.lineNo,
      text: t.text,
      area: t.area,
      priority: t.priority,
      due: t.due,
      scheduled: t.scheduled,
      notionPageId: null,
      morgenTaskId: 'tsk_placeholder000000000000',
      morgenEventId: null,
      archived: false,
    });
  }
  const projectedJson = serializeSyncState(projectedState);
  log.info(
    `  projected ${STATE_FILENAME} size: ${projectedJson.length} bytes ` +
    `(${Object.keys(projectedState.entries).length} entries)`
  );

  // --- budget abort? ---
  if (projectedPoints > args.maxPoints) {
    log.err('');
    log.err(`BUDGET ABORT: projected ${projectedPoints} pts exceeds cap ${args.maxPoints}.`);
    log.err('The Morgen API hard limit is 300 pts / 15-minute sliding window, account-wide.');
    log.err('Split this backfill into batches OR raise --max-points (up to ~280) once the window is clean.');
    log.err(`Suggested batch size: ${Math.max(1, args.maxPoints - POINTS_TAGS_LIST - labelsToCreate.length)} tasks per window.`);
    process.exit(2);
  }

  if (newTasks.length === 0) {
    log.ok(`nothing to do — all tasks already in ${STATE_FILENAME}`);
    if (args.dryRun) log.info('(dry run)');
    process.exit(0);
  }

  // --- DRY RUN: print payloads and exit ---
  if (args.dryRun) {
    log.step('DRY RUN — planned payloads');
    const byArea = {};
    for (const t of newTasks) {
      (byArea[t.area] ||= []).push(t);
    }
    for (const areaKey of Object.keys(byArea).sort()) {
      const list = byArea[areaKey];
      const label = areaKeyToNotionLabel(areaKey);
      log.info(`\n  [${areaKey}] → "${label}" — ${list.length} task(s)`);
      const sample = list[0];
      const payload = buildTaskPayload(sample, '<area-tag-uuid>');
      log.info(`    sample payload: ${JSON.stringify(payload)}`);
      if (list.length > 1) {
        for (let i = 1; i < Math.min(list.length, 3); i++) {
          log.info(`    + ${truncate(list[i].text, 80)}`);
        }
        if (list.length > 3) log.info(`    + … and ${list.length - 3} more`);
      }
    }
    log.step('DRY RUN — summary');
    log.info(`  task files discovered  : ${files.length}`);
    log.info(`  open tasks parsed      : ${allTasks.length}`);
    log.info(`  new tasks to create    : ${newTasks.length}`);
    log.info(`  unique areas           : ${areaKeysNeeded.size}`);
    log.info(`  projected API calls    : ${projectedCalls}`);
    log.info(`  projected point cost   : ${projectedPoints} / ${args.maxPoints}`);
    log.info(`  projected state size   : ${projectedJson.length} bytes`);
    log.ok('dry run complete — no API calls were made');
    process.exit(0);
  }

  // --- LIVE RUN ---
  if (!args.apiKey) {
    log.err('no api key: set MORGEN_API_KEY env var or pass --api-key <KEY>');
    process.exit(1);
  }

  log.step('LIVE — fetching existing tags');
  let tagsList;
  try {
    tagsList = await morgenRequest(args.apiKey, 'GET', '/tags/list', null);
    log.verbose(args.verbose, `tags/list response: ${JSON.stringify(tagsList).slice(0, 300)}`);
  } catch (e) {
    log.err(`tags/list failed: ${e.message}`);
    process.exit(1);
  }
  const tagArray = (tagsList && tagsList.data && tagsList.data.tags) || [];
  const nextTagCache = { ...(state._tagCache || {}) };
  for (const tag of tagArray) {
    if (tag && tag.name && tag.id) nextTagCache[tag.name] = tag.id;
  }
  state = { ...state, _tagCache: nextTagCache };
  log.ok(
    `tags/list ok — ${tagArray.length} existing tags, cache size ${Object.keys(state._tagCache).length}`
  );

  // --- create any missing area tags (keyed by Notion label) ---
  const finalLabelsToCreate = Array.from(areaLabelsNeeded).filter(
    (l) => !state._tagCache[l]
  );
  for (const label of finalLabelsToCreate) {
    try {
      const res = await morgenRequest(args.apiKey, 'POST', '/tags/create', { name: label });
      const id = (res && res.data && res.data.id) || (res && res.id);
      if (!id) throw new Error(`missing id in response: ${JSON.stringify(res)}`);
      state = {
        ...state,
        _tagCache: { ...state._tagCache, [label]: id },
      };
      log.ok(`tag created: "${label}" → ${id}`);
    } catch (e) {
      log.err(`tag create failed for "${label}": ${e.message}`);
      dumpRemaining(newTasks, 0);
      try { writeStateToDisk(STATE_FILE, state); } catch (_) {}
      process.exit(1);
    }
  }

  // --- create each task ---
  log.step(`creating ${newTasks.length} tasks in Morgen`);
  let created = 0;
  for (let i = 0; i < newTasks.length; i++) {
    const t = newTasks[i];
    const label = areaKeyToNotionLabel(t.area);
    const tagUuid = state._tagCache[label];
    if (!tagUuid) {
      log.err(`no tag uuid for area=${t.area} (label="${label}"); aborting`);
      dumpRemaining(newTasks, i);
      try { writeStateToDisk(STATE_FILE, state); } catch (_) {}
      process.exit(1);
    }
    const payload = buildTaskPayload(t, tagUuid);
    try {
      const res = await morgenRequest(args.apiKey, 'POST', '/tasks/create', payload);
      const id = (res && res.data && res.data.id) || (res && res.id);
      if (!id) throw new Error(`missing id in create response: ${JSON.stringify(res)}`);
      state = upsertMappingEntry(state, t.hash, {
        sourceFile: t.sourceFile,
        lineNo: t.lineNo,
        text: t.text,
        area: t.area,
        priority: t.priority,
        due: t.due,
        scheduled: t.scheduled,
        notionPageId: null,
        morgenTaskId: id,
        morgenEventId: null,
        archived: false,
      });
      created++;
      log.verbose(args.verbose, `created ${id} ← ${truncate(t.text, 60)}`);
      if (created % PROGRESS_EVERY === 0) {
        process.stderr.write(`    progress: ${created}/${newTasks.length}\n`);
      }
    } catch (e) {
      log.err(`tasks/create failed (${i + 1}/${newTasks.length}): ${e.message}`);
      try {
        writeStateToDisk(STATE_FILE, state);
        log.warn(`partial ${STATE_FILENAME} saved — rerun will resume`);
      } catch (_) {}
      dumpRemaining(newTasks, i);
      process.exit(1);
    }
  }

  // --- persist final state ---
  const bytes = writeStateToDisk(STATE_FILE, state);
  log.ok(`\ncreated ${created} tasks`);
  log.ok(
    `${STATE_FILENAME} written (${bytes} bytes, ${Object.keys(state.entries).length} total entries)`
  );
  log.info('NOTE: NOT committed. Review the diff and commit manually when ready:');
  log.info(`        git -C "${TASKS_ROOT}" diff ${STATE_FILENAME}`);
  log.info(`        git -C "${TASKS_ROOT}" add ${STATE_FILENAME}`);
  log.info(`        git -C "${TASKS_ROOT}" commit -m "[bot:backfill] seed ${created} tasks"`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

main().catch((e) => {
  log.err(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});

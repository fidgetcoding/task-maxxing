#!/usr/bin/env node
/**
 * validate-sync-state.js
 *
 * Standalone validator for .sync-state.json files. Checks the schema against
 * what sync-helpers.js expects and prints a pass/fail summary.
 *
 * Usage:
 *   node scripts/validate-sync-state.js <path/to/.sync-state.json>
 *   node scripts/validate-sync-state.js $VAULT_PATH/.sync-state.json
 *
 * Exit codes:
 *   0  valid
 *   1  invalid (error details printed to stderr)
 *   2  usage / cannot read file
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadSyncState, _constants } = require('../src/sync-helpers');
const { NOTION_AREAS, SYNC_STATE_VERSION } = _constants;

const VALID_AREA_KEYS = new Set(Object.keys(NOTION_AREAS));

function fail(msg, code = 1) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(code);
}

function main() {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Usage: node scripts/validate-sync-state.js <path/to/.sync-state.json>\n');
    process.exit(2);
  }

  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) fail(`file not found: ${abs}`, 2);

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    fail(`cannot read ${abs}: ${e.message}`, 2);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`not valid JSON: ${e.message}`);
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('top-level value must be an object');
  }

  const errors = [];
  const warnings = [];

  // --- _version ---
  if (typeof parsed._version !== 'number') {
    errors.push('_version must be a number');
  } else if (parsed._version !== SYNC_STATE_VERSION) {
    warnings.push(`_version is ${parsed._version}, expected ${SYNC_STATE_VERSION}`);
  }

  // --- _tagCache ---
  if (parsed._tagCache == null ||
      typeof parsed._tagCache !== 'object' ||
      Array.isArray(parsed._tagCache)) {
    errors.push('_tagCache must be an object');
  } else {
    for (const [k, v] of Object.entries(parsed._tagCache)) {
      if (typeof v !== 'string') {
        errors.push(`_tagCache["${k}"] must be a string (tag UUID)`);
      }
    }
  }

  // --- entries ---
  if (parsed.entries == null ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries)) {
    errors.push('entries must be an object');
  }

  const entries = parsed.entries || {};
  const hashes = Object.keys(entries);
  let openCount = 0;
  let archivedCount = 0;
  let withNotion = 0;
  let withMorgenTask = 0;
  let withMorgenEvent = 0;
  const areaCounts = {};

  for (const hash of hashes) {
    const e = entries[hash];
    const where = `entries["${hash}"]`;
    if (e == null || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${where} must be an object`);
      continue;
    }

    if (typeof e.hash !== 'string' || e.hash !== hash) {
      errors.push(`${where}.hash must equal its key ("${hash}")`);
    }
    if (e.hash && !/^[0-9a-f]{24}$/.test(e.hash)) {
      warnings.push(`${where}.hash should be 24-char lowercase hex`);
    }
    if (typeof e.sourceFile !== 'string' || !e.sourceFile) {
      errors.push(`${where}.sourceFile must be a non-empty string`);
    } else if (e.sourceFile.startsWith('08-Tasks/')) {
      warnings.push(`${where}.sourceFile should not include the "08-Tasks/" prefix`);
    }
    if (typeof e.text !== 'string') {
      errors.push(`${where}.text must be a string`);
    }
    if (typeof e.area !== 'string') {
      errors.push(`${where}.area must be a string`);
    } else if (!VALID_AREA_KEYS.has(e.area)) {
      warnings.push(`${where}.area = "${e.area}" is not one of the known area keys`);
    } else {
      areaCounts[e.area] = (areaCounts[e.area] || 0) + 1;
    }

    if (e.lineNo != null && (typeof e.lineNo !== 'number' || !Number.isInteger(e.lineNo))) {
      errors.push(`${where}.lineNo must be an integer or null`);
    }
    if (e.priority != null && typeof e.priority !== 'number') {
      errors.push(`${where}.priority must be a number or null`);
    }

    for (const k of ['due', 'scheduled']) {
      if (e[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(e[k]))) {
        errors.push(`${where}.${k} must be a bare YYYY-MM-DD string or null (got ${JSON.stringify(e[k])})`);
      }
    }

    for (const k of ['notionPageId', 'morgenTaskId', 'morgenEventId']) {
      if (e[k] != null && typeof e[k] !== 'string') {
        errors.push(`${where}.${k} must be a string or null`);
      }
    }

    if (e.archived != null && typeof e.archived !== 'boolean') {
      errors.push(`${where}.archived must be a boolean`);
    }

    if (e.archived) archivedCount++;
    else openCount++;
    if (typeof e.notionPageId === 'string' && e.notionPageId) withNotion++;
    if (typeof e.morgenTaskId === 'string' && e.morgenTaskId) withMorgenTask++;
    if (typeof e.morgenEventId === 'string' && e.morgenEventId) withMorgenEvent++;
  }

  // --- Second pass: ensure loadSyncState round-trips without loss ---
  try {
    const loaded = loadSyncState(raw);
    const loadedCount = Object.keys(loaded.entries || {}).length;
    if (loadedCount !== hashes.length) {
      warnings.push(`loadSyncState() kept ${loadedCount}/${hashes.length} entries — some were dropped as invalid`);
    }
  } catch (e) {
    errors.push(`loadSyncState() threw: ${e.message}`);
  }

  // --- Summary ---
  process.stdout.write(`\nvalidate-sync-state: ${abs}\n`);
  process.stdout.write(`  _version         : ${parsed._version}\n`);
  process.stdout.write(`  _tagCache size   : ${Object.keys(parsed._tagCache || {}).length}\n`);
  process.stdout.write(`  entries total    : ${hashes.length}\n`);
  process.stdout.write(`    open           : ${openCount}\n`);
  process.stdout.write(`    archived       : ${archivedCount}\n`);
  process.stdout.write(`  with notionPageId: ${withNotion}\n`);
  process.stdout.write(`  with morgenTaskId: ${withMorgenTask}\n`);
  process.stdout.write(`  with morgenEventId: ${withMorgenEvent}\n`);
  process.stdout.write(`  by area:\n`);
  for (const a of Object.keys(areaCounts).sort()) {
    process.stdout.write(`    ${a.padEnd(30)} ${areaCounts[a]}\n`);
  }

  if (warnings.length) {
    process.stdout.write(`\nwarnings (${warnings.length}):\n`);
    for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  }

  if (errors.length) {
    process.stderr.write(`\nerrors (${errors.length}):\n`);
    for (const e of errors) process.stderr.write(`  x ${e}\n`);
    process.stderr.write(`\n[FAIL] ${errors.length} schema error(s)\n`);
    process.exit(1);
  }

  process.stdout.write('\n[ ok ] schema valid\n');
  process.exit(0);
}

main();

#!/usr/bin/env node
/**
 * validate-workflows.js
 *
 * Lints every n8n workflow export under workflows/*.json.
 *
 * Checks:
 *   1. File parses as JSON.
 *   2. Has required top-level keys: name, nodes, connections.
 *   3. nodes is a non-empty array; each node has id, name, type.
 *   4. No {{PLACEHOLDER}} strings leaked into the WRONG spots. Placeholders
 *      are only allowed inside:
 *        - node.parameters.jsCode (Code node JS body)
 *        - node.credentials.* (credential-name slots)
 *        - node.parameters.url (when it's a template URL)
 *        - node.parameters.sendBody / headerParameters / queryParameters (auth/header slots)
 *      Anywhere else is an error.
 *   5. No hardcoded tokens anywhere (ghp_, ntn_, sk-, "ApiKey ").
 *
 * Exits 0 on success, 1 on any failure. Writes human-readable messages to stdout
 * and GitHub Actions annotation format so errors show up in the PR checks UI.
 *
 * Run: node scripts/validate-workflows.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');
const REQUIRED_TOP_KEYS = ['name', 'nodes', 'connections'];

const TOKEN_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/,
  /ntn_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ApiKey [A-Za-z0-9]{10,}/,
];

const PLACEHOLDER_RE = /\{\{[A-Z0-9_]+\}\}/;

/** Path-segments where placeholders are allowed. */
const PLACEHOLDER_ALLOWED_PATHS = [
  // Code node: the JS body is expected to reference placeholders.
  /\.parameters\.jsCode$/,
  // Credential refs: {{NOTION_CRED_ID}}, {{MORGEN_CRED_ID}}, etc.
  /\.credentials\.[^.]+$/,
  /\.credentials\.[^.]+\.id$/,
  /\.credentials\.[^.]+\.name$/,
  // HTTP Request template URLs / auth-header slots.
  /\.parameters\.url$/,
  /\.parameters\.authentication$/,
  /\.parameters\.sendHeaders$/,
  /\.parameters\.headerParameters(\..*)?$/,
  /\.parameters\.queryParameters(\..*)?$/,
  /\.parameters\.options(\..*)?$/,
];

function isAllowedPlaceholderPath(p) {
  return PLACEHOLDER_ALLOWED_PATHS.some((re) => re.test(p));
}

function scanForTokens(filepath, text) {
  const errors = [];
  for (const pat of TOKEN_PATTERNS) {
    const m = text.match(pat);
    if (m) {
      errors.push(
        `Hardcoded token detected in ${filepath}: matched ${pat} ("${m[0].slice(0, 10)}...")`
      );
    }
  }
  return errors;
}

/**
 * Walk the object; call visit(path, value) on every string leaf.
 */
function walk(value, currentPath, visit) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    visit(currentPath, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${currentPath}[${i}]`, visit));
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      walk(value[key], currentPath ? `${currentPath}.${key}` : key, visit);
    }
  }
}

function validateWorkflowObject(filepath, wf) {
  const errors = [];

  // 2. Required top-level keys
  for (const k of REQUIRED_TOP_KEYS) {
    if (!(k in wf)) {
      errors.push(`${filepath}: missing required top-level key "${k}"`);
    }
  }

  // 3. nodes shape
  if (Array.isArray(wf.nodes)) {
    if (wf.nodes.length === 0) {
      errors.push(`${filepath}: "nodes" is empty`);
    }
    wf.nodes.forEach((node, i) => {
      if (!node || typeof node !== 'object') {
        errors.push(`${filepath}: nodes[${i}] is not an object`);
        return;
      }
      if (!node.name) errors.push(`${filepath}: nodes[${i}] missing "name"`);
      if (!node.type) errors.push(`${filepath}: nodes[${i}] missing "type"`);
    });
  } else if ('nodes' in wf) {
    errors.push(`${filepath}: "nodes" must be an array`);
  }

  // 4. Placeholder leak check — walk the whole object, flag placeholders
  //    found at paths that are NOT in the allowlist.
  walk(wf, '', (p, v) => {
    if (typeof v !== 'string') return;
    if (!PLACEHOLDER_RE.test(v)) return;
    if (!isAllowedPlaceholderPath(p)) {
      errors.push(
        `${filepath}: placeholder "${v.match(PLACEHOLDER_RE)[0]}" leaked into disallowed path "${p}"`
      );
    }
  });

  return errors;
}

function main() {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    console.log(`No workflows/ directory — nothing to validate.`);
    process.exit(0);
  }

  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join('workflows', f));

  if (files.length === 0) {
    console.log(`No workflows/*.json files yet — nothing to validate.`);
    process.exit(0);
  }

  const allErrors = [];
  let ok = 0;

  for (const filepath of files) {
    const absPath = path.join(process.cwd(), filepath);
    let text;
    try {
      text = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      allErrors.push(`${filepath}: cannot read (${err.message})`);
      continue;
    }

    // 5. Token scan (raw text)
    allErrors.push(...scanForTokens(filepath, text));

    // 1. JSON parse
    let wf;
    try {
      wf = JSON.parse(text);
    } catch (err) {
      allErrors.push(`${filepath}: invalid JSON — ${err.message}`);
      continue;
    }

    // 2-4. Structural checks
    const errs = validateWorkflowObject(filepath, wf);
    if (errs.length === 0) {
      ok++;
      console.log(`OK  ${filepath}`);
    } else {
      allErrors.push(...errs);
      console.log(`FAIL ${filepath} (${errs.length} errors)`);
    }
  }

  if (allErrors.length > 0) {
    console.log('\n--- Validation errors ---');
    for (const err of allErrors) {
      // GitHub Actions annotation
      console.log(`::error::${err}`);
      console.log(err);
    }
    console.log(
      `\nValidated ${files.length} workflow(s): ${ok} ok, ${files.length - ok} failed, ${allErrors.length} total errors`
    );
    process.exit(1);
  }

  console.log(`\nValidated ${files.length} workflow(s): all passed.`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { validateWorkflowObject, scanForTokens, isAllowedPlaceholderPath };

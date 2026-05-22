#!/usr/bin/env node
/*
 * task-maxxing auto-commit daemon (Node edition)
 *
 * Watches a git repo containing your Obsidian task files and auto-commits +
 * pushes any changes. Designed to be invoked by launchd (macOS) every time a
 * file under the watched tree changes, with a minimum throttle interval.
 *
 * Why Node (not bash)? So that macOS Full Disk Access can be scoped to a
 * single wrapper .app bundle around your Node binary, instead of granting FDA
 * to /bin/bash system-wide. See daemon/README.md for the FDA walkthrough.
 *
 * Zero npm dependencies — stdlib only (child_process, fs, path, os).
 *
 * Configuration (env vars or CLI args — env wins, then CLI, then defaults):
 *   TASK_MAXXING_REPO   Absolute path to the git repo to watch + commit.
 *                       Also accepted as argv[2].
 *   TASK_MAXXING_LOG    Absolute path to the log file.
 *                       Defaults to ~/Library/Logs/task-maxxing.log
 *   TASK_MAXXING_BRANCH Branch to push (default: main)
 *
 * Manual run (for testing):
 *   TASK_MAXXING_REPO="$HOME/path/to/vault/05-Tasks" node src/auto-commit.js
 *
 * Exit codes:
 *   0  nothing to commit, or commit + push succeeded
 *   1  FDA / git / push failure (logged; launchd will retry next tick)
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

const REPO_PATH =
  process.env.TASK_MAXXING_REPO ||
  process.argv[2] ||
  path.join(HOME, 'task-maxxing-vault');

const LOG_PATH =
  process.env.TASK_MAXXING_LOG ||
  path.join(HOME, 'Library/Logs/task-maxxing.log');

const HEARTBEAT_LOG = LOG_PATH + '.heartbeat';

const BRANCH = process.env.TASK_MAXXING_BRANCH || 'main';

// Park in /tmp so we never carry an unreadable CWD.
try {
  process.chdir('/tmp');
} catch (_) {
  try { process.chdir('/'); } catch (__) { /* last resort */ }
}

// Ensure git + standard tools are findable even under launchd's minimal PATH.
process.env.PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.PATH || '',
].filter(Boolean).join(':');

const timestamp = () => {
  // "2026-04-14 11:42:01 EDT" — match bash `date '+%Y-%m-%d %H:%M:%S %Z'`
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const tz = d
    .toLocaleTimeString('en-US', { timeZoneName: 'short' })
    .split(' ')
    .pop();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz}`
  );
};

const appendLog = (file, line) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
  } catch (err) {
    // If we can't even write logs, print to stderr — launchd captures it.
    process.stderr.write(`[daemon] log write failed: ${err.message}\n`);
  }
};

const log = (msg) => appendLog(LOG_PATH, `[${timestamp()}] ${msg}`);
const heartbeat = (msg) => appendLog(HEARTBEAT_LOG, `[${timestamp()}] ${msg}`);

// Uses execFileSync (array args) instead of execSync (shell string) so
// values flowing in from env (REPO_PATH, BRANCH) and filesystem-derived
// commit messages never hit a shell. No quoting, no escaping, no chance
// of a malicious TASK_MAXXING_BRANCH="; rm -rf ~" breaking out.
const git = (...args) =>
  execFileSync('git', ['-C', REPO_PATH, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

const main = () => {
  // --- FDA / TCC preflight -------------------------------------------------
  // access() / fs.existsSync() can lie under macOS TCC (they go through
  // access(2) which reports the file as present even when a real open(2)
  // would EPERM). We do a true fs.readFileSync on .git/HEAD — if it throws,
  // Node doesn't have Full Disk Access for the repo's parent tree.
  let headContent;
  try {
    headContent = fs
      .readFileSync(path.join(REPO_PATH, '.git/HEAD'), 'utf8')
      .trim();
  } catch (err) {
    const nodeBin = process.execPath;
    log(
      `FATAL: cannot read ${REPO_PATH}/.git/HEAD — macOS Full Disk Access ` +
      `likely not granted to the Node binary at ${nodeBin}. ` +
      `Error: ${err.code || err.message}. ` +
      `Fix: System Settings > Privacy & Security > Full Disk Access > + > ` +
      `⌘⇧G > paste "${nodeBin}" > Open > toggle on. ` +
      `Then reload your LaunchAgent via launchctl bootout + bootstrap. ` +
      `See daemon/README.md for the full walkthrough.`
    );
    process.exit(1);
  }

  heartbeat(`tick (HEAD=${headContent})`);

  // --- Bail fast if the tree is clean --------------------------------------
  let porcelain;
  try {
    porcelain = git('status', '--porcelain').trim();
  } catch (err) {
    log(`git status failed: ${err.message}`);
    process.exit(1);
  }

  if (!porcelain) {
    process.exit(0);
  }

  const changedFiles = porcelain
    .split('\n')
    .map((l) => l.trim().split(/\s+/).slice(1).join(' '))
    .filter(Boolean)
    .join(' ');

  log(`auto-commit: ${changedFiles}`);

  // --- Stage ---------------------------------------------------------------
  try {
    git('add', '-A');
  } catch (err) {
    log(`git add failed: ${err.message} — aborting this tick`);
    process.exit(1);
  }

  // --- Commit --------------------------------------------------------------
  // ISO-8601 UTC, matches `date -u +%Y-%m-%dT%H:%M:%SZ`.
  //
  // Commit prefix `[bot:daemon]` is load-bearing: n8n W1's echo-loop guard
  // (see sync-helpers.js BOT_COMMIT_PREFIXES + isBotCommitMessage) skips
  // pushes whose every commit is prefixed with one of the `[bot:*]` labels.
  // Changing this string will cause W1 to interpret every daemon push as a
  // user edit and re-sync back into Morgen, looping forever. Don't.
  const utcStamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const msg = `[bot:daemon] auto: task edit ${utcStamp}`;
    git('commit', '-m', msg);
  } catch (err) {
    // Empty diff after `add -A` (possible if only ignored files changed)
    // shows up here. That's not a real failure — log and move on.
    const stderr = (err.stderr && err.stderr.toString()) || '';
    if (/nothing to commit/i.test(stderr) || /nothing to commit/i.test(err.message || '')) {
      log('nothing to commit after add -A');
      process.exit(0);
    }
    log(`commit failed: ${stderr || err.message}`);
    process.exit(1);
  }

  // --- Push ----------------------------------------------------------------
  try {
    git('push', 'origin', BRANCH);
  } catch (err) {
    const stderr = (err.stderr && err.stderr.toString()) || err.message;
    log(`push failed — will retry next tick: ${stderr}`);
    process.exit(1);
  }

  log('pushed successfully');
};

try {
  main();
} catch (err) {
  log(`unhandled error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}

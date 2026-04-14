# Troubleshooting

Things that have actually broken during real runs, in rough order of how often they
happen. Every entry has a **symptom**, a **diagnostic** command, and a **fix**.

If your problem isn't here, open an issue with your `.sync-state.json` (redacted) and
the last 50 lines of the relevant n8n execution log.

---

## Index

1. [Daemon: FATAL EPERM — Full Disk Access not granted](#1-daemon-fatal-eperm)
2. [Morgen: 429 Too Many Requests](#2-morgen-429-too-many-requests)
3. [Notion: 403 "could not find database"](#3-notion-403-could-not-find-database)
4. [W1 times out (60 seconds)](#4-w1-times-out-60-seconds)
5. [`.sync-state.json` is corrupted](#5-sync-statejson-is-corrupted)
6. [Tasks don't appear in Morgen sidebar](#6-tasks-dont-appear-in-morgen-sidebar)
7. [Echo-loop: a workflow keeps re-triggering itself](#7-echo-loop)
8. [n8n credential binding fails on import](#8-n8n-credential-binding-fails)
9. [Daemon runs but nothing pushes](#9-daemon-runs-but-nothing-pushes)
10. [Tasks appear in Notion but not Morgen (or vice versa)](#10-partial-create)
11. [Flip ratio guard tripped](#11-flip-ratio-guard-tripped)
12. [Tasks show up twice in Notion](#12-duplicate-notion-rows)

---

## 1. Daemon: FATAL EPERM

**Symptom**

```
[daemon] FATAL: EPERM: operation not permitted, open '/Users/you/.../08-Tasks/TASKS-URGENT.md'
```

or

```
launchctl list | grep task-maxxing
-	1	io.example.task-maxxing-daemon
```

(the `-` means the daemon has crashed and not restarted cleanly.)

**Cause**

macOS sandbox policy denies any process that hasn't been granted Full Disk Access
from reading files in `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Library`, or
iCloud-backed folders. A bare Node script **cannot** be granted FDA — macOS only
accepts `.app` bundles in the FDA list.

**Diagnostic**

```bash
tail -30 ~/Library/Logs/task-maxxing-daemon.log
ls -la ~/Applications/task-maxxing-daemon.app
```

If the `.app` bundle doesn't exist, the installer didn't run. Re-run
`./src/install.sh`.

If the `.app` bundle exists but the log shows EPERM, FDA is not granted.

**Fix**

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Click **+**, navigate to `~/Applications/task-maxxing-daemon.app`, select it.
3. Make sure the toggle is **ON**.
4. Unload and reload the daemon:

   ```bash
   launchctl unload ~/Library/LaunchAgents/io.{{YOUR_ORG_OR_NAME}}.task-maxxing-daemon.plist
   launchctl load   ~/Library/LaunchAgents/io.{{YOUR_ORG_OR_NAME}}.task-maxxing-daemon.plist
   ```

5. Verify:

   ```bash
   launchctl list | grep task-maxxing
   ```

   The first column (PID) should now be a positive integer, not `-`.

**Gotcha:** if you grant FDA to `node` directly (e.g. by adding `/opt/homebrew/bin/node`),
macOS silently revokes it on the next Node upgrade. Always use the `.app` bundle.

---

## 2. Morgen: 429 Too Many Requests

**Symptom**

n8n W1 execution shows a node failure with:

```
Morgen API: 429 Too Many Requests
```

or the Morgen backfill script exits with:

```
[ERROR] Rate limit exceeded: 100 points / 15 min
```

**Cause**

Morgen's rate limit is 100 points per 15-minute rolling window. Creates, updates,
and deletes are 1 point each. Hitting 100 in one W1 run means you had >100 Morgen
ops queued.

**Diagnostic**

Look at the n8n execution log for W1. Count the number of Morgen ops. If you're near
100, you're hitting the budget. If you're near 200, you're doing a full backfill.

**Fix**

If you're in the middle of a backfill:

1. Wait 15 minutes for the Morgen rate window to reset.
2. Re-run `scripts/morgen-backfill.js` with a `--resume` flag. The script reads
   `.sync-state.json` and only processes tasks without a `morgenTaskId`:

   ```bash
   node scripts/morgen-backfill.js --resume
   ```

3. Repeat until all tasks have an ID.

If you're in steady-state (not a backfill) and still hitting 429, your vault is
pushing too many edits at once. Options:

- Reduce the W1 Morgen op budget below the default 100 (edit the workflow's
  `maxMorgenOps` variable — it lives in the top-level `Set` node).
- Increase the debounce on the daemon from 1s to 5s so you batch more edits per
  push.

---

## 3. Notion: 403 "could not find database"

**Symptom**

```
Notion API: 403 Forbidden
Body: {"object":"error","status":403,"code":"object_not_found",
       "message":"Could not find database with ID: {{NOTION_DB_ID}}.
                  Make sure the relevant pages and databases are shared with your integration."}
```

**Cause**

You created the database before connecting the integration to it, OR you connected
the integration to a parent page but not to this database specifically.

**Diagnostic**

1. Open the Tasks database in Notion.
2. Click the `•••` menu in the top-right.
3. Click **Connections**.
4. Is your `task-maxxing` integration listed under **Connected to**?

If no, fix. If yes but you still see 403, the database ID in `.env` is wrong — see
next.

**Fix**

**Scenario A: integration not connected**

1. In the Notion database, click `•••` → **Connections** → **Connect to** → pick
   `task-maxxing`.
2. Confirm.
3. Re-run the failing W1 execution (or just trigger a commit).

**Scenario B: wrong database ID in .env**

The URL of the Notion database page is:

```
https://www.notion.so/{{WORKSPACE}}/{{PAGE_TITLE}}-{{32_HEX_CHARS}}?v={{VIEW_ID}}
```

Make sure `NOTION_DB_ID` in `.env` matches the 32 hex chars in the URL, **not** the
view ID.

```bash
grep NOTION_DB_ID .env
```

Normalize: strip dashes if any. task-maxxing accepts both forms but the Notion API is
picky.

---

## 4. W1 times out (60 seconds)

**Symptom**

n8n W1 execution shows:

```
Workflow execution timed out after 60 seconds
```

and only some of your tasks have been synced.

**Cause**

Notion's 3 req/s rate limit + a large diff = exceeds 60s workflow timeout.

**Diagnostic**

Look at the W1 execution log. Count the operations that completed before timeout. If
it was >80, you're at the edge of the budget. If it was <20, there's a slow node
somewhere (usually a Code node doing something naive).

**Fix**

**Option 1: reduce the Notion throttle** (if your account has no issues with Notion's
rate limit, you can go from 3 req/s to 5 req/s):

1. Open W1 in n8n.
2. Find the top-level `Set` node at the start.
3. Change `notionRateLimit` from `3` to `5`.
4. Save.

**Option 2: run a backfill manually** and let W1 handle only the delta:

```bash
node scripts/morgen-backfill.js --notion-only --resume
```

**Option 3: increase workflow timeout**

In n8n's workflow settings, change the timeout from 60s to 120s. This is a
band-aid — the real fix is Option 1 or 2.

---

## 5. `.sync-state.json` is corrupted

**Symptom**

Daemon logs show:

```
[daemon] parse error: Unexpected token { in JSON at position 4019
```

or W1 fails with:

```
Cannot read property 'tasks' of undefined
```

**Cause**

A bad git merge, an interrupted write, or editing `.sync-state.json` by hand. The
file is meant to be generated, never touched.

**Diagnostic**

```bash
cat ~/Desktop/{{YOUR_VAULT_NAME}}-tasks/sync-state.json | jq . > /dev/null
```

If `jq` errors out, the file is invalid.

**Fix**

task-maxxing is idempotent on `.sync-state.json`. The recovery is always:

1. **Delete** the file from the mirror repo.

   ```bash
   cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
   rm sync-state.json
   git add -A
   git commit -m "[bot:recovery] reset sync state"
   git push
   ```

2. **Re-run the backfill.** With the existing IDs in Notion and Morgen already stored
   in Notion's `Hash` column and Morgen's `integrationId`, the backfill script will
   *re-associate* existing rows rather than creating new ones:

   ```bash
   cd ~/Desktop/task-maxxing
   node scripts/morgen-backfill.js --rehydrate
   ```

3. The `--rehydrate` flag tells the script to:
   - Fetch all Notion rows with the task-maxxing `Hash` property set.
   - Fetch all Morgen tasks with our `integrationId`.
   - Match them to your markdown tasks by hash.
   - Rebuild `.sync-state.json` with the correct IDs.

4. Push the restored state to the mirror.

If `--rehydrate` can't match a row (because you manually edited the task text after
the hash was computed), you'll get duplicates. The backfill will print a list of
"unmatched" tasks so you can delete the stale Notion rows by hand.

---

## 6. Tasks don't appear in Morgen sidebar

**Symptom**

You ran the backfill, `.sync-state.json` has `morgenTaskId` values, the Morgen API
reports the tasks exist — but they don't appear in the Morgen sidebar UI.

**Cause**

Two possible reasons:

1. **Tag cache mismatch.** Morgen's tag IDs are UUIDs, and if the workflow's
   `_tagCache` created a tag with the same name as one you already had, Morgen's UI
   sometimes hides tasks with "orphan" tag IDs until you refresh.
2. **Integration filter is hiding them.** The Morgen UI has a filter dropdown that
   defaults to "All tasks" but can be narrowed. If you set it to "From my phone"
   (or similar), API-created tasks won't show.

**Diagnostic**

Force a fresh tag lookup:

```bash
curl -sS \
  -H "Authorization: ApiKey ${MORGEN_API_KEY}" \
  https://api.morgen.so/v3/tags/list
```

Compare the tag IDs returned to what's in `.sync-state.json`:

```bash
jq '.tasks[] | .morgenTaskId + " " + (.tags | join(","))' sync-state.json | head -20
```

**Fix**

**Scenario A: tag cache mismatch**

1. Restart the Morgen app (cmd+Q, reopen).
2. If that doesn't work, delete the orphan tag via API:

   ```bash
   curl -X DELETE \
     -H "Authorization: ApiKey ${MORGEN_API_KEY}" \
     https://api.morgen.so/v3/tags/{{ORPHAN_TAG_ID}}
   ```

3. Re-run the backfill. It'll recreate the tag with a fresh ID.

**Scenario B: UI filter**

In the Morgen sidebar, click the filter dropdown. Pick **All tasks** or
**My integrations**. The tasks should now be visible.

**Scenario C: integrationId filter mismatch**

If you changed `MORGEN_INTEGRATION_ID` in `.env` after running the backfill, the
old tasks are tagged with the old ID and W2 won't round-trip them. Fix: re-run
backfill with `--force-integration-id` to update all tasks.

---

## 7. Echo-loop

**Symptom**

W1 is triggering every 60 seconds on its own, even though you haven't edited
anything. n8n's executions page shows a new W1 run every cycle. The daemon log shows
commits with `[bot:w2]` or `[bot:w3]` being committed, followed immediately by a new
`[bot:daemon]` commit.

**Cause**

The bot commit prefix guard is supposed to prevent this. It looks at
`commits[].message` on the incoming push webhook and skips the write phase if **every**
commit is `[bot:*]`.

The loop usually comes from one of:

1. A commit message that doesn't start with `[bot:*]` (maybe a manual
   `git commit --amend` that dropped the prefix).
2. A squash-merge in the mirror repo that stripped the bot prefix.
3. A clock skew where W2 thinks a task changed at T+60s but `.sync-state.json` still
   says T.

**Diagnostic**

```bash
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
git log --oneline -20
```

Look for commits without `[bot:daemon]`, `[bot:w1]`, `[bot:w2]`, or `[bot:w3]`
prefixes. Any unprefixed commit will cause W1 to assume it's a user edit.

**Fix**

1. **Stop the loop.** Deactivate W1 temporarily in the n8n UI.
2. **Find the offending commit.** Look for the first commit that started the loop.
3. **If it's a manual amend**, re-add the bot prefix:

   ```bash
   git commit --allow-empty -m "[bot:recovery] reset loop"
   git push
   ```

4. **If it's a clock-skew bug,** check W2's `lastSyncedAt` comparison logic. W2
   should use `>=` not `>` when comparing timestamps. This has been fixed in
   main — if your workflow JSON is older, re-import from the repo.
5. **Re-activate W1.**

---

## 8. n8n credential binding fails

**Symptom**

After `./scripts/install-workflows.sh`, you open a workflow in n8n and the HTTP
Request nodes show a red dot and "Credential not set".

**Cause**

The n8n API lets you import a workflow, but credential references are stored by
**credential name**, not ID. If the credentials you created in the UI don't have
exactly the same names as the slots in the workflow JSON, the binding silently fails.

**Diagnostic**

Open the failing node, click **Credential for Notion API**, and look at the dropdown.
The expected name is one of:

- `Notion (task-maxxing)`
- `Morgen (task-maxxing)`
- `GitHub (task-maxxing)`

If your credentials have different names (e.g. `Notion Tasks`), that's the mismatch.

**Fix**

**Option A:** Rename your existing credentials in n8n to exactly match the expected
name. Credentials → click the credential → edit the name → save. Then reopen the
workflow — the nodes should auto-bind.

**Option B:** Manually re-bind each HTTP Request node:

1. Open the workflow.
2. Click a red-dotted node.
3. In the **Authentication** dropdown, pick **Predefined Credential Type**.
4. Pick the correct credential from the list.
5. Save.
6. Repeat for every red-dotted node (usually 3–5 per workflow).

---

## 9. Daemon runs but nothing pushes

**Symptom**

`launchctl list | grep task-maxxing` shows a positive PID. The daemon log shows
"watching" and "parsed" but no "committed" or "pushed" lines.

**Cause**

Several options:

1. The git remote is wrong (can't find origin).
2. The `GITHUB_TOKEN` doesn't have write access to the mirror repo.
3. There are no actual changes to commit (daemon is working as intended and silently
   doing nothing).

**Diagnostic**

```bash
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
git remote -v
git status
```

Then trigger a manual sync test:

```bash
touch ~/{{VAULT_PATH}}/08-Tasks/TASKS-URGENT.md
tail -5 ~/Library/Logs/task-maxxing-daemon.log
```

You should see "debounced" and then "no changes" or "committed".

**Fix**

**Scenario A: wrong remote**

```bash
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
git remote set-url origin https://github.com/{{YOUR_GH_USERNAME}}/{{YOUR_VAULT_NAME}}-tasks.git
```

**Scenario B: PAT can't push**

```bash
# Try a manual push with the PAT
GITHUB_TOKEN=$(grep GITHUB_TOKEN .env | cut -d= -f2)
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
git -c http.extraHeader="Authorization: Bearer ${GITHUB_TOKEN}" push origin main
```

If that fails with 403, your PAT doesn't have Contents: Read and Write. Go back to
[SETUP.md section 8](SETUP.md#8-create-the-vault-mirror-github-repo) and recreate the
token.

**Scenario C: daemon is fine, nothing actually changed**

This is working as intended. The daemon only commits when parsed state differs from
the last committed state. If you haven't actually edited a task, there's nothing to
push.

---

## 10. Partial create (Notion yes, Morgen no, or vice versa)

**Symptom**

You added a new task. It shows up in Notion but not Morgen, or the reverse.

**Cause**

W1 ran the Notion create successfully but failed the Morgen create (or vice versa),
and the workflow exited before updating `.sync-state.json`. The next W1 run will see
the task as "still missing a morgenTaskId" and retry just the Morgen side.

**Diagnostic**

```bash
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
cat sync-state.json | jq '.tasks[] | select(.morgenTaskId == null or .notionPageId == null)'
```

Any task showing up here is "half-synced". Check the most recent W1 execution log in
n8n for the failure.

**Fix**

Trigger a fresh W1 run. The simplest way is to add an empty line to any `TASKS-*.md`
file and save (the daemon will push, W1 will run).

If W1 keeps failing on the same side repeatedly, the underlying cause is one of the
other sections in this doc (rate limit, 403, etc.). Fix that first.

---

## 11. Flip ratio guard tripped

**Symptom**

W1 execution shows a warning node:

```
[W1] flip ratio 0.34 exceeds limit 0.25 — refusing to sync.
  Tasks: 47 total, 16 would flip (12 archives, 3 creates, 1 update)
  Set FORCE_SYNC=true in workflow env vars to override.
```

and no Notion / Morgen writes happened.

**Cause**

More than 25% of your tasks would change state in a single W1 run. This is the safety
rail catching "user accidentally deleted TASKS-URGENT.md".

**Diagnostic**

```bash
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
git log --oneline -5
git diff HEAD~1 HEAD -- sync-state.json | head -50
```

If you see a large number of lines deleted from `sync-state.json`, that's the flip.

**Fix**

**If the flip was legitimate** (e.g., you finished a big project and closed 20 tasks):

1. Open W1 in n8n.
2. Find the top `Set` node.
3. Temporarily set `forceSync = true`.
4. Save.
5. Trigger the workflow (re-run last execution).
6. Set `forceSync = false` again.
7. Save.

**If the flip was an accident** (e.g., you deleted a file by mistake):

1. Revert the mirror repo to the last good commit:

   ```bash
   cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
   git revert HEAD
   git push
   ```

2. Fix the source markdown in your vault.
3. Wait for the daemon to push the correction.

---

## 12. Duplicate Notion rows

**Symptom**

You see the same task twice (or more) in Notion.

**Cause**

Three possibilities, in order of likelihood:

1. **You edited a task in Obsidian before its initial W1 sync finished.** The task
   got hash `abc` when W1 started, but `def` by the time it finished. W1 created the
   row with the old hash, then the next run created a new row with the new hash
   (because it couldn't find the old hash in state).
2. **`.sync-state.json` got reset but Notion wasn't cleaned.** The backfill `--rehydrate`
   mode couldn't match the old rows and created new ones.
3. **Two different markdown lines with the same text but different sourceFile.**
   These are intentionally distinct tasks (per the hashing strategy) but look
   identical in Notion because the `Source` column is collapsed.

**Diagnostic**

In Notion, add a filter: group by `Hash`. Any hash with count > 1 is a true duplicate.

**Fix**

**For true duplicates (same hash, multiple rows):**

1. Pick the "real" row — whichever one has the most recent `Synced At`.
2. Delete the others from Notion directly (don't use archive — use delete).
3. Do NOT update `.sync-state.json`. The next W1 run will regenerate it if needed.

**For near-duplicates (different hashes, same text):**

These are actually two different tasks that happened to have the same text. Edit one
of them in the source markdown to differentiate.

**For the "interrupted sync" case:**

1. Stop the daemon temporarily:

   ```bash
   launchctl unload ~/Library/LaunchAgents/io.{{YOUR_ORG_OR_NAME}}.task-maxxing-daemon.plist
   ```

2. Delete the duplicate Notion rows by hand.
3. Delete `sync-state.json` from the mirror.
4. Re-run `node scripts/morgen-backfill.js --rehydrate`.
5. Reload the daemon:

   ```bash
   launchctl load ~/Library/LaunchAgents/io.{{YOUR_ORG_OR_NAME}}.task-maxxing-daemon.plist
   ```

---

## Still stuck?

Open an issue at [github.com/lorecraft-io/task-maxxing/issues](https://github.com/lorecraft-io/task-maxxing/issues)
with:

1. **Which step in SETUP.md you were on** (or "in steady state").
2. **The error message**, copy-pasted verbatim.
3. **The last 50 lines of the relevant log:**
   - Daemon: `~/Library/Logs/task-maxxing-daemon.log`
   - n8n: the workflow execution log (redact tokens)
4. **A redacted `.sync-state.json` snippet** for the affected task.

Most bugs are fixable in one round-trip if you include all four.

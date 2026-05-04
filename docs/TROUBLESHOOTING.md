# Troubleshooting

Symptom → diagnose → fix runbook for the **two-way Obsidian ↔ Morgen** sync. Each
entry is one observable failure with the shortest path back to a working pipeline.

If your problem isn't here, open an issue with a redacted `.sync-state.json`
snippet and the last n8n execution log for whichever workflow stalled.

> [!NOTE]
> **Architecture recap.** As of 2026-05-04 this kit is **two-way**:
> - **W1** (Obsidian → Morgen) — polls GitHub every 20 min, re-publishes Morgen tasks.
> - **W2** (Morgen → Obsidian) — polls Morgen every 20 min, commits markdown changes.
> - **W0** (orchestrator) — every 20 min, runs `W2 → W1` in series.
> - **Watchdog** — hourly, checks for stale `[bot:W1]` commits, opens a GH issue + optional Telegram on alert.
>
> If you're upgrading from a 3-way (Notion) install, jump to the
> [Legacy: Notion era](#legacy-notion-era) section first, then come back here.

---

## How to use this doc

Find your symptom in the index, top to bottom. Severity tiers:

- **STOP-EVERYTHING** — sync is silently dead, nothing is moving.
- **WORKING-BUT-WRONG** — sync runs but the data on the other side is wrong.
- **DAILY-DRIVER** — small annoyances that don't break the loop.
- **LEGACY** — leftover symptoms from the 3-way Notion era.

---

## Index

### STOP-EVERYTHING

1. [Sync stopped silently — no `[bot:W1]` commits for hours](#1-sync-stopped-silently)
2. [W1 401-failing on the GitHub API](#2-w1-401-failing-on-github)
3. [W2 401-failing on the Morgen API](#3-w2-401-failing-on-morgen)
4. [n8n cloud instance unreachable](#4-n8n-cloud-instance-unreachable)

### WORKING-BUT-WRONG

5. [Duplicate tasks in Morgen](#5-duplicate-tasks-in-morgen)
6. [Task edited in Obsidian, not in Morgen](#6-task-edited-in-obsidian-not-in-morgen)
7. [Task edited in Morgen, not in Obsidian](#7-task-edited-in-morgen-not-in-obsidian)
8. [Task deleted in Obsidian, ghost in Morgen](#8-task-deleted-in-obsidian-ghost-in-morgen)
9. [`m-XXXXXXXX` IDs being regenerated on every sync](#9-m-ids-being-regenerated)

### DAILY-DRIVER

10. [Task lands in `TASKS-GENERAL.md` instead of its project area file](#10-task-lands-in-tasks-general)
11. [Watchdog crying wolf](#11-watchdog-crying-wolf)
12. [Telegram alerts not arriving](#12-telegram-alerts-not-arriving)

### LEGACY

13. [Upgrading from a 3-way (Notion) install](#13-upgrading-from-a-3-way-notion-install)

---

## STOP-EVERYTHING

### 1. Sync stopped silently

> No `[bot:W1]` commits for hours, no `[bot:W2]` either, edits aren't propagating in either direction.

**Diagnose**

1. Open the GitHub mirror repo. Look at the last commit by `[bot:W1]` or `[bot:W2]`. If it's >40 min old, the sync is stalled.
2. In n8n, open the **W0 orchestrator** workflow (the every-20-min cron). Check the **Executions** tab — should be a green run within the last 20 min.
3. Verify both **W1** and **W2** workflows show `Active: ON` in the n8n workflow list.

**Fix**

1. If W0 is **inactive**, toggle it back to active and click **Execute Workflow** once to kick a run.
2. If W0 is **active but no recent executions**, the schedule trigger died. Open the workflow, edit anything trivial (a comment in a Code node), save, and re-publish. n8n cloud sometimes drops cron triggers on a deploy and a republish re-arms them.
3. If W0 is firing but W1 / W2 are **archived**, re-import their JSON from `workflows/` and re-bind credentials.
4. If W0 ran and you see a red execution, click into it and follow whichever step below matches the failing node (401 on GitHub → entry 2; 401 on Morgen → entry 3).

**Why it happens**

n8n cloud occasionally drops schedule triggers after a workflow edit or a platform-side deploy. The watchdog will catch this within an hour by opening a GitHub issue, but the fix is the same — republish the workflow.

---

### 2. W1 401-failing on GitHub

> W1 execution shows red on the **GitHub Tree fetch** or **GitHub Contents commit** node with `401 Unauthorized` or `Bad credentials`.

**Diagnose**

1. Open the failed W1 execution in n8n.
2. Click the red node. Look at the **Authorization** header value or the bound credential.
3. If you see `Bearer ghp_...` or the credential name is greyed out, the PAT is invalid, expired, or unbound.

**Fix**

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens** → generate a new token. Scope: **Contents: Read and write** on your tasks mirror repo only.
2. In n8n: **Credentials → GitHub (task-maxxing)** → paste the new token → **Save**.
3. Re-publish W1 (open the workflow, click **Save**, then toggle **Active** off and on).
4. Trigger one manual run via **Execute Workflow**. It should land green within 30s.

**Why it happens**

Fine-grained PATs default to 90-day expiry. Mark your calendar for renewal at ~80 days, or use a no-expiry token (less safe — your call).

---

### 3. W2 401-failing on Morgen

> W2 execution shows red on a `https://api.morgen.so/v3/...` node with `401 Unauthorized`.

**Diagnose**

1. Open the failed W2 execution.
2. Click the red node, check the `Authorization: ApiKey ...` header.
3. Verify the API key isn't `undefined` or empty (n8n shows `[CREDENTIAL]` placeholder when bound — empty means unbound).

**Fix**

1. In Morgen: **Settings → API & Integrations → Generate API key** (or rotate the existing one — note that rotating revokes the old key).
2. In n8n: **Credentials → Morgen (task-maxxing)** → paste the new key → **Save**.
3. Re-publish W2 (toggle **Active** off / on).
4. **Execute Workflow** once to confirm green.

**Why it happens**

Morgen API keys don't auto-expire, but they get revoked if you rotate them in the Morgen UI for any reason. There's no warning — the n8n credential just starts returning 401.

---

### 4. n8n cloud instance unreachable

> The n8n UI won't load, or workflows are stuck in a `running` state forever.

**Diagnose**

1. Visit [status.n8n.io](https://status.n8n.io/) — check for active incidents.
2. Try loading your n8n workspace URL in an incognito window (rules out a stale auth cookie).

**Fix**

- **If n8n is down platform-wide**: wait. The watchdog will alert when commits go stale, and the sync resumes automatically once n8n is back. No manual intervention needed.
- **If only your instance is wedged**: open a support ticket with n8n. In the meantime, you can self-host n8n locally and re-import the workflows from `workflows/` — see [n8n's self-host docs](https://docs.n8n.io/hosting/) (out of scope here).
- **If your auth cookie went stale**: clear cookies for the n8n domain and log back in.

---

## WORKING-BUT-WRONG

### 5. Duplicate tasks in Morgen

> Same task text appears twice (or more) in the Morgen sidebar.

**Diagnose**

```bash
# In your vault, grep for the duplicated task text without the 🆔 token:
cd "$VAULT_PATH/06-Tasks"
grep -rn "the task text here" .

# Then check whether the matching line in markdown carries 🆔 m-XXXXXXXX:
grep -rn "🆔 m-" . | grep "the task text here"
```

If the markdown line has no `🆔 m-XXXXXXXX`, that's the bug — W1 minted a fresh ID on the next run because it couldn't find the existing one.

**Fix**

1. Open the Morgen sidebar. Find the dupe pair. Pick the one with the most recent `updatedAt` and **copy its task ID** from the URL or details panel (Morgen task IDs look like `m-a1b2c3d4`).
2. **Delete** the other Morgen dupe.
3. In your vault, edit the task line and append the surviving ID:
   ```
   - [ ] task text ⏫ 📅 2026-05-10 🆔 m-a1b2c3d4
   ```
4. Save. Daemon commits, W1 runs on the next 20-min tick. From now on, that task is stable.

Alternative: open `06-Tasks/.sync-state.json`, find the entry by `text`, copy its `morgenTaskId`, paste back into the markdown line as the `🆔` value.

**Why it happens**

W1's only join key from markdown → Morgen is the `🆔 m-XXXXXXXX` token. If a manual edit, a copy-paste, or a `/save` write strips it, W1 sees an "ID-less new task" and creates a fresh Morgen row alongside the old one. Treat the `🆔` token as load-bearing.

---

### 6. Task edited in Obsidian, not in Morgen

> You changed a task's due date / priority / text in Obsidian, daemon committed it, but Morgen still shows the old value 30+ min later.

**Diagnose**

```bash
cd "$VAULT_PATH/06-Tasks"
git log -1 --pretty=format:"%s%n%b" -- TASKS-*.md FIDGETCODING/**/TASKS-*.md
```

Look at the commit subject. If it starts with **any `[bot:*]` prefix**, that's the problem — W1's echo guard skipped the run.

Also check the n8n W1 executions tab — if there's no execution within the last 20 min on that file's commit, the trigger never fired.

**Fix**

**If the commit was bot-prefixed by accident** (e.g., a tool committed for you with `[bot:save]`):

```bash
# Re-commit with a non-bot subject so W1 picks it up:
cd "$VAULT_PATH/06-Tasks"
git commit --allow-empty -m "manual edit on $(date -u +%FT%TZ)"
git push origin main
```

Within 20 min, W1 will run and propagate to Morgen.

**If you can't redo the commit** (already squashed / pushed elsewhere): just edit the task manually in Morgen to match. The next time you change anything in either side, the sync will reconcile.

**Why it happens**

The echo-loop guard exists to prevent W2's commits from triggering W1 (which would create an infinite ping-pong). The cost is that *any* `[bot:*]` commit is invisible to W1. Use plain prefixes for human edits.

---

### 7. Task edited in Morgen, not in Obsidian

> You changed a task in the Morgen UI (date, priority, completion), but the markdown still shows the old value 30+ min later.

**Diagnose**

1. Open n8n → **W2 workflow** → **Executions** tab. Look for a run within the last 20 min.
2. If executions are running but **no commit** is being pushed, click into the latest run and check the diff node — the change might be invisible to W2's filter.
3. If no executions at all, W2's schedule trigger is dead (see entry 1).
4. Check for Morgen 429s in the execution log — see "Why it happens" below.

**Fix**

1. Open the W2 workflow in n8n.
2. Click **Execute Workflow** to fire a manual run.
3. Watch the run. If it goes green and commits to GitHub, the schedule trigger was just lagging — it'll resume on the next 20-min tick. Done.
4. If the manual run fails on a Morgen API node, follow entry 3 (Morgen 401) or wait 15 min for a 429 rate-limit reset.
5. If the run completes but no commit fires, the task's change wasn't in W2's six tracked dimensions (text, due, scheduled, priority, completion, deletion). Sub-second time changes from Morgen's auto-scheduler intentionally don't round-trip.

**Why it happens**

Morgen's API is rate-limited at 300 points / 15 min. W2's `/v3/tasks/list` call costs 10 points per run, so a 30-task batch update plus list overhead can push us past the budget — Morgen replies 429 and W2 silently defers to the next run.

---

### 8. Task deleted in Obsidian, ghost in Morgen

> You removed a task line from a `TASKS-*.md` file. Daemon committed. Morgen still shows the task.

**Diagnose**

This is the documented asymmetric-delete behavior, not a bug. W1 does **not** soft-delete Morgen tasks when a markdown line disappears — only W2 propagates deletes (Morgen → Obsidian).

```bash
# Confirm the markdown line is actually gone:
cd "$VAULT_PATH/06-Tasks"
git log -p -- TASKS-*.md | grep "🆔 m-XXXXXXXX"
```

**Fix**

To remove the task from both sides cleanly: **delete it in Morgen**. On the next W2 tick (≤20 min), W2 will see the Morgen task is gone and remove the corresponding markdown line (or strike it through, depending on your settings).

If the markdown is already gone and you just want to clear the Morgen ghost: open Morgen, delete it manually. No further sync action needed — there's no markdown line for the deletion to propagate back to.

**Why it happens**

Asymmetric delete is intentional. The original 3-way design treated Notion and Morgen as mirrors — deleting markdown was a destructive act that should require explicit confirmation in the source app. The 2-way version inherits that rule. If you want symmetric delete, that's a workflow change in W1 (open an issue).

---

### 9. `m-XXXXXXXX` IDs being regenerated

> Every W1 run mints a new `🆔 m-XXXXXXXX` for the same task, creating a Morgen dupe each cycle.

**Diagnose**

```bash
cd "$VAULT_PATH/06-Tasks"
git log -p -- TASKS-*.md | grep "🆔 m-" | sort | uniq -c | sort -rn | head
```

If the same task line shows multiple distinct `m-` IDs over recent commits, something is stripping the ID between syncs.

Common culprits:

- A pre-commit hook reformatting markdown (e.g., a Prettier hook flattening emoji tokens).
- A plugin or skill that rewrites task lines without preserving the `🆔` token.
- Manual edits that drop the trailing emoji block.

**Fix**

1. Identify the writer. Run `git log -p` on the task file and find the commit that introduced the ID-less version. The author / commit message tells you which tool.
2. Disable or fix the offending pre-commit / plugin / skill so it preserves trailing `🆔 m-XXXXXXXX` tokens byte-for-byte.
3. Manually re-merge the duplicate Morgen tasks — keep the most recent `m-` ID, delete the others, paste the surviving ID back into the markdown line.
4. Re-commit. From now on, the task should be stable.

**Why it happens**

W1 only mints new IDs when a task line **lacks** the `🆔` token. The mint is the right behavior for genuinely new tasks; it's the wrong behavior when a writer accidentally strips an existing ID. The fix is always upstream — protect the `🆔` token.

---

## DAILY-DRIVER

### 10. Task lands in TASKS-GENERAL

> You created a task that should have gone into a project area file (`TASKS-LORECRAFT.md`, `TASKS-WAGMI.md`, etc.) but it landed in `TASKS-GENERAL.md`.

**Diagnose**

Open the task line. Check the trailing `🏷️` tag (or whatever your task creator uses to route by area). If the tag doesn't match a known area, the creator falls back to `GENERAL`.

**Fix**

1. Cut the line out of `TASKS-GENERAL.md`.
2. Paste it into the correct `TASKS-{AREA}.md`.
3. **Preserve the `🆔 m-XXXXXXXX` token byte-for-byte** so the Morgen-side mapping survives the move.
4. Save. Daemon commits, W1 runs on the next tick — Morgen's task tag updates to match the new area.

If you use the `maketasks` skill to create tasks, fix the source: pass the area tag explicitly when creating, or update the alias map so the entity routes to the right area.

**Why it happens**

`TASKS-GENERAL.md` is the catch-all by design. Wrong-area writes are a tagging bug, not a sync bug.

---

### 11. Watchdog crying wolf

> You got a GitHub issue (or Telegram message) saying "no `[bot:W1]` commit in 60+ min" but you can see W1 is healthy.

**Diagnose**

1. Open the GH issue the watchdog created. Note the exact threshold it complained about.
2. Cross-check against the actual last `[bot:W1]` commit timestamp in the mirror repo.
3. Common false-positive causes:
   - You took a real break (no markdown edits, no Morgen edits) for >60 min, so there was nothing for W1 to commit.
   - Your real cadence is slower than 60 min (e.g., W0 firing every 30 min instead of 20 min for some reason).

**Fix**

1. Comment on the watchdog-opened GH issue: `recovered manually — no actual edits in window`.
2. Close the issue.
3. If false positives are frequent, open the **Watchdog workflow** in n8n, find the Code node holding the `STALE_MINUTES` constant, and bump it from `60` to `90` or `120`. Save and re-publish.

**Why it happens**

The watchdog measures "time since last `[bot:W1]` commit" — but if you didn't edit anything in either Morgen or Obsidian for >60 min, W1 has nothing to commit. That's a quiet system, not a broken one. `STALE_MINUTES` is a heuristic; tune it to your actual rhythm.

---

### 12. Telegram alerts not arriving

> The watchdog is opening GH issues fine but the optional Telegram pings never land.

**Diagnose**

1. Open the **Watchdog workflow** in n8n. Find the Telegram node.
2. Check the `TELEGRAM_CHAT_ID` constant in the upstream Code node — is it set, or is it the placeholder `0`?
3. Confirm the bot token is bound (n8n credential `Telegram (task-maxxing)`).

**Fix**

1. **DM your bot once** from the Telegram account that should receive alerts. (The bot can't initiate conversations — Telegram requires a first inbound message.)
2. Fetch your chat ID:
   ```bash
   curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates" | jq '.result[].message.chat.id'
   ```
3. Paste the chat ID into the Watchdog workflow's `TELEGRAM_CHAT_ID` constant. Save and re-publish.
4. Trigger the watchdog manually with a stale state to confirm a real ping arrives.

**Why it happens**

Telegram's bot API requires the user to message the bot first before the bot can send DMs. Skipping that step leaves you with a green-looking workflow that silently no-ops on the Telegram step.

---

## LEGACY

### 13. Upgrading from a 3-way (Notion) install

> You cloned `task-maxxing` before 2026-05-04, originally set it up with Notion in the loop, and now you're seeing weird errors mentioning Notion / W3 / `NOTION_TOKEN`.

**Diagnose**

Check for any of these symptoms:

- A workflow named `W3` (or anything `Notion`-flavored) still shows in your n8n workspace.
- Your n8n credentials list still has a `Notion (task-maxxing)` entry.
- Your `.env` (or n8n env vars) still defines `NOTION_TOKEN`, `NOTION_DATABASE_ID`, or similar.
- Stale execution errors from before the cutover are still in the n8n executions list.

**Fix**

1. **In n8n:**
   - Archive the `W3` workflow (or delete it). It's a no-op stub post-cutover and serves no purpose.
   - Delete the `Notion (task-maxxing)` credential.
   - Open the **W0 orchestrator** workflow. Confirm it only chains `W2 → W1` — if there's still a Notion / W3 step, replace it with a re-imported W0 from `workflows/` in this repo.
2. **In your env:**
   - Remove `NOTION_TOKEN`, `NOTION_DATABASE_ID`, and any related vars from `.env` and from n8n's environment settings.
3. **Re-import the current workflow JSON** from `workflows/W0-orchestrator.json`, `workflows/W1-obsidian-to-morgen.json`, and `workflows/W2-morgen-to-obsidian.json` (filenames may vary — check the directory). Re-bind credentials. Re-publish.
4. **Optional:** if you have lingering Notion task rows you want to archive, do it from the Notion UI directly. The kit no longer touches Notion at all, so leftover rows are inert.

A `MIGRATION.md` may be present in the repo root with a step-by-step walkthrough of the 3-way → 2-way cutover. If it's there, follow it for the cleanup; if not, the steps above cover it.

**Why it happens**

Notion was dropped from the live stack on 2026-05-04. The kit on `main` is two-way only, but old installs carry their original n8n state until you clean it up. The leftover Notion plumbing won't break the 2-way sync — it just clutters the n8n UI and confuses future debugging.

---

## Still stuck?

Open an issue at [github.com/lorecraft-io/task-maxxing/issues](https://github.com/lorecraft-io/task-maxxing/issues) with:

1. **Which entry above you tried** (or "not in the runbook").
2. **The exact error message**, copy-pasted verbatim.
3. **Last 20 lines of the relevant n8n execution log**, redacted of tokens.
4. **A redacted snippet from `06-Tasks/.sync-state.json`** for the affected task.

Most issues are fixable in one round-trip with all four.

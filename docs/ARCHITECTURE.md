# Architecture

This document explains how task-maxxing actually works. If you just want to get it
running, jump to [SETUP.md](SETUP.md). If you want to understand the invariants so you
can debug it (or fork it), you're in the right place.

---

## Table of contents

1. [System overview](#system-overview)
2. [The three workflows](#the-three-workflows)
3. [Source of truth](#source-of-truth)
4. [Hashing strategy](#hashing-strategy)
5. [The `.sync-state.json` file](#the-sync-statejson-file)
6. [Conflict resolution](#conflict-resolution)
7. [Safety rails](#safety-rails)
8. [Morgen API quirks](#morgen-api-quirks)
9. [Notion database schema](#notion-database-schema)
10. [Alternatives and why we didn't pick them](#alternatives-considered)

---

## System overview

task-maxxing has **three moving parts** and one **state file**.

```
                 ┌────────────────────┐
                 │   OBSIDIAN VAULT   │  <── You edit markdown here
                 │   08-Tasks/*.md    │
                 │   .sync-state.json │
                 └──────┬─────────────┘
                        │
                        │  [local daemon]
                        │  debounced file watch
                        │  git add / commit / push
                        ▼
              ┌─────────────────────┐
              │  GitHub tasks repo  │  (a mirror, not your vault)
              │  webhooks on push   │
              └──────┬──────────────┘
                     │
                     │  webhook
                     ▼
            ┌───────────────────┐
            │   n8n (cloud or   │
            │   self-hosted)    │
            │                   │
            │   W1  Obsidian →  │───► Notion Tasks DB
            │       Notion &    │───► Morgen tasks (inbox)
            │       Morgen      │
            │                   │
            │   W2  Morgen →    │◄─── Morgen (closed tasks)
            │       Obsidian    │───► GitHub (commit .md)
            │                   │
            │   W3  Notion →    │◄─── Notion (Done / dates)
            │       Obsidian    │───► GitHub (commit .md)
            └───────────────────┘
                     │
                     │  git pull
                     ▼
             back into vault
```

### The state file

`.sync-state.json` lives at the root of your 08-Tasks mirror and holds everything the
system needs to know about every task. It is the "glue" between the three apps —
without it, no workflow can tell whether a row in Notion corresponds to an existing
markdown task or a new one to be created.

It's produced by the daemon during parsing, consumed by all three workflows, and
updated by all of them. The schema is documented below.

### The daemon

A small Node process running under launchd on your Mac. Its job is tiny:

1. Watch `08-Tasks/**/*.md` with `chokidar` (1s debounce).
2. Run `sync-helpers.js parseAll` to re-generate `.sync-state.json`.
3. `git add && git commit && git push` with a bot commit message prefix.

That's it. The daemon does not talk to Notion or Morgen. It only talks to git.

---

## The three workflows

### W1 — Obsidian → Notion + Morgen

**Trigger:** GitHub push webhook on the tasks mirror repo.

**Flow:**

1. Webhook fires on `push` to main.
2. n8n clones (shallow) the repo and reads the incoming `.sync-state.json`.
3. For every task in state, it diffs against the **previous** state stored in n8n's
   workflow static data (`workflowStaticData.global.lastSyncedState`).
4. Produces a list of operations:
   - `create` — task is new; not in previous state.
   - `update` — task hash changed.
   - `archive` — task was in previous state, now gone from markdown.
   - `noop` — hash unchanged.
5. Batches operations per service:
   - **Notion:** for each op, calls `POST /v1/pages` (create), `PATCH /v1/pages/:id`
     (update), or `PATCH` with `archived: true` (archive). Throttled to 3 req/s.
   - **Morgen:** for each op, calls `POST /v3/tasks`, `PATCH /v3/tasks/:id`, or
     `DELETE /v3/tasks/:id`. Throttled to stay under 100 points / 15 min.
6. On success, writes the updated `{notionPageId, morgenTaskId, morgenEtag, lastSyncedAt, lastSyncedHash}`
   fields back into `.sync-state.json` via a GitHub contents API commit (with a
   `[bot:w1]` commit prefix so the daemon and W1 don't echo-loop).

**Rate budget:** capped at 100 Notion ops + 100 Morgen ops per run. If you exceed the
budget, W1 stops, logs a warning, and the next push picks up the remainder.

**Timeout:** 60 seconds total. If W1 is ever taking longer, either you're doing a
backfill (run the backfill script manually) or your Notion throttle is too low.

### W2 — Morgen → Obsidian

**Trigger:** 60-second cron.

**Flow:**

1. Pulls the current `.sync-state.json` from GitHub.
2. `GET /v3/tasks?taskListId=inbox` and builds a map `morgenTaskId → task`.
3. For each task in `.sync-state.json` that has a `morgenTaskId`:
   - If the Morgen task is `closed` AND `.sync-state.json` says it was open, mark
     the markdown line as `- [x]`.
   - If the Morgen `updatedAt` > `.sync-state.json.lastSyncedAt` AND any of
     `dueDate`, `scheduledDate`, `priority`, `text` changed, propagate those to
     the markdown task.
4. Writes a single commit to GitHub with all markdown edits, message `[bot:w2] morgen sync`.
5. Updates `.sync-state.json` with new `lastSyncedAt` and `lastSyncedHash` for each
   edited task.

**Why not push direct to a file?** n8n cloud can't ssh into your Mac, so we go through
git. This also gives us free history.

### W3 — Notion → Obsidian

**Trigger:** 60-second cron.

**Flow:** Same shape as W2, but the source is Notion.

1. Pulls `.sync-state.json`.
2. `POST /v1/databases/:id/query` with filter `last_edited_time > lastSyncedAt of
   latest task`.
3. For each changed row, look up `notionPageId → task` in state.
4. Diff Notion properties against markdown:
   - `Status` → `Done` flips the checkbox to `- [x]`.
   - `Priority` change → emoji swap (`highest` / `high` / `medium` / `low` / `lowest`).
   - `Due` change → `📅 YYYY-MM-DD`.
   - `Scheduled` change → `⏳ YYYY-MM-DD`.
5. Commits all edits to the GitHub mirror with message `[bot:w3] notion sync`.
6. Updates `.sync-state.json`.

### Edge paths

There are three edges that don't map cleanly to W1/W2/W3 and are worth calling out:

- **Notion → Morgen:** handled *through* Obsidian. W3 writes the change to markdown,
  the daemon pushes, W1 picks it up and writes it to Morgen. Latency: ~90s.
- **Morgen → Notion:** same shape. W2 → daemon → W1. Latency: ~90s.
- **Delete:** deleting a markdown line removes the task from both mirrors on the next
  W1 run. Deleting a Notion row or Morgen task does **not** propagate; the next
  W1 sync will re-create them because markdown is canonical.

---

## Source of truth

**Obsidian is canonical. Notion and Morgen are mirrors.**

Every invariant in the system comes from this single rule. If Obsidian disagrees with
Notion, Obsidian wins. If Obsidian disagrees with Morgen, Obsidian wins. If all three
disagree, Obsidian wins.

The only exception is **last-writer-wins** on a three-way tie where the Obsidian state
was known to be stale — see [Conflict resolution](#conflict-resolution).

### Why Obsidian?

- **Durability.** Markdown in git will still be readable in 20 years. Notion's API
  won't.
- **Editability.** A plain `.md` file can be edited from vim, the Obsidian app, a GitHub
  web UI, a phone app, a shell script, or a parent LLM agent. Notion and Morgen can
  only be edited through their own clients.
- **Queryability.** Obsidian's Tasks plugin already gives you rich filters, sort,
  group-by-path, etc. We don't need to re-invent that UI.
- **Backup story.** Every commit is a backup. Every fork of the tasks mirror is a
  backup. You can't delete the vault by clicking the wrong button.

### What "canonical" actually means in code

1. When W1 runs, it diffs the committed markdown against `.sync-state.json` and
   propagates **every** difference to Notion and Morgen. If Notion has a newer field
   that isn't in markdown, Notion loses.
2. W2 and W3 only ever propagate `closed / done / date changes` — they don't propagate
   arbitrary field rewrites. This keeps the graph pointing Obsidian-ward.
3. If `.sync-state.json` ever gets corrupted (delete / conflict / bad merge), the fix
   is always "delete it and re-run the backfill script" — which rebuilds state from
   the markdown, because **the markdown is canonical**.

---

## Hashing strategy

Every task gets a stable identity hash computed from its markdown-relevant fields.

```javascript
// src/sync-helpers.js
const crypto = require('crypto');

function hashTask(task) {
  const canonical = [
    task.sourceFile,              // e.g. "08-Tasks/TASKS-URGENT.md"
    task.text.trim(),             // the plain task text
    task.priorityInt ?? 0,        // 5=highest, 4=high, 3=medium, 2=low, 1=lowest, 0=none
    task.due ?? '',               // "YYYY-MM-DD" or ""
    task.scheduled ?? '',         // "YYYY-MM-DD" or ""
  ].join('::');

  return crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 24);
}
```

**Why 24 hex chars?** 96 bits of collision resistance is fine for a single user's task
backlog (N < 10k tasks indefinitely). It's also short enough to eyeball in logs and git
commits.

**Why include `sourceFile`?** So that the same text "Ship task-maxxing" in
`TASKS-LORECRAFT.md` and `TASKS-URGENT.md` counts as two distinct tasks. If you move a
task between files, W1 sees it as `archive + create`, not `update`. That's intentional
— it keeps the hash stable under in-file edits but lets us route area membership
properly.

**Why not include the line number?** Because you can re-order tasks in a file without
semantic change. The hash should be order-independent within a file.

### When the hash changes

A hash change is the system's "this task was edited" signal. The hash changes if and
only if:

- the task text changed
- the priority changed
- the due date changed
- the scheduled date changed
- the task moved to a different file

**Completion state is NOT in the hash.** Completion is tracked separately via
`task.completed` (boolean) so that closing a task doesn't look like "edit the task
text" to the diff engine.

---

## The `.sync-state.json` file

Single source of truth for cross-app identity mapping. Committed to the GitHub mirror
repo at `./sync-state.json` (note: the *mirror* strips the leading dot to avoid
gitignore issues — this is also why your vault's `.gitignore` excludes it, so the
working copy and the mirror can be different).

### Schema

```json
{
  "version": 2,
  "generatedAt": "2026-04-14T15:33:00.000Z",
  "generatedBy": "daemon@1.0.0",
  "tasks": {
    "a3f9d2c1b8e4f7a6d5c9e2b1": {
      "hash": "a3f9d2c1b8e4f7a6d5c9e2b1",
      "sourceFile": "08-Tasks/TASKS-URGENT.md",
      "sourceLine": 12,
      "text": "Ship task-maxxing v0.1",
      "completed": false,
      "priority": "high",
      "priorityInt": 4,
      "due": "2026-05-01",
      "scheduled": "2026-04-20",
      "start": null,
      "recurrence": null,
      "tags": ["#ship"],
      "notionPageId": "{{NOTION_PAGE_ID}}",
      "morgenTaskId": "{{MORGEN_TASK_ID}}",
      "morgenEtag": "W/\"1712345678\"",
      "lastSyncedAt": "2026-04-14T15:32:00.000Z",
      "lastSyncedHash": "a3f9d2c1b8e4f7a6d5c9e2b1",
      "lastSyncedBy": "w1"
    }
  },
  "byNotionId": {
    "{{NOTION_PAGE_ID}}": "a3f9d2c1b8e4f7a6d5c9e2b1"
  },
  "byMorgenId": {
    "{{MORGEN_TASK_ID}}": "a3f9d2c1b8e4f7a6d5c9e2b1"
  }
}
```

### Field guide

| Field                     | Who writes it    | Purpose                                                       |
|---------------------------|------------------|---------------------------------------------------------------|
| `version`                 | daemon           | Schema version. Bump on breaking change.                      |
| `generatedAt`             | daemon           | ISO timestamp of the last full parse.                         |
| `generatedBy`             | daemon           | Build version of the daemon that wrote this state.            |
| `tasks`                   | daemon           | Map keyed by task hash.                                       |
| `tasks.<h>.hash`          | daemon           | Same as the key. Duplicated for convenience.                  |
| `tasks.<h>.sourceFile`    | daemon           | Path relative to vault root.                                  |
| `tasks.<h>.sourceLine`    | daemon           | 1-indexed line number. Informational only.                    |
| `tasks.<h>.text`          | daemon           | Plain task text, emoji + metadata stripped.                   |
| `tasks.<h>.completed`     | daemon + W2/W3   | Completion checkbox state.                                    |
| `tasks.<h>.priority`      | daemon           | One of `highest / high / medium / low / lowest / none`.       |
| `tasks.<h>.priorityInt`   | daemon           | Numeric priority for ordering + hashing.                      |
| `tasks.<h>.due`           | daemon           | `YYYY-MM-DD` or null.                                         |
| `tasks.<h>.scheduled`     | daemon           | `YYYY-MM-DD` or null.                                         |
| `tasks.<h>.start`         | daemon           | `YYYY-MM-DD` or null (start date).                            |
| `tasks.<h>.recurrence`    | daemon           | Raw recurrence string (e.g. `every week`).                    |
| `tasks.<h>.tags`          | daemon           | Array of `#tag` strings.                                      |
| `tasks.<h>.notionPageId`  | W1               | ID of the corresponding Notion page. Null until W1 creates.   |
| `tasks.<h>.morgenTaskId`  | W1               | ID of the corresponding Morgen task. Null until W1 creates.   |
| `tasks.<h>.morgenEtag`    | W1               | Morgen's If-Match etag, for 409 detection.                    |
| `tasks.<h>.lastSyncedAt`  | W1 / W2 / W3     | Last successful sync timestamp.                               |
| `tasks.<h>.lastSyncedHash`| W1 / W2 / W3     | Hash at the time of last sync.                                |
| `tasks.<h>.lastSyncedBy`  | W1 / W2 / W3     | Which workflow wrote this sync record.                        |
| `byNotionId`              | W1               | Reverse index: Notion page ID → task hash.                    |
| `byMorgenId`              | W1               | Reverse index: Morgen task ID → task hash.                    |

### Lifecycle

1. **Create:** user adds `- [ ] New task 📅 2026-05-01` to `TASKS-URGENT.md`. Daemon
   parses, computes hash, adds entry with `notionPageId: null, morgenTaskId: null`,
   and pushes to git.
2. **W1 runs:** sees a new hash not in n8n's last-known state, creates a Notion page
   and a Morgen task, writes the IDs back into `.sync-state.json`, commits with
   `[bot:w1]` prefix.
3. **Edit:** user changes the due date. Daemon parses and computes a new hash. It
   preserves old Notion/Morgen IDs by mapping via the `byNotionId`/`byMorgenId`
   indexes, writes a new entry, deletes the old one, and pushes.
4. **W1 runs:** sees the new hash, but looks up Notion/Morgen IDs and issues an
   `update`, not a `create`.
5. **Complete in Morgen:** W2 polls, sees `closed`, writes `- [x]` to markdown via the
   GitHub API with the `[bot:w2]` prefix. Daemon receives the push, re-parses, updates
   state.

---

## Conflict resolution

Three-way sync has a conflict story. task-maxxing resolves conflicts with the
**Obsidian-wins** rule, modulated by `lastSyncedAt` timestamps.

### The rules

1. If the markdown hash differs from `.sync-state.json.lastSyncedHash`, assume **the
   user edited markdown**. W1 will propagate markdown to Notion and Morgen, overwriting
   any Notion/Morgen changes that happened in the same window.
2. If W2/W3 polls and finds a change in Notion/Morgen *and* the markdown hasn't changed
   since the last sync, propagate the remote change into markdown.
3. If W2/W3 polls and finds a change in Notion/Morgen *and* the markdown has also
   changed, the markdown wins. Log a warning: `conflict: markdown and {notion|morgen}
   both changed for hash <h>; discarding remote change`.
4. On a tie (two timestamps equal to the second), **Obsidian wins**. This almost never
   happens but the rule is deterministic.

### What about simultaneous Notion and Morgen edits?

W1 always runs against the current markdown state and produces a single snapshot. Both
Notion and Morgen receive the same update in the same W1 run. If Notion and Morgen both
also edited independently in the same window, both get overwritten.

### What does NOT trigger an overwrite

- A Notion page edited in a field task-maxxing doesn't track (e.g., a custom column you
  added). Those are left alone — W1 only touches the fields it knows about.
- A Morgen task's position on the calendar. The calendar link isn't an API-managed
  field yet, so dragging a task on the Morgen calendar never round-trips into
  markdown. (See [Morgen API quirks](#morgen-api-quirks).)

---

## Safety rails

Three-way sync without safety rails is a foot-gun. task-maxxing has four.

### 1. Rate budget

Each W1 run is capped at **100 Notion ops** and **100 Morgen ops**. If the diff has
more, W1 processes the first 100, logs `budget exceeded; remaining N ops deferred to
next run`, and exits green. The next push triggers W1 again and the remaining ops get
processed.

This keeps us under:

- Notion's 3 req/s rate limit (100 ops at 3 req/s ≈ 34s, well inside the 60s workflow
  timeout).
- Morgen's 100 points / 15 min rate limit (100 ops × 1 point ≈ exactly at the cap —
  which is why creates/updates are the only ops we batch).

### 2. Flip ratio guard

Before W1 applies any destructive operation (archive or delete), it computes the
**flip ratio**:

```
flipRatio = (creates + archives + updates) / totalTasks
```

If `flipRatio > 0.25`, W1 stops, writes a warning, and refuses to proceed. This
catches the "I accidentally deleted my entire TASKS-URGENT.md file" class of bug.
Rather than archiving every task in Notion, W1 pauses and asks you to investigate.

Override: set `FORCE_SYNC=true` in the workflow env vars for one run.

### 3. Echo-loop guard

Every git commit from a bot (W1, W2, W3, or the daemon) has a commit message prefix:

- Daemon: `[bot:daemon]`
- W1: `[bot:w1]`
- W2: `[bot:w2]`
- W3: `[bot:w3]`

The W1 webhook handler checks `commits[].message` on the incoming push. If **every**
commit in the push is prefixed with `[bot:*]`, W1 skips the Notion/Morgen write phase.
It still reads `.sync-state.json` (in case it's been updated) but won't fire writes.
This prevents the loop:

```
W2 writes markdown → push → W1 fires → W1 writes Notion → Notion row changes →
W3 reads it next cycle → W3 writes markdown → push → W1 fires → ...
```

Without the guard, a single completion event could fire an infinite ping-pong.

### 4. 409 retry on Morgen

Morgen's PATCH endpoints support `If-Match` with an etag. If W1's update comes back
`409 Conflict`, it:

1. Fetches the current Morgen task (one extra GET).
2. Re-computes the diff against the new etag.
3. Retries once with the new etag.
4. If the second attempt also fails, logs and defers to the next run.

This handles the case where you edited the task in Morgen between W1 reading state and
W1 writing.

---

## Morgen API quirks

Morgen's API is functional but has sharp edges worth knowing about.

### Rate limit: 100 points / 15 min

Morgen uses a point-based rate limit. Most ops are 1 point; a couple of bulk
endpoints are more. task-maxxing treats everything as 1 point and stays under 100
ops per 15-min window.

### Task-to-calendar API is unavailable

The Morgen UI lets you drag a task onto the calendar, which "schedules" it with a
specific duration and time. As of writing, **there is no API to do this**. The
`scheduledDate` field on a task sets a *day*, not a time block.

**Implication:** task-maxxing writes your scheduled date to Morgen's `scheduledDate`,
but the actual time block is always placed by Morgen's own auto-scheduler (if you have
it on) or manually by you.

### Task tags are UUIDs

Morgen's `tags` field on a task is an array of tag **IDs**, not tag names. To tag a
task, you need to either:

1. Look up the tag by name via `GET /v3/tags`, or
2. Create the tag first, grab the ID, then attach it to the task.

task-maxxing maintains an in-memory `_tagCache` keyed by name → ID in each workflow run
so we don't burn rate limit looking up the same tags over and over. The cache is
flushed at the start of each W1 run.

### `taskListId=inbox` only

Morgen has the concept of task lists (like "Inbox", "Personal", "Work") but their API
doesn't yet let us create or reorder lists. Everything task-maxxing writes lands in
`inbox`. If you use multiple lists in Morgen by hand, great — but don't expect
task-maxxing to populate them.

### `integrationId` filter

When W2 polls Morgen tasks, it filters by `integrationId` to exclude tasks that came
from Morgen's other integrations (your calendar-scraped todos, for example). Only
tasks W1 created (which carry our `integrationId`) round-trip back. This is how we
avoid "why is every gmail task showing up in my vault" behavior.

---

## Notion database schema

task-maxxing expects a Notion database with the following properties. The installer
doesn't create this for you — you create it in the Notion UI once, then paste the
database ID into `.env`.

| Property      | Type          | Required? | Notes                                                               |
|---------------|---------------|-----------|---------------------------------------------------------------------|
| **Name**      | Title         | yes       | The task text.                                                      |
| **Status**    | Select        | yes       | Options: `To Do`, `Doing`, `Done`. Default `To Do`.                 |
| **Priority**  | Select        | yes       | Options: `Highest`, `High`, `Medium`, `Low`, `Lowest`, `None`.      |
| **Area**      | Select        | yes       | Options match your `TASKS-*.md` files (e.g. `URGENT`, `LORECRAFT`). |
| **Due**       | Date          | no        | Maps to the due date in markdown.                                   |
| **Scheduled** | Date          | no        | Maps to the scheduled date in markdown.                             |
| **Source**    | Rich text     | yes       | Full path of the source markdown file. Populated by W1.             |
| **Hash**      | Rich text     | yes       | Task hash. Populated by W1.                                         |
| **Tags**      | Multi-select  | no        | Passed through from markdown `#tags`.                               |
| **Synced At** | Date          | yes       | Last W1 sync timestamp. Populated by W1.                            |

**Area values** are derived from the filename: `TASKS-URGENT.md` becomes `URGENT`,
`TASKS-LORECRAFT.md` becomes `LORECRAFT`, and so on. You'll need to add each value to
the `Area` select options before W1 runs — W1 errors out rather than silently creating
new options. (Notion creates options on the fly, but they'll have random colors and
cleanup is manual.)

See `notion/tasks-db-schema.md` for a copy-pasteable spec you can hand to Notion's
database UI.

---

## Alternatives considered

> "Why didn't you just use X?"

### Zapier / Make

Died the moment we needed three-way sync with a conflict resolution rule. Zapier's
"multi-step zaps" can chain but they don't have shared state between runs, so there's
no way to remember that task `abc` already has Notion ID `xyz`. You'd end up creating
duplicates on every run.

### Notion API + custom Obsidian plugin

Plausible, but:

1. Obsidian plugins run in the Obsidian process, which isn't always running.
2. They can't easily write to Morgen because the Morgen SDK isn't available in the
   Electron renderer context.
3. Plugin distribution and updates are a headache compared to a git repo.

### A bespoke webhook gateway (self-hosted Node server)

This is what task-maxxing almost became. The reason we went with n8n is:

- **Debuggability.** n8n shows you the input/output of every node for every run.
  Debugging a bespoke Node server means reading your own logs.
- **Retries and scheduling.** n8n gives you cron + retry + error workflows for free.
- **Credential management.** n8n stores OAuth tokens and API keys once; you don't
  bake them into env vars on a VPS.
- **UI.** When something breaks, you can click "execute workflow" and see the failure
  in real time.

The downside is you depend on n8n. But n8n is open source and self-hostable, so
vendor risk is capped.

### Todoist MCP / Motion MCP

Both are one-app-at-a-time. Motion doesn't round-trip to Obsidian without custom code.
Todoist hit Nathan's free-tier project cap within a week and was uninstalled.

### Syncthing / Obsidian Sync

Those sync the *vault* between your own devices, but they don't turn a `.md` task into
a Notion row or a Morgen task. Orthogonal problem.

### Just use Obsidian and nothing else

This is the right answer for a lot of people. task-maxxing is for people who
specifically need (a) a shareable UI for collaborators or a client, and (b) an
auto-scheduling calendar, *and* want their data to stay in markdown.

---

## Next

- Walk through [SETUP.md](SETUP.md) to get a working install.
- If you hit something weird, [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the
  failure modes seen in real runs.
- To modify the workflows or add fields, see [CONTRIBUTING.md](CONTRIBUTING.md).

# Architecture

How the kit actually works. If you just want it running, see [SETUP.md](SETUP.md). If you want to understand the invariants well enough to debug or fork it, you're in the right place.

---

## TL;DR (30 seconds)

- **What it does.** Keeps your tasks in sync, two ways, between **Obsidian markdown** (your `05-Tasks/` folder) and **Morgen** (the calendar that auto-schedules your day).
- **What it solves.** Edit a task in either place — tick it off on your phone in Morgen, or rewrite the date in Obsidian — and the other side catches up on the next 20-minute tick. No manual double-entry, no SaaS lock-in, no proprietary file formats.
- **What you get after install.** A local launchd daemon that commits vault edits to a private GitHub repo, two n8n workflows (`W1`, `W2`) sequenced by an orchestrator (`W0`) every 20 minutes, a watchdog workflow that opens an issue if the sync goes silent, and a `.sync-state.json` file that carries the cross-app identity map.
- **What's canonical.** Your markdown. Always. Morgen is a regenerated mirror — if it disagrees with the vault, the vault wins.

> **Heads up — this kit went 2-way in May 2026.** It used to be a 3-way Obsidian ↔ Notion ↔ Morgen sync. Notion was dropped 2026-05-04. Everywhere below describes the **current** 2-way state. The Notion era is summarized at the bottom under [What changed in May 2026](#what-changed-in-may-2026-notion-drop).

---

## Table of contents

1. [System diagram](#system-diagram)
2. [Source of truth](#source-of-truth)
3. [Component reference](#component-reference)
   - [Local daemon](#local-daemon)
   - [W0 — Sync Orchestrator](#w0--sync-orchestrator)
   - [W1 — Obsidian → Morgen](#w1--obsidian--morgen)
   - [W2 — Morgen → Obsidian](#w2--morgen--obsidian)
   - [Sync-Health-Watchdog](#sync-health-watchdog)
4. [The `.sync-state.json` file](#the-sync-statejson-file)
5. [The bot-prefix echo guard](#the-bot-prefix-echo-guard)
6. [Hashing and task identity](#hashing-and-task-identity)
7. [Conflict resolution](#conflict-resolution)
8. [Tradeoffs](#tradeoffs)
9. [What changed in May 2026 (Notion drop)](#what-changed-in-may-2026-notion-drop)

---

## System diagram

The production graph is one orchestrator firing two child workflows in series, every 20 minutes, plus a separate hourly watchdog.

```
                              ┌────────────────────────────┐
                              │      OBSIDIAN VAULT        │  <── you edit markdown here
                              │      05-Tasks/*.md         │
                              │      .sync-state.json      │
                              └─────────────┬──────────────┘
                                            │
                                  [local launchd daemon]
                                  debounced file watch
                                  git add / commit / push
                                            │
                                            ▼
                              ┌────────────────────────────┐
                              │  GitHub: tasks mirror repo │  (e.g. YOUR-VAULT-tasks)
                              │  main branch, push-based   │
                              └─────────────┬──────────────┘
                                            │  GitHub Tree + Contents API
                                            ▼
   ┌───────────────────────────────────────────────────────────────────────────┐
   │                                  n8n                                      │
   │                                                                           │
   │   ┌─────────────────────────────────────────────────────────────┐         │
   │   │  W0 — Sync Orchestrator       (Schedule: every 20 min)      │         │
   │   │                                                             │         │
   │   │     executeWorkflow W2  (wait=true)                         │         │
   │   │           │                                                 │         │
   │   │           ▼                                                 │         │
   │   │     executeWorkflow W1  (wait=true)                         │         │
   │   └─────────────────────────────────────────────────────────────┘         │
   │              │                                  │                         │
   │              ▼                                  ▼                         │
   │   ┌─────────────────────┐          ┌─────────────────────────────┐        │
   │   │  W2 — Morgen        │          │  W1 — Obsidian → Morgen     │        │
   │   │       → Obsidian    │          │  parses TASKS-*.md, upserts │        │
   │   │  6 directions:      │          │  via Morgen REST API        │        │
   │   │   • complete        │          │  mints 🆔 m-XXXXXXXX        │        │
   │   │   • edit-text       │          │  bot-prefix echo guard ────┐│        │
   │   │   • soft-delete     │          │                            ││        │
   │   │   • new task        │          │                            ││        │
   │   │   • cev_ complete   │          │                            ││        │
   │   │   • cev_ discovery  │          │                            ││        │
   │   └──────────┬──────────┘          └─────────────┬──────────────┘│        │
   │              │ [bot:W2] commits                  │ [bot:W1]      │        │
   │              │ via GitHub Contents API           │ commits to    │        │
   │              ▼                                   ▼ state file    │        │
   └───────────────────────────────────────────────────────────────────┼───────┘
                  │                                   │                │
                  ▼                                   ▼                │
        ┌────────────────────────┐       ┌────────────────────────┐    │
        │  GitHub tasks mirror   │◄──────┤        Morgen          │    │
        │  (commits land here,   │       │  /v3/tasks REST API    │────┘
        │   daemon pulls back    │       │  (inbox list only)     │
        │   into vault)          │       └────────────────────────┘
        └────────────────────────┘

   ┌───────────────────────────────────────────────────────────────────────────┐
   │  Sync-Health-Watchdog        (Schedule: every hour, independent of W0)    │
   │                                                                           │
   │   GitHub commits API → if no [bot:W1] commit in last 60 min               │
   │                        → open GitHub issue + (optional) Telegram alert    │
   │                        → on recovery: auto-close                          │
   └───────────────────────────────────────────────────────────────────────────┘
```

Two important properties of that picture:

1. **Sequencing, not parallelism.** W0 runs W2 *then* W1 with `wait=true`. Two independent cron triggers would race each other on `.sync-state.json` and produce interleaved commits. W0 makes the state file mutate serially.
2. **n8n cloud never touches your disk.** Everything moves through the GitHub API. The local daemon is the only process with filesystem access — this lets W2 write back to your vault as plain commits and keeps your machine out of n8n's trust boundary.

---

## Source of truth

**Obsidian is canonical. Morgen is a mirror.**

Every invariant in the system follows from that one rule:

- If Obsidian and Morgen disagree on text, dates, or priority, **Obsidian wins**. W1 will overwrite Morgen on the next tick.
- If `.sync-state.json` is corrupted or lost, the fix is always "delete it and re-seed from markdown" — because the markdown is canonical, the state file is recoverable from it.
- W2 only propagates a narrow set of changes back into markdown (completion, soft-delete, new-task discovery, calendar-event linkage). It never propagates arbitrary field rewrites. This keeps the gradient pointed Obsidian-ward.
- Markdown-as-canonical means your data survives every tool in this stack getting acquired, deprecated, or rate-limited into uselessness. Worst case, you turn off n8n and you still have a folder of `.md` files in git.

---

## Component reference

### Local daemon

**Type:** zero-dep Node script (`src/auto-commit.js`) invoked by macOS `launchd`.

**Trigger:**
- `WatchPaths` on `05-Tasks/**` (debounced via `ThrottleInterval=30s`).
- `StartInterval=300s` heartbeat so it runs at least every 5 minutes even when nothing fires.

**What it does:**
1. Full Disk Access preflight — reads `${VAULT}/.git/HEAD`. If macOS TCC blocks it, exits with an explicit "grant FDA to the Node binary at X" error and prints the path.
2. If the working tree is clean, exits 0.
3. Otherwise: `git add -A` → `git commit -m "[bot:daemon] auto: task edit <ISO-8601-UTC>"` → `git push origin main`.
4. Appends every outcome (clean tick, commit, push, error) to `~/Library/Logs/task-maxxing.log` plus a heartbeat file.

**What it does NOT do:** parse markdown, talk to Morgen, regenerate `.sync-state.json`. It only talks to git. The state file is owned by `scripts/morgen-backfill.js` for the initial seed and by W1/W2 at runtime.

**Failure modes:**
- macOS TCC denies disk read → daemon errors loudly, install instructions printed to log.
- Network down on push → next heartbeat retries; commits queue locally.
- Non-`[bot:*]` commits from a misbehaving editor → would round-trip through W1 and loop forever, except the [bot-prefix echo guard](#the-bot-prefix-echo-guard) skips them.

Full installer walkthrough lives in [`daemon/README.md`](../daemon/README.md).

---

### W0 — Sync Orchestrator

**Workflow file:** `workflows/W0-orchestrator-sync-sequencer.json`.

**Trigger:** n8n Schedule node, every **20 minutes**.

**Inputs:** none — it's a cron-driven coordinator.

**What it does:**
1. `executeWorkflow` W2 (`wait=true`).
2. `executeWorkflow` W1 (`wait=true`).

That's the entire workflow. The only thing it owns is the run order.

**Why an orchestrator at all?** Because two independent cron triggers can interleave. Without W0, W1 mid-run can clobber a `.sync-state.json` update from W2, or vice versa, and you end up with phantom completions, lost edits, or duplicate Morgen tasks. W0 serializes them: pull from Morgen first, then push the merged state out.

**The only workflow you activate.** W1 and W2 stay inactive in the n8n UI; W0 calls them directly. If you also activate W1 or W2, you'll get double-fires — n8n handles duplicate work cheaply because the workflows are diff-aware, but you're burning Morgen rate budget for no reason.

**Self-overlap quirk.** n8n's Schedule trigger does NOT skip-if-running. If a 20-minute tick fires while the previous W0 is still executing (possible during a large backfill), the second W0 queues up and starts immediately after — which re-introduces the very race W0 was built to prevent. In practice a full W2 + W1 cycle finishes in well under 60 seconds, so the overlap window is tiny. If you see overlap, bump W0 to every 30 minutes.

**Failure modes:**
- W2 errors → W0 stops, W1 doesn't run that tick. State stays consistent because no Morgen writes happened.
- W1 errors after W2 succeeded → W2's writeback is committed, W1 retries on the next tick.
- Both error → watchdog fires after 60 minutes (see below).

---

### W1 — Obsidian → Morgen

**Workflow file:** `workflows/W1-obsidian-git-task-sync.json`.

**Trigger:** Called by W0 via `executeWorkflow`. (A GitHub push trigger is present in the workflow JSON but **dormant in the default install** — leave it inactive unless you opt out of the orchestrator with `SKIP_ORCHESTRATOR=1`.)

**Inputs:**
- The current contents of `05-Tasks/**/TASKS-*.md` from the GitHub mirror (read via Tree API).
- The current `.sync-state.json` from the same repo.
- The previous synced state from `workflowStaticData.global.lastSyncedState`.

**What it does:**
1. Pulls every `TASKS-*.md` file from the mirror via the GitHub Tree API.
2. Parses each task line. Grammar:

   ```
   - [ ] task text <priority?> 📅 YYYY-MM-DD <🔁 recurrence?> 🆔 m-XXXXXXXX
   ```

   Priorities: 🔺 highest · ⏫ high · 🔼 medium · 🔽 low · ⏬ lowest. Dates: 📅 due · ⏳ scheduled · 🛫 start · ✅ done · ❌ cancelled. The `🆔` is the stable join key.

3. Computes a hash per task (see [Hashing and task identity](#hashing-and-task-identity)).
4. Diffs against the previous synced state and produces ops:
   - `create` — task is new, no `🆔` yet, or 🆔 not in state.
   - `update` — known 🆝, hash changed.
   - `close` — known 🆔, markdown shows `- [x]`.
   - `noop` — hash unchanged.
5. Calls Morgen REST API:
   - `POST /v3/tasks/create` for new tasks (returns `morgenTaskId`).
   - `POST /v3/tasks/update` for edits.
   - `POST /v3/tasks/close` for completions. (Morgen exposes close, not delete — there is no `/v3/tasks/delete` endpoint.)
   - Throttled to stay under Morgen's 300 points / 15 min ceiling.
6. **Mints `🆔 m-XXXXXXXX` for tasks that didn't have one.** New IDs use Morgen's 8-hex format (post-cutover). Legacy UUIDv4 IDs in old lines are preserved, not rewritten — the parser accepts both, only new lines get m-IDs.
7. Writes the updated `morgenTaskId`, `morgenId` (calendar entry ID for time-blocked tasks), `lastSyncedAt`, `lastSyncedHash` back into `.sync-state.json` via a `[bot:W1]` commit on the mirror repo.

**Outputs:**
- N Morgen API calls.
- One `[bot:W1]` commit on the tasks mirror.
- An updated `workflowStaticData.global.lastSyncedState` for the next run's diff.

**Side effects:** mints stable IDs, charges Morgen rate-limit points, produces commits on the mirror that the daemon will eventually pull back into the vault.

**Failure modes:**
- Morgen 429 rate limit → W1 logs and defers remaining ops to the next tick.
- Morgen 409 conflict on update → one retry with refreshed etag, then defer.
- GitHub commit fails → state file is not updated; next run's diff will look slightly larger but otherwise correct (idempotent on the markdown side, only the writeback to state is lost).
- Push contains only `[bot:*]` commits → W1 runs but skips Morgen writes (echo guard). It still reads state, in case W2 wrote new IDs.

---

### W2 — Morgen → Obsidian

**Workflow file:** `workflows/W2-morgen-task-completion-sync.json`.

**Trigger:** Called by W0 via `executeWorkflow` (its own Schedule trigger is dormant in the default install).

**Inputs:**
- Morgen tasks via `GET /v3/tasks?taskListId=inbox&limit=500`.
- Morgen calendar events in a rolling -7d to +30d window (37 days), via `POST /v3/events/list`. Tasks dragged onto the calendar in Morgen's UI become `cev_` calendar entries — those are the only way completion-of-time-blocks round-trips back.
- The current `.sync-state.json` and the relevant `TASKS-*.md` files from the GitHub mirror.

**What it does — six sync directions:**
1. **Completion.** Morgen task `closed` AND state says it was open → mark `- [x]` in the source markdown file.
2. **Edit-text.** Morgen `updatedAt` > state `lastSyncedAt` AND text/priority/dates changed → propagate to markdown (text edits only; preserves the 🆔).
3. **Soft-delete.** Morgen task moved to trash → comment out the markdown line (preserves history, lets you un-trash from either side).
4. **New-Morgen-task.** A Morgen task with no `morgenTaskId` in state → append a new line to the appropriate `TASKS-{AREA}.md`, choose `TASKS-GENERAL.md` if no area tag matches.
5. **Calendar-event completion (`cev_`).** A `cev_` calendar entry is marked done in Morgen → mark its parent task `- [x]` in markdown.
6. **Calendar-event discovery (`cev_`).** A new `cev_` entry appears for a known task → store its `morgenId` in `.sync-state.json` for future completion routing.

7. After all six pass, W2 writes a **single** `[bot:W2] morgen sync` commit to the mirror via the GitHub Contents API, batching every markdown edit into one commit.
8. Updates `lastSyncedAt` and `lastSyncedHash` for each touched task in `.sync-state.json`.

**Outputs:**
- Up to one `[bot:W2]` commit on the mirror per run.
- Updated state file.

**Side effects:** appends new lines to area files, flips checkboxes, records calendar IDs.

**Failure modes:**
- Calendar event outside the -7d/+30d window → W2 doesn't see it; events more than 30 days out are invisible until they enter the window.
- Morgen list API silently defaults to `limit=1` if you forget to pass `limit` → W2 always passes `?limit=500`. If you ever fork this and change the list call, set the limit explicitly or you will lose tasks.
- New-Morgen-task with no area tag → routed to `TASKS-GENERAL.md` rather than dropped.

---

### Sync-Health-Watchdog

**Workflow ID (reference instance):** `mzpCCbqD1MvxJhAm`. The installer creates one in your n8n instance with a fresh ID.

**Trigger:** Schedule node, every **1 hour**, independent of W0.

**Inputs:**
- `GET /repos/<owner>/YOUR-VAULT-tasks/commits` filtered for `[bot:W1]` author/message in the last 60 minutes.

**What it does:**
1. If at least one `[bot:W1]` commit landed in the last 60 minutes → no-op, close any open watchdog issue.
2. If zero `[bot:W1]` commits in the last 60 minutes → open (or update) a GitHub issue titled `Sync stalled: no [bot:W1] commit in last 60 min`, optionally fire a Telegram alert if `TELEGRAM_BOT_TOKEN` is set.
3. On recovery (next W1 commit lands), auto-close the issue with a comment.

**Why this exists.** The most failure-prone parts of the kit are external (Morgen API, GitHub API, n8n cloud uptime) and the most common failure mode is "everything looks fine but nothing has actually synced for hours." The watchdog turns silent failure into loud failure.

**Failure modes:**
- Watchdog itself fails → no automatic alert. Inspect n8n executions weekly.
- False positive during an intentional pause (e.g., you're editing markdown for an hour with no completions to round-trip) → close the issue manually; it'll re-open on the next stall.

---

## The `.sync-state.json` file

Single source of truth for cross-app identity mapping. Lives at `05-Tasks/.sync-state.json` in your vault, mirrored to the same path in the GitHub tasks repo.

### Schema

```json
{
  "version": 3,
  "generatedAt": "2026-05-04T15:33:00.000Z",
  "generatedBy": "w1@2.0.0",
  "tasks": {
    "<taskHash>": {
      "hash": "a3f9d2c1b8e4f7a6d5c9e2b1",
      "sourceFile": "05-Tasks/TASKS-URGENT.md",
      "sourceLine": 12,
      "text": "Ship task-maxxing v0.2",
      "completed": false,
      "priority": "high",
      "priorityInt": 2,
      "due": "2026-05-15",
      "scheduled": "2026-05-12",
      "start": null,
      "recurrence": null,
      "tags": ["#ship"],
      "morgenTaskId": "tsk_abc123",
      "morgenId": "cev_xyz789",
      "morgenEtag": "W/\"1715000000\"",
      "obsidianId": "m-1a2b3c4d",
      "lastSyncedAt": "2026-05-04T15:32:00.000Z",
      "lastSyncedHash": "a3f9d2c1b8e4f7a6d5c9e2b1",
      "lastSyncedBy": "w1",
      "notionPageId": null
    }
  },
  "byMorgenId": { "tsk_abc123": "a3f9d2c1b8e4f7a6d5c9e2b1" },
  "byObsidianId": { "m-1a2b3c4d": "a3f9d2c1b8e4f7a6d5c9e2b1" }
}
```

### Field guide (current fields only)

| Field | Who writes it | Purpose |
|---|---|---|
| `version` | seed / migration | Schema version. Bump on breaking change. v3 is post-Notion-drop. |
| `tasks.<h>.hash` | W1 | Stable identity hash (see below). |
| `tasks.<h>.sourceFile` | W1 / W2 | Path of the area file that owns this task. |
| `tasks.<h>.text` | W1 / W2 | Plain task text, emoji + tokens stripped. |
| `tasks.<h>.completed` | W1 / W2 | Checkbox state. |
| `tasks.<h>.priority` / `priorityInt` | W1 | Task plugin emoji ladder, both string and int. |
| `tasks.<h>.due` / `scheduled` / `start` | W1 | `YYYY-MM-DD` or null. |
| `tasks.<h>.recurrence` | W1 | Raw recurrence string (e.g. `every week`). |
| `tasks.<h>.tags` | W1 | `#tag` array. |
| `tasks.<h>.morgenTaskId` | W1 | Morgen task ID. Null until W1 has created the task. |
| `tasks.<h>.morgenId` | W2 | Morgen calendar-event ID for time-blocked tasks (`cev_*`). Null if the task isn't on the calendar. |
| `tasks.<h>.morgenEtag` | W1 | Morgen `If-Match` etag, for 409 detection. |
| `tasks.<h>.obsidianId` | W1 | The 🆔 minted into the markdown line (`m-XXXXXXXX`). |
| `tasks.<h>.lastSyncedAt` / `lastSyncedHash` / `lastSyncedBy` | W1 / W2 | Last successful sync record. |
| `byMorgenId` / `byObsidianId` | W1 / W2 | Reverse indexes for O(1) lookup. |
| `notionPageId` | (legacy) | Always `null` post-cutover. Preserved as a field so v2-shape state files still parse. Migration drops the reverse index. |

### Lifecycle

1. **Create.** You add `- [ ] New task 📅 2026-06-01` to `TASKS-URGENT.md`. Daemon commits + pushes.
2. **W1 next tick.** Sees a task line with no 🆔, no entry in `byObsidianId`. Creates a Morgen task, mints `m-XXXXXXXX`, writes the line back to markdown with the new 🆔 + the new state entry, all in one `[bot:W1]` commit.
3. **Edit due date.** Daemon commits. Next W1 tick sees the same 🆔 with a different hash → `update` op against Morgen → updates `lastSyncedHash` in state.
4. **Tick complete in Morgen.** Next W2 tick sees `closed`, writes `- [x]` to the markdown line, commits with `[bot:W2]`.
5. **Sync-state corruption.** Delete `05-Tasks/.sync-state.json`, re-run `scripts/morgen-backfill.js`. The state rebuilds from markdown 🆔s + Morgen IDs. The markdown is canonical, so nothing is lost.

### "Append-only" — clarification

The state file is **not** literally append-only on disk; W1 and W2 rewrite it whole every commit. But the `tasks.<hash>.<field>` shape is **logically** append-only in two important ways:

- **Hash-keyed dedup.** Every entry is keyed by content hash, so re-runs are idempotent. Two W1 runs that see the same task produce the same key, not duplicates.
- **No deletes from active state.** Removed tasks (deleted from markdown) are dropped from `tasks` but their cross-app IDs land in a `tombstones` array W1 reads on the next run, so a re-appearance creates a brand-new Morgen task instead of half-resurrecting the old one.

That's the discipline the schema enforces — not file format, but the semantics of writes.

---

## The bot-prefix echo guard

Every git commit produced by automation has a known prefix. W1's first parsing step inspects each commit message in the incoming push diff. If **every** commit in the diff carries one of the prefixes below, W1 still re-reads `.sync-state.json` (in case W2 wrote new IDs) but **skips the Morgen write phase** entirely. This is the only thing standing between you and an infinite ping-pong loop.

| Prefix | Source |
|---|---|
| `[bot:W1]` | W1 itself (state-file writeback) |
| `[bot:W2]` | W2 (markdown writebacks) |
| `[bot:daemon]` | local daemon's `git commit` |
| `[bot:save]` | `/save` skill (vault-side) |
| `[bot:save --backfill]` | `/save --backfill` historical ingest |
| `[bot:wiki-add]` | `/wiki add` (concept ingest) |
| `[bot:wiki-heal]` | `/wiki heal` (link repair) |
| `[bot:wiki-fix]` | `/wiki` targeted repairs |
| `[bot:morning]` / `[bot:nightly]` / `[bot:weekly]` / `[bot:health]` | scheduled audit agents |
| `[bot:reconcile]` | post-import reconciliation |
| `[bot:import-claude]` / `[bot:import-notes]` | one-shot importers |
| `[bot:mogging-*]` | mogging-repo maintenance commits |
| `[bot:backfill]` | `scripts/morgen-backfill.js` |

If you write your own automation against the vault, **always** give it a `[bot:*]` prefix. Otherwise W1 will treat its commits as user edits and replay them through Morgen, often creating duplicates or undoing work.

A push that mixes bot-prefixed commits with non-prefixed commits is treated as **non-bot** — W1 runs the full Morgen sync. That's intentional: if a human edit slipped in alongside automation, we want it propagated.

---

## Hashing and task identity

Two identifiers do different jobs:

- **`🆔 m-XXXXXXXX`** — the **stable join key**. Lives on the markdown line. Once minted, it never changes, even if you rename the task or move it across files. This is the field the 2-way sync uses to keep the same task glued together across edits.
- **`hash`** — the **edit detector**. Recomputed every W1 run from `(sourceFile, text, priority, due, scheduled)`. If the hash changes, the task was edited. Completion state is tracked separately so closing a task doesn't look like a text edit.

Hash format: SHA-256 of the canonical fields, `::`-joined, truncated to 24 hex chars. 96 bits of collision resistance is fine for any single-user task backlog and short enough to eyeball in logs.

Why include `sourceFile` in the hash? So that the same text in `TASKS-URGENT.md` and `TASKS-LORECRAFT.md` counts as two distinct tasks. Why exclude line number? So you can re-order tasks within a file without churning state.

---

## Conflict resolution

Two-way sync still has a conflict story — just a smaller one than three-way.

1. If the markdown hash differs from `lastSyncedHash`, assume **the user edited markdown**. W1 propagates markdown to Morgen, overwriting any Morgen-side change in the same window.
2. If W2 polls and finds a Morgen change AND the markdown hasn't changed since the last sync → propagate Morgen → markdown.
3. If W2 polls and finds a Morgen change AND the markdown ALSO changed → markdown wins. W2 logs `conflict: markdown and morgen both changed for hash <h>; discarding remote change`.
4. On a tie (timestamps equal to the second), **Obsidian wins**. Deterministic.

What does NOT trigger an overwrite: a Morgen task's calendar position. Drag a task on the Morgen calendar and the time block stays put — the public Morgen API doesn't expose task-to-calendar promotion (only `cev_` calendar events round-trip via W2 direction 5/6).

---

## Tradeoffs

What this architecture is bad at:

- **Latency floor = 20 minutes.** The orchestrator fires every 20 min. There is no real-time path. If you tick a task off in Morgen at 12:01, expect markdown to catch up between 12:20 and 12:21.
- **Single tenant.** Built for one user, one vault, one Morgen account. The `.sync-state.json` schema and the rate-budget assumptions both fall apart at multi-user scale.
- **n8n cloud dependency.** If your n8n instance is down, the sync is down. There is no Morgen-side queue. Self-hosting n8n on your own VPS removes the vendor risk but adds operational cost.
- **Morgen rate limit ceiling.** 300 points / 15 min. A backfill that touches 300+ tasks will blow the budget; pre-stage with `scripts/morgen-backfill.js`, which paces itself.
- **Inbox-only.** Morgen's API doesn't yet let us create or reorder task lists, so everything lands in `inbox`.
- **macOS-only daemon.** `launchd` plist + Full Disk Access. Linux users need to port the daemon to systemd; Windows users to a Service. Two-line port, but a port.
- **Calendar promotion is one-way (Morgen UI only).** No API to drag a task onto the calendar from the markdown side. Use Morgen's auto-scheduler, or drag manually.
- **No diffable git history of Morgen state.** Only the markdown side is in git. If something goes wrong inside Morgen, your only history is Morgen's own audit log.

These are deliberate. The kit is opinionated toward "your data stays in markdown, the calendar is the disposable mirror." If you need real-time, multi-user, or Morgen-canonical, this isn't the kit.

---

## What changed in May 2026 (Notion drop)

This kit was originally a **3-way Obsidian ↔ Notion ↔ Morgen** sync. On 2026-05-04, Notion was dropped:

- **Why.** The Notion side had been silently 401-failing for an unknown duration (token rotation issue, surfaced when nothing actually worked end-to-end). The maintainer also stopped using the Notion task DB as a daily driver, so the rebuild wasn't worth the engineering. The 2-way Obsidian ↔ Morgen path was the actually-used path.
- **What was removed.**
  - W3 (Notion → Obsidian) workflow — converted to a no-op stub returning `{ok:true, skipped:'notion-dropped-2026-05-04'}`. Not in the orchestrator graph anymore.
  - All `POST /v1/databases/*` and `PATCH /v1/pages/*` calls inside W1.
  - `notionPageId` reverse index in `.sync-state.json`. The field is preserved on each task entry as `null` so v2-shape state files still parse, but nothing reads or writes it.
  - The Notion DB schema and "Area select must be pre-populated" requirement.
- **What stayed identical.**
  - Markdown grammar.
  - W1 / W2 contract (Morgen side only).
  - The bot-prefix echo guard.
  - The local daemon.
  - The hash strategy and `.sync-state.json` lifecycle.

### If you're upgrading from the 3-way version

If you were running the kit before 2026-05-04, the migration is three steps:

1. **Stop W0** (and W3, if you ever activated it directly). Disable the schedule trigger in n8n so nothing fires while you migrate.
2. **Reimport workflows.** Re-run `scripts/install-workflows.sh` from a fresh clone of the repo. The installer ships the post-cutover W1 and W2 (no Notion calls), the W0 sequencer, and the watchdog.
3. **Restart W0.** Activate `W0-Sync-Orchestrator`. Leave W1, W2, and the watchdog inactive in the UI — they're called by W0, the watchdog runs on its own internal schedule.

Your `.sync-state.json` does NOT need to be regenerated. The new W1 reads v2 state files fine; `notionPageId` is just ignored from now on. If you'd rather drop the dead field, run `scripts/validate-sync-state.js --strip-legacy` and commit the result with `[bot:wiki-fix] drop legacy notionPageId`.

---

## Next

- Walk through [SETUP.md](SETUP.md) to get a working install.
- If you hit something weird, [TROUBLESHOOTING.md](TROUBLESHOOTING.md) covers the failure modes seen in real runs.
- To modify the workflows or add fields, see [CONTRIBUTING.md](CONTRIBUTING.md).

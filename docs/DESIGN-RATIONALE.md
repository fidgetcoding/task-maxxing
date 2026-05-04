# Design Rationale

> Why task-maxxing is shaped the way it is. This is the doc for the
> person about to fork the kit and change something — not "how do I run
> it" (that's [SETUP.md](SETUP.md)) and not "what does this field do"
> (that's [ARCHITECTURE.md](ARCHITECTURE.md)). Here we cover decisions:
> the constraint, what we tried, why the chosen path won, and what
> you'd give up if you swapped it out.

The kit is **two-way Obsidian ↔ Morgen** as of May 2026. Notion was
dropped (see §9). If you came here from an older copy that mentioned a
W3 worker, that's gone — the orchestrator now runs `Every 20m → W2 → W1`
and that's the whole sync.

---

## Table of contents

1. [Why this doc exists](#1-why-this-doc-exists)
2. [Constraint set](#2-constraint-set)
3. [Why polling, not webhooks](#3-why-polling-not-webhooks)
4. [Why Obsidian is the source of truth](#4-why-obsidian-is-the-source-of-truth)
5. [Why hash-keyed sync state](#5-why-hash-keyed-sync-state)
6. [Why `m-XXXXXXXX` over UUIDv4](#6-why-m-xxxxxxxx-over-uuidv4)
7. [Why bot-prefix echo guard](#7-why-bot-prefix-echo-guard)
8. [Why the orchestrator (W0) sequences W2 then W1](#8-why-the-orchestrator-w0-sequences-w2-then-w1)
9. [Why we dropped Notion (May 2026)](#9-why-we-dropped-notion-may-2026)
10. [What this is bad at](#10-what-this-is-bad-at)
11. [Decisions deferred / left open](#11-decisions-deferred--left-open)

---

## 1. Why this doc exists

[ARCHITECTURE.md](ARCHITECTURE.md) tells you what the system does.
[SETUP.md](SETUP.md) tells you how to install it. This doc tells you
which rocks are load-bearing — so when you fork the kit and start
ripping things out, you know which ones will collapse the building.

---

## 2. Constraint set

Every decision below is shaped by the same six constraints. If your
fork's constraints differ, the answers will differ:

- **Free-tier-friendly.** This is a personal-scale tool. n8n cloud
  Starter ($20/mo), Morgen Pro (~$15/mo), GitHub free tier. No paid
  database, no paid queue, no paid observability stack.
- **No always-on server.** No VPS to patch, no Docker host to babysit,
  no inbound port to expose. Everything runs on hosted cron and
  hosted git.
- **Obsidian is the source of truth.** Markdown-in-git is the home
  state; everything else is a projection that has to be reconcilable
  from those files alone.
- **One-person ops.** A single human reads the n8n execution logs and
  fixes things when they break. The system has to fail loud, not
  silently corrupt.
- **Calendar must show real-time-ish.** "Did my task make it to my
  calendar?" should be answerable in minutes, not hours. The user
  schedules their day from Morgen.
- **IDs round-trip and deletes propagate.** A task created in Morgen
  must be findable from Obsidian on the next sync, and a task deleted
  in Obsidian must come out of Morgen — without manual cleanup.

Hold these in mind through the rest of the doc. Most of the surprising
choices are surprising because one of these constraints excluded the
"obvious" answer.

---

## 3. Why polling, not webhooks

The system polls every 20 minutes. It does not subscribe to webhooks
on either side. That's a deliberate choice with three pieces:

**GitHub webhooks would need a public endpoint.** A webhook from
GitHub means GitHub needs an HTTPS URL to POST to. n8n cloud does
expose webhook URLs, and we used them in earlier drafts. The reason
we backed off: webhook-driven sync makes the latency floor jittery
(0–N seconds depending on GitHub's delivery queue and n8n's cold
start) but doesn't actually buy real-time, because the *other* side
of the sync (Morgen) has no usable push events anyway. So the user
sees inconsistent latencies — sometimes a sync happens in 5 seconds,
sometimes it waits for the next poll — without ever being truly
push-driven end to end. Polling at a fixed interval is more
predictable than mixing pull and push.

**Morgen had no webhooks when this shipped.** Morgen's API exposes
list/create/update/close. There was no `POST your-server-here on
task change` mechanism. So one side of the sync had to poll
regardless. Once one side polls, the other side polling is "free"
(same n8n schedule trigger, same execution budget) and removes the
public-endpoint requirement.

**20 minutes is the rate budget, not the user's preference.** Morgen's
API is gated at 300 points per 15 minutes (raised from 100 on
2026-04-15), where `list_tasks` costs 10 points and writes cost 1
each. n8n cloud Starter caps at 5,000 workflow executions/month;
running W2 + W1 every 20 minutes is `2 × 24 × 30 ≈ 1,440 executions`,
well inside the cap. Going to 10 minutes nearly doubles that and
starts pinching the rate budget on busy days. Going to 60 minutes
makes the calendar feel laggy. 20 minutes is the lowest-pain point
on both axes.

**What you'd give up to switch.** A real-time fork would need (a) a
public webhook endpoint for the GitHub push event, (b) a polling
loop for Morgen anyway, (c) deduplication when the webhook and the
poll see the same change. That's strictly more code and more failure
modes. If your fork has actual real-time requirements (e.g. a team
where someone watches the calendar update live), it might be worth
it. For one user, it's not.

---

## 4. Why Obsidian is the source of truth

Every other architectural choice flows from this one. If you fork and
flip this — say, make Morgen canonical, and Obsidian a projection —
most of the rest of this doc stops being true.

The reasons Obsidian wins:

**Plain text in git is debuggable in a way an API isn't.** When the
sync misbehaves, the first question is "what does the source say?"
For Obsidian that's `cat 06-Tasks/TASKS-URGENT.md`. For Morgen that's
an authenticated API call from a machine with the right token, hoping
the response isn't paginated. `git log -S "ship the kit"
06-Tasks/TASKS-URGENT.md` answers six months of "when did this task
appear?" questions in one shell command.

**Bulk edits are trivial.** Renaming a project from `LORECRAFT-HQ` to
`LORECRAFT`? `sed -i` across the task files, commit, push, sync
catches up. Doing the same against a SaaS API means writing a
backfill script, dealing with pagination, and praying the rate limit
holds. Text files are the cheapest schema-migration platform on
Earth.

**The user is single-writer at the source.** Obsidian vaults are
single-user by default. There is no race on the Obsidian side: the
only writers are the user typing and the sync workflow committing.
Both serialize through the git commit log. You don't need CRDTs or
vector clocks because there's nothing to merge.

**Morgen is a great calendar and a bad database.** Morgen's data
model is calendar-first; tasks were added later and are less
structured. Tags are UUIDs (you can't type `#urgent` and have it
mean anything until you look up the UUID). There's no text-based
export, no `git diff`, no `grep`. It's a fantastic projection target
— "tasks become time" is its whole value prop — but it's not where
you want to keep authoritative state.

**Morgen is the presentation layer.** Tasks live in Obsidian; Morgen
is how they show up on the calendar. When the two disagree, Obsidian
wins by definition. W2's job is to take "user marked done in Morgen"
and write it back to the markdown — not to negotiate a merge.

**What you'd give up to switch.** A Morgen-canonical fork could lean
on Morgen's auto-scheduling and skip a layer. But you'd lose the
git audit trail, the ability to fly-mode-edit a task list and push
later, the bulk-edit ergonomics, and the offline story. It's the
wrong trade for a personal knowledge system. It might be the right
trade for a team where everyone lives in the calendar.

---

## 5. Why hash-keyed sync state

`sync-state.json` keys entries by a content hash, not by line number,
file offset, or insertion order. This matters because a markdown file
is a moving target: lines get reordered, sections get split, blank
lines get added. A line-indexed scheme would shred its own state on
the first reorder.

The hash takes the load-bearing fields — source file, task text,
priority, due date, scheduled date — runs them through SHA-256, and
slices the first 24 hex chars. That's 96 bits of collision resistance,
which is fine for a backlog under ten thousand tasks. (Birthday bound
at 96 bits: ~2⁴⁸ inputs before collision is even probable. We are
nowhere near that.)

Three properties fall out for free:

- **Reordering is a no-op.** Move a task from line 5 to line 50 in the
  same file: same hash, no sync, no Morgen churn.
- **Edits are detected without timestamps.** If the user changes the
  due date, the hash changes, the lookup misses, the new entry takes
  the create branch (and the orphaned old entry takes the archive
  branch on the same run). No need for "lastEditedAt" fields, which
  Obsidian doesn't surface anyway.
- **Same text in two files = two tasks.** `sourceFile` is part of the
  hash input. Moving "ship the kit" from `TASKS-URGENT.md` to
  `TASKS-LORECRAFT.md` reads as `archive + create`, which routes the
  task into the right Morgen tag without any special-case logic.

Completion state is **not** in the hash. Marking `- [ ]` → `- [x]`
keeps the same identity, which is what we want — completing a task
shouldn't look like "edit the task text" to the diff engine.

**What you'd give up to switch.** A row-ID-keyed scheme (using
Morgen's task ID as the primary key) would simplify the close path,
but you'd lose the "edit on the Obsidian side without a round-trip"
property and you'd need a separate scheme for tasks that haven't been
created in Morgen yet. The hash is upstream of every sync operation,
which is what makes it work.

---

## 6. Why `m-XXXXXXXX` over UUIDv4

Tasks carry a stable user-visible ID in the markdown: `🆔 m-3a9f1c2e`.
Eight hex chars, prefixed with `m-`. Picked over UUIDv4 for one
specific reason:

**Morgen mints these IDs server-side.** When you POST to
`/v3/tasks/create`, Morgen returns an 8-char ID and you're stuck with
it — that ID is what every subsequent `update`, `close`, and `list`
call references. So one of the two systems is going to mint the ID,
and the other is going to follow.

We can either:

1. Have Obsidian mint a UUIDv4, send it to Morgen on create, and store
   the mapping `uuidv4 → morgenId` in sync state. Now every read path
   needs the mapping table to translate.
2. Take Morgen's ID, write it back into the markdown line, and let it
   be the canonical reference everywhere.

Option 2 wins because the ID written into the markdown line is the
ID you'll use for every future API call. There's no translation
layer. `git grep m-3a9f1c2e` answers "is this task in the vault?"
and `curl morgen.so/v3/tasks/m-3a9f1c2e` answers "is this task in
Morgen?" — same string, both places.

The `m-` prefix is cosmetic but load-bearing: the n8n W1 parser
matches `m-[0-9a-f]{8}` exactly. UUIDv4s embedded in 🆔 tokens (which
predate this scheme) silently fail to parse — they're not picked up
by W1, which means tasks created with them sit stranded in Obsidian
without ever reaching Morgen. That failure mode bit hard once
(LAVA-NET, May 2026, six invoice tasks stranded for hours) and is
the reason `/maketasks` enforces the format.

**What you'd give up to switch.** A client-minted UUIDv4 scheme would
let Obsidian generate the ID before any API call, which would matter
if you wanted the system to work fully offline. As of today, "Morgen
mints, we mirror" wins on ergonomics and grep-ability. If your fork
swaps Morgen for a backend that doesn't mint IDs, you'll have to
rebuild the parser side too.

---

## 7. Why bot-prefix echo guard

Every commit produced by a sync workflow starts with `[bot:W1]` or
`[bot:W2]` (and `[bot:daemon]` for the local commit-and-push helper).
The W1 webhook path checks `commits[].message` on incoming pushes; if
every commit in the push is bot-prefixed, W1 skips the Morgen write
phase. That single check is what prevents the loop:

```
W2 commits markdown → push → W1 fires → W1 writes Morgen →
Morgen state changes → W2 reads it → W2 commits markdown → …
```

Without the guard, a single completion event ping-pongs forever.

We picked commit-message prefixing over the alternatives:

**Timestamp-based dedup** (skip writes if the last sync was within N
seconds) is fragile — sync runs aren't atomic, retries happen, and
"how recent is too recent" is a magic number that's wrong on bad
days.

**Content-hash dedup** (skip if the incoming state hashes to the same
thing as the last-synced state) sounds principled but mishandles
legitimate edits that happen to round-trip identically — e.g. a user
typo'd a title, then fixed it, and the hash hops back to where it
was. We'd skip the second edit.

**Commit-message prefixing** is in-band, requires zero state, and
fails in the obvious direction: if a human accidentally types
`[bot:W1]` in a manual commit message, their edit gets ignored.
That's recoverable (rename the commit, force-push, or just edit the
file again without the prefix). The other failure modes bite worse.

**What you'd give up to switch.** None of the alternatives have a
better failure model for the personal-scale use case. If you fork to
multi-writer and you can't trust commit messages, you'd want a
separate sync-control branch or a metadata file — but that's a much
bigger change than swapping the guard.

---

## 8. Why the orchestrator (W0) sequences W2 then W1

W0 is a thin n8n workflow with a 20-minute schedule trigger and two
nodes: `executeWorkflow(W2)`, then `executeWorkflow(W1)`. They run
in series, not in parallel.

Sequencing matters because of one specific race:

> User creates a task in Morgen at 14:01. User opens Obsidian at
> 14:05 and edits a different task in the same file. Both changes
> need to land in the canonical state.

If W1 and W2 fire in parallel at 14:20:

- **W2** reads Morgen, sees the new task, writes it into the markdown,
  commits.
- **W1** reads the GitHub state from 14:00 (before W2's commit), sees
  the user's manual edit, writes it to Morgen, and commits the
  sync-state without W2's new task.

The next push after both finish merges fine, but the sync-state
written by W1 has clobbered the row W2 just minted. Worst case, you
get a "ghost" task in Morgen that doesn't exist in sync-state and a
real task in Obsidian whose `morgenId` is null.

Sequencing W2 → W1 closes the window:

- **W2** runs first, pulls Morgen state, writes new tasks into
  markdown, updates sync-state, commits, pushes.
- **W1** runs second, pulls the *fresh* GitHub state (which now
  includes W2's commit), and reconciles. The user's manual edit and
  W2's mint are both in the same input set; W1 dispatches both
  correctly.

The order matters: Morgen → Obsidian → Morgen makes the markdown the
last word every cycle, which is what "Obsidian is the source of
truth" actually requires in practice. Reversing it (W1 then W2) would
mean W2 overwrites W1's freshly-written sync-state; same race, opposite
direction.

**What you'd give up to switch.** Parallel execution would shave a
few seconds off each cycle (W2 and W1 each take 5–15s; sequencing
adds the smaller of the two to total latency). Not worth the race
window. If your fork has a workflow engine that can express "run
these two with a shared snapshot," you might recover both, but n8n
doesn't.

---

## 9. Why we dropped Notion (May 2026)

This is an ADR-style entry because it's the most recent live decision
and the one most likely to confuse forkers reading the historical
commits.

### Problem

The kit shipped with three-way sync: Obsidian ↔ Notion ↔ Morgen,
where Notion served as a shareable view (a teammate could tick a
checkbox in a Notion database and have it round-trip into Obsidian).
On 2026-05-04, six task creations from `/maketasks` failed to appear
on the calendar. Investigation showed W1 was silently 401-failing on
a revoked Notion bearer token *before* reaching the Morgen mint
loop, so nothing downstream of the Notion call ever ran. The Notion
side had been broken for an unknown number of weeks. The user hadn't
noticed because they'd stopped opening Notion.

### Alternatives considered

1. **Rotate the Notion token, keep the three-way sync.** Restores
   functionality but reinstates the surface area: a token to monitor,
   a third API to cover when the rate budget is tight, a third
   conflict-resolution branch in W1.
2. **Wrap Notion calls in `try/catch` with a `notionAvailable`
   degradation flag.** Isolates the failure so a dead Notion can't
   block the Morgen path. Doesn't fix the deeper problem (Notion
   wasn't being used).
3. **Drop Notion entirely.** Fewer secrets, fewer API surfaces,
   simpler workflows, no shareable view.

### Decision

Option 3. Notion was archived (DB exported to disk, then PATCHed
`archived: true` via API; recoverable from Notion's trash for ~30
days). W1's Code node was renamed `Parse + Upsert Notion DB` → `Parse
+ Sync to Morgen` and the Notion API calls were stripped. W3 (Notion
→ Obsidian) was reduced to a no-op stub returning `{ok: true,
skipped: 'notion-dropped-2026-05-04'}` and removed from the
orchestrator graph (`Every 20m → W2 → W1` now, no W3). The orchestrator
and the W1 Code node were patched via `mcp__n8n__update_workflow`
without re-importing the workflow JSONs.

`sync-state.json` retained the `notionPageId` field on existing
entries because clearing it would require a one-shot migration and
the field is functionally inert (no live workflow reads or writes
it). New entries created post-cutover have `notionPageId: null`.
That's intentional rot — the field is allowed to age out naturally
rather than be force-migrated.

### Consequences

**Wins.**

- One fewer secret to rotate and one fewer rate budget to share.
- W1 went from ~52KB Code node to ~34KB; the dropped logic was the
  most error-prone reconciliation branch.
- First clean orchestrator run post-cutover (execution 11186, 16:26
  UTC) completed in seconds with zero `morgen_errors` and zero
  `writeback_errors` — first such run in possibly weeks.
- The "shareable view" use case turned out to be vestigial; the user
  had stopped sharing.

**Losses.**

- Collaborators who want to see the task list now need a different
  surface (Morgen sharing, an exported markdown file, or nothing).
  No equivalent built into the kit.
- A user who *did* rely on Notion for collaboration would need to
  fork and re-add the Notion path. The historical W3 worker is in
  git history if you need a starting point.

**Lessons that shaped the rest of this doc.**

- *Alerting > recovery.* The Notion path failed silently for weeks.
  A health watchdog (§10) is now mandatory: every hour, check that
  a `[bot:W1]` commit has landed in the last 60 minutes; if not,
  open a GitHub issue and (optionally) ping Telegram. Cheap to
  build, would have caught this in days instead of weeks.
- *Less surface area > more.* Each external system adds a token, a
  rate budget, a parse path, and a way to fail. The cost is paid
  per-poll, forever. If a system isn't carrying its weight, drop it.
- *Wrap external calls in `try/catch` with degradation flags* even
  when you're sure the call will succeed. The cost is one
  conditional; the benefit is that one dead dependency doesn't
  silently break the rest of the pipeline.

---

## 10. What this is bad at

Read this section through a "would I fork this?" lens. These are the
constraints the chosen design imposes on the user, not bugs.

**20-minute latency floor.** Every sync direction is gated by the
orchestrator's poll interval. A task added to Obsidian shows up on
the Morgen calendar within 0–20 minutes. A task completed in Morgen
flips to `- [x]` in Obsidian within 0–20 minutes. There is no
"sync now" button; the workflow is hosted, not local. If you need
sub-minute round-trips, this kit is the wrong starting point.

**Single-tenant n8n cloud bill.** $20/mo Starter tier is enough for
one user with two workflows on a 20-minute cron. A second user
sharing the same n8n instance is fine. Ten users sharing it will
blow through the execution budget; you'd want self-hosted n8n by
that point, which adds infra burden the kit was specifically
designed to avoid.

**Morgen API rate ceiling.** 300 points per 15 minutes is plenty for
steady-state (a few writes per poll) and tight for backfill
(creating 200 tasks at 1 point each plus list calls at 10 points
each fits in one window with no other callers). The kit's
`scripts/morgen-backfill.js` exists specifically to handle the
first-time-import case outside the W1 hot path. If your usage
pattern has bursty creates (an LLM agent generating 50 tasks at
once, say), you'll hit the ceiling and have to throttle.

**No offline mode.** The user can edit Obsidian offline, but the
sync to Morgen is gated on n8n cloud running and reaching both
GitHub and Morgen. If GitHub is down, the daemon's push fails. If
n8n cloud is down, no sync runs. If Morgen is down, W1 errors. The
recovery model is "the next poll catches up" — which is fine for
hours of outage, awkward for days.

**No collaborative writes.** §4's "single-writer at the source" is
the property that lets the rest of the kit be simple. A team of
five editing the same Obsidian vault would need a real concurrency
story (CRDTs, locking, a central server). None of those compose
cleanly with `git` as the transport. If your fork goes
collaborative, expect to revisit §4, §5, and §8 simultaneously.

**Watchdog is "nice to have" not "built in."** The kit ships with
the *idea* of an hourly health check that confirms a `[bot:W1]`
commit landed in the last 60 minutes — open a GitHub issue if not,
optionally ping Telegram. The Notion-drop incident (§9) is the
reason this exists. It's a small workflow you wire up yourself; the
kit doesn't auto-provision it because it'd require committing an
opinion about your alert channel.

---

## 11. Decisions deferred / left open

These are the rocks left deliberately fuzzy. If your fork wants to
nail one down, this is where to start.

**Pagination on `/v3/tasks/list`.** Morgen's API returns the full
task set today, but doesn't promise a non-paginated response in
docs. If your vault grows past whatever Morgen's current implicit
page size is, W2 will silently miss tasks. Worth probing if you
push past a few hundred tasks.

**Task-to-calendar pinning.** Morgen's UI lets you drag a task onto
a specific calendar slot. The API doesn't expose this. The kit
treats pinning as a human-only operation and lets Morgen's
auto-scheduler decide times. If a Morgen API for pinning ships,
W2 could surface pinned slots back into a markdown comment, but
the storage shape ("pinned-at" emoji?) isn't decided.

**Multi-area task moves.** Moving a task from `TASKS-URGENT.md` to
`TASKS-LORECRAFT.md` reads as `archive + create` because
`sourceFile` is in the hash. The new Morgen task gets a new ID;
the user-visible `m-XXXXXXXX` token in the markdown line changes
on rewrite. That's fine for now but means a task's history is
discontinuous across moves. A future scheme could preserve the ID
across moves and instead diff `sourceFile` separately. We didn't
build it because the move case is rare and the discontinuity
hasn't bitten yet.

**Watchdog opinionation.** §10's hourly check is described but not
shipped as a workflow file. It's deliberately left as a recipe so
forks can pick their alert channel (issue, Telegram, email,
PagerDuty). Once the kit's user base picks a default, it'll get
shipped as a fourth workflow.

**Tag-scheme migration.** During the Notion era we ran two parallel
Morgen tag schemes (`Lava-Network` bare-label vs `09 LAVA-NETWORK`
Notion-prefixed). The post-cutover state still uses the prefixed
form because W2's `notionLabelToAreaKey` routes by it; switching
to bare labels is a one-shot migration we haven't run. New forks
can pick either; existing installs should leave the prefixed form
alone until somebody writes the migration.

---

_If you came here to disagree with a decision, please cite the
section and the trade it makes. The dialog starts from shared
context — that's the whole reason this file is in the repo._

# Design Rationale

> Why task-maxxing is shaped the way it is. This document is for the person
> who's about to fork the repo and is thinking "wait, why did they do it
> _that_ way?" It's also for the person (possibly us, six months from now)
> who's about to change something and wants to understand which rocks are
> load-bearing and which are cosmetic.
>
> Rules of thumb: read this BEFORE you touch the workflow JSON. Read it
> TWICE before you touch `sync-helpers.js`. If a decision below feels
> surprising, it's because the surprising answer is the correct one — the
> obvious answer was tried first and failed.

---

## Table of contents

1. [Why bidirectional sync is hard](#1-why-bidirectional-sync-is-hard)
2. [Why Obsidian is the source of truth](#2-why-obsidian-is-the-source-of-truth)
3. [Why Morgen for scheduling](#3-why-morgen-for-scheduling)
4. [Why Notion for collaboration](#4-why-notion-for-collaboration)
5. [Why n8n for orchestration](#5-why-n8n-for-orchestration)
6. [Why hash-based upsert](#6-why-hash-based-upsert)
7. [Why `SHA256::slice(0,24)`](#7-why-sha256slice024)
8. [Conflict resolution: last-writer-wins + Obsidian tiebreaker](#8-conflict-resolution-last-writer-wins--obsidian-tiebreaker)
9. [Safety rails](#9-safety-rails)
10. [Morgen API quirks that shaped the design](#10-morgen-api-quirks-that-shaped-the-design)
11. [n8n Code node constraints that shaped the design](#11-n8n-code-node-constraints-that-shaped-the-design)
12. [Alternatives considered](#12-alternatives-considered)
13. [Trade-offs made](#13-trade-offs-made)
14. [Known anti-patterns we explicitly chose](#14-known-anti-patterns-we-explicitly-chose)
15. [Future work](#15-future-work)

---

## 1. Why bidirectional sync is hard

Bidirectional sync between three systems that do not share a clock, a
database, or a notion of "transactions" is a problem with a famous shape.
If you have ever tried to sync two contact books over the network, or
rsync an email inbox across machines that you edit on both, you already
know what's coming.

### 1.1 The split-brain problem

Imagine the simplest possible setup: Obsidian has a task. Notion has the
same task. A user ticks it done in Notion while, simultaneously, another
user edits its due date in Obsidian. When both sides next talk to each
other, what's the final state?

There are only three honest answers:

1. **One side wins, totally.** The other side's change is thrown away.
2. **Both sides win, additively.** The task is both "done" AND "due next
   Tuesday." This only works if the fields are orthogonal.
3. **Merge at the field level.** The library makes a choice per field —
   "done" wins over "not done," "later date" wins over "earlier date,"
   etc.

Option 3 is what humans do when they resolve a Google Docs conflict by
hand. It is also what CRDTs try to do automatically. It's the "right"
answer and it's also the most expensive to build, because it requires
structural merging semantics that three independent SaaS products do not
share.

task-maxxing picks a flavor of option 1 with a very specific tiebreaker:
**last writer wins, but Obsidian is always a writer**. More on that in
§8. For now, the important idea is that we deliberately do NOT try to do
a field-level merge across Notion and Morgen, because neither product
exposes the per-field timestamps you would need.

### 1.2 Idempotency

Every sync system that polls has the same question: "is this the first
time I'm seeing this event, or the tenth?" If the answer is "tenth" and
you re-fire the side effect, you've duplicated a row / fired a webhook
twice / charged a card twice.

Idempotency means: **the operation can be run N times and the result is
indistinguishable from running it once.** In task-maxxing that
translates to three concrete rules:

- `createNotionRow(hash)` is a no-op if a row with `hash` already exists.
- `createMorgenTask(hash)` is a no-op if a task mapped to `hash` already
  exists in sync-state.
- `closeTask(hash)` is a no-op if the target is already closed.

We get (a) and (b) for free as long as our primary key is derived from
the content, not assigned by the destination. That's the single biggest
reason the primary key is a hash — see §6.

### 1.3 Drift detection

Drift is what happens when the state-of-the-world diverges from the
state-of-the-mapping-table and nobody notices. task-maxxing has three
places drift can originate:

- **Obsidian** — user edits the markdown line by hand. The hash changes.
  The new hash has no mapping. The old hash still points to a row that
  no longer has a corresponding Obsidian task. That's an archive event.
- **Notion** — user edits the Notion row's title/priority/date. The row
  ID is stable but the hash of the mirrored Obsidian line is stale.
- **Morgen** — user drags the task to a new time or marks it done. The
  Morgen task ID is stable but the completion / scheduled-at fields
  change underneath us.

In every case, the recovery strategy is: **recompute the hash from the
upstream content, look it up in `sync-state.entries`, and reconcile.**
The mapping table is the single source of causality. Losing it means
losing the ability to tell "this is a new task" apart from "this is an
existing task whose text I just changed."

That is also why `.sync-state.json` lives in the same git repo as the
task markdown. If you accidentally delete it, `git checkout HEAD --` gets
it back. If you accidentally corrupt it, git blame tells you which run
did it.

### 1.4 Why three-way is worse than two-way

Two-way sync is hard. Three-way sync is not 50% harder — it is roughly
3x harder, because the number of pairwise reconciliation paths grows
combinatorially:

| Systems | Pairs | Consistency windows |
|---------|-------|---------------------|
| 2       | 1     | 1                   |
| 3       | 3     | 3                   |
| 4       | 6     | 6                   |
| N       | N(N-1)/2 | N(N-1)/2         |

For task-maxxing we deliberately limit the pairwise paths: Obsidian
talks to both (W1), Morgen talks back to Obsidian+Notion (W2), Notion
talks back to Obsidian+Morgen (W3). But we never do Notion↔Morgen
directly — every Notion→Morgen edit flows through Obsidian first. That
reduces the graph from K3 to a star rooted at Obsidian, which is what
lets §8's simple tiebreaker rule work.

---

## 2. Why Obsidian is the source of truth

This is the single most important architectural decision in the system,
and almost every other decision on this page is a consequence of it.

### 2.1 The properties we wanted in a source of truth

- **Plain text.** We wanted to be able to `git diff` a sync. We wanted
  `grep` to work. We wanted `sed` to work. We wanted any future agent
  to be able to reason about the state of the world with a text editor
  and no API key.
- **Single-user semantics.** Obsidian vaults are single-user by
  default. That means there's no race on the Obsidian side — the only
  writers are (a) the user typing in Obsidian, and (b) the sync
  workflows committing via git. Both are serialized by the git commit
  log.
- **Version control friendly.** Markdown + git = every sync produces a
  commit, every commit has an author and a message, every decision is
  auditable. If we wanted to know "why did this task get marked done at
  17:54 UTC on Tuesday," `git log -p 08-Tasks/TASKS-URGENT.md` answers
  it in one shell command.
- **User-editable without the sync running.** The user can fly on an
  airplane, open Obsidian, add 10 tasks to `TASKS-URGENT.md`, close the
  laptop, land, and push. The sync picks up all 10 on the next webhook
  fire. No custom app, no offline queue, no sync engine in the client.
  Just files.
- **Obsidian Tasks plugin.** Nathan uses Clare Macrae's Obsidian Tasks
  plugin, which has a well-defined line format (emoji markers for due
  date, priority, recurrence, start date, etc.). That format is
  stable, documented, and deterministic to parse. We're parasitizing a
  line syntax that was designed to be machine-readable.

### 2.2 Why not Notion as source of truth

Notion was our first instinct. It's a database with a decent API, it
has collaborators, it has views. Why didn't we pick it?

- **The Notion API's rate limit is hostile to source-of-truth
  operations.** 3 requests/second sustained, with bursts punished.
  Walking 60 tasks to reconcile state means 60+ GETs, which takes ~20
  seconds before you've done anything useful. If the source of truth
  lives in a place that's slow to walk, every sync gets painful.
- **Notion has no stable concept of "row order."** Ordering lives in
  views, not rows. If you want an ordered todo list, Notion makes you
  manage `rank` columns by hand. Obsidian solves this for free:
  physical position in the file IS the order.
- **Notion pages have opaque block IDs.** Every checkbox, every text
  block, every callout, has a UUID. Diffing two versions of the same
  page means diffing two block trees, not two strings. That's strictly
  harder.
- **Notion's atomic write unit is a page.** If you want to update one
  property, you PATCH the whole page. That's fine for small tasks but
  it means conflict windows are page-scoped, not field-scoped. A dumb
  write can clobber a smart one.
- **Notion databases are per-workspace.** If Nathan wants to collaborate
  with a teammate on a subset of tasks, the natural move is to share one
  Notion database. But he does NOT want to share his full Obsidian
  vault. The model needs to accommodate "one Obsidian, many Notion
  projections" — which works iff Obsidian is upstream.

### 2.3 Why not Morgen as source of truth

Morgen is a great calendar. It is a very bad source of truth:

- **No text-based export.** The only way to read a Morgen task is the
  API.
- **Tasks are second-class to events.** Morgen's data model is
  calendar-first; tasks were added later and are less structured.
- **Tags are UUIDs, not strings.** You cannot type "#urgent" in Morgen
  and have it mean the same thing as "#urgent" in Obsidian. You have to
  look up a tag UUID.
- **No file equivalent.** Morgen's raison d'être is that it
  auto-schedules tasks into free calendar slots. That is a useful
  _output_ of a task manager, not a useful _storage layer_.

### 2.4 Why Obsidian's single-user-ness is a feature, not a bug

Most task sync projects fail because they try to be collaborative from
day one, which forces them to confront CRDTs or operational transforms
or a central server. task-maxxing sidesteps this entire class of
problem by being unapologetically single-user at the source. The user
collaborates by PROJECTING the single-user source into collaborative
spaces (a Notion database their teammate can see; a Morgen calendar
their assistant can drag-and-drop). Every downstream copy is a view —
and in classic database terms, views are not supposed to be the
primary write site.

When a downstream view DOES get written to (someone ticks a Notion
checkbox, someone drags a Morgen task to a new time), the sync
workflow's job is to propagate that change back to the source and then
re-emit to all the other views. This is the same shape as "materialized
views" in Postgres, and it works for the same reasons.

---

## 3. Why Morgen for scheduling

Morgen is where tasks become time. That sentence is the entire value
prop, and it's why task-maxxing specifically cares about Morgen rather
than "any task app."

### 3.1 The auto-schedule property

A task in Morgen has a duration. When you give Morgen a task with a
duration and no specific start time, it drops it into the first
available slot on your calendar that fits. That means the user types

    - [ ] Write blog post ⏫ 📅 2026-04-20

in Obsidian, and Morgen arranges for "Write blog post" to block off
40 minutes at 10am on Wednesday, visible on the calendar, alongside
real meetings. That integration — "unscheduled intent" → "scheduled
time" — is what Motion, Reclaim, and Morgen all exist to provide.

Morgen is the one we picked because:

- The API lets us write tasks directly, including priority and duration.
- Tasks and events coexist in one UI; the user doesn't have to context-
  switch.
- Pricing is per-user-per-month, not per-task. A sync that writes 60
  tasks per poll doesn't get throttled out of the free tier.
- The underlying data model is transparent: you can list tasks, list
  events, and reason about them with separate API calls.

### 3.2 What task-maxxing does NOT ask Morgen to do

This is almost as important as what we DO ask. We deliberately do NOT:

- Push Morgen tasks into specific calendar slots via the API.
  Auto-scheduling is left to Morgen's native engine. The sync pushes
  the intent ("here is a task, due Thursday, 30 minutes") and lets
  Morgen decide the when.
- Create Morgen events from the sync. Events in Morgen are for real
  calendar meetings. Tasks are for todo-list items. Mixing them is
  what makes Motion feel chaotic. We keep them separate on purpose.
- Use Morgen's "linked task" feature (where a task can be anchored to
  an existing event). It's API-immature and locks us into a
  Morgen-specific data shape that has no Obsidian analog.

### 3.3 The rate-budget problem

Morgen's API has a 100-points-per-15-minute limit, where different
operations cost different numbers of points. Task creates are
expensive, task lists are cheap. The practical upper bound is roughly
25 task writes per poll window before you get throttled. That's fine
for steady-state (a user usually adds 3–10 tasks per day) but it means
the FIRST time you run task-maxxing on an existing 200-task vault,
you'll hit the limit. That's why `scripts/morgen-backfill.js` is a
separate one-shot script, not something W1 does inline.

---

## 4. Why Notion for collaboration

Notion's job in task-maxxing is "the place I show my tasks to other
humans." It is NOT a source of truth and it is NOT a scheduler. It is
a projection target.

### 4.1 Why a projection target at all

The Obsidian vault is private. Nathan does not want to share his vault
with his accountant, his teammate, or his lawyer. But he DOES want
those people to be able to see specific subsets of his tasks and,
sometimes, tick them off for him.

Notion solves this with two features:

1. **Database views.** One Notion database + ten filtered views = ten
   audiences each seeing the slice they care about.
2. **Granular sharing.** You can share one database with one email
   without exposing the rest of the workspace.

Compared to the alternatives:

- **Google Sheets** — would work, but has no native "done" semantics
  and no task metaphor. Plus Nathan already removed Google Workspace
  integrations.
- **Linear / Jira / Height** — too much process, too much onboarding
  friction. The goal is "show someone a list," not "spin up a product
  project."
- **Public Obsidian publish** — one-way only, doesn't accept Done
  flips from collaborators.
- **Custom web app** — infinite yak-shave.

### 4.2 Why Notion specifically (vs Airtable, Coda, etc.)

- **API quality.** Notion's API is pretty good. The 3/sec rate limit
  hurts but the endpoints are well-documented and the error messages
  are specific.
- **Price.** Free tier allows enough for a personal workflow; paid
  plans are affordable for collaborators.
- **Non-technical access.** Notion is the one database-like tool that
  non-developers will voluntarily open. That matters when the whole
  point is to share tasks with people who won't install Obsidian.
- **Existing adoption.** Many collaborators already have Notion
  accounts. Zero onboarding friction.

### 4.3 What Notion is BAD at and how we work around it

- **Relations are async.** Setting a relation property sometimes takes
  seconds to propagate. We don't rely on relations for any sync-
  critical state.
- **Formulas can't be written via API.** So any computed columns
  (e.g., "days until due") have to be Notion-native and are invisible
  to the sync.
- **Properties have hard limits.** We cap our property set to
  name/priority/due/scheduled/source-file/hash/morgen-id. Everything
  else stays in Obsidian.
- **Archive is not delete.** When W1 archives a Notion row, it moves
  it to the archive view, not actually delete it. Notion gives you
  `archived: true` for free. This is actually a feature — it preserves
  the audit trail on the Notion side.

---

## 5. Why n8n for orchestration

Something has to run W1, W2, and W3 on schedule (and W1 on git push).
Something has to be the cron box. We considered several options.

### 5.1 Requirements

- **Schedule triggers.** Runs W2 and W3 every 15 minutes forever.
- **Webhook triggers.** W1 needs to fire on a GitHub push event.
- **Hosted.** Nathan doesn't want to maintain yet another Raspberry Pi.
- **Visual editor.** The sync logic is non-trivial. Having a UI to
  click through node executions during debugging is worth a lot.
- **Code nodes.** We need to run non-trivial JavaScript inside the
  workflow — not just wire API calls together. n8n's "Code" node is
  a full JS runtime.
- **Cheap.** This is a personal project. $20/mo is a lot; $100/mo is
  out of the question.
- **Credential storage.** Secrets should live in the platform, not in
  the workflow JSON. (Spoiler: this one we failed at. See §11.)

### 5.2 n8n wins by default

- Has schedule triggers AND webhook triggers in one flow.
- Cloud-hosted at n8n.cloud, $20/mo entry tier is enough for 3
  workflows running every 15 min.
- Visual editor with a live execution log per node.
- Code nodes support ES modules and have generous CPU/memory limits.
- Self-hosted escape hatch: if the cloud gets too expensive or the
  workflows get too complex, the same JSON runs on a self-hosted
  n8n instance.
- OSS, community-friendly, well-documented.

### 5.3 Alternatives considered (briefly; see §12 for more)

- **Zapier** — expensive per-task ($0.04 × 3 workflows × 96 runs/day
  × 30 = too much), no real code node (code steps are limited), no
  schedule trigger on the free tier, generally hostile to the use
  case.
- **Make (Integromat)** — closer to n8n in spirit but scenario
  executions are metered on the cheap tiers, and Make's "iterator"
  node has surprising semantics that bit us early.
- **Pipedream** — credit-metered execution, fine for light loads,
  awkward for the hash-heavy reconciliation loops we need. Also
  hostile to long JS code blocks.
- **Self-hosted cron** — no UI, no retry semantics, no visual
  debugging, zero leverage from the platform. We'd rather pay.
- **GitHub Actions** — tempting, but cold starts are 10–30s and
  there's no "every 15 min" trigger that's reliable. See §12.

---

## 6. Why hash-based upsert

This is the single most important correctness decision in the code. The
other decisions flow from it. Get this wrong and nothing else matters.

### 6.1 The question: "is this task new or not?"

Every sync operation — W1, W2, W3, backfill, e2e test — starts by
reading a pile of "current state" and asking, for each entry, "have I
seen this before?" The answer determines CREATE vs UPDATE vs NO-OP.

The wrong answers:

- **"Compare by text."** Text gets normalized, prefixed with checkbox
  markers, rewritten by Obsidian Tasks plugin on completion, etc. Raw
  string equality is fragile.
- **"Compare by timestamp."** There is no timestamp on the Obsidian
  side. Git commits have timestamps but they belong to the commit, not
  the task.
- **"Compare by position in the file."** Line numbers are unstable —
  adding a task at the top of TASKS-URGENT.md shifts every other line
  by one.

The right answer: **derive a deterministic ID from the content itself,
in a way that's invariant to the trivial things (leading whitespace,
exact emoji ordering) but sensitive to the meaningful things (task
text, priority, due date).**

### 6.2 The upsert contract

Every sync operation implements the same contract:

```
for each item in upstream_state:
    h = hash(normalize(item))
    existing = sync_state.entries[h]
    if existing:
        # UPDATE branch: side-effect only if fields differ
        if differ(existing, item):
            propagate(existing.target_ids, item)
            existing.updatedAt = now
    else:
        # CREATE branch
        target_ids = create_on_destinations(item)
        sync_state.entries[h] = { ...item, ...target_ids, createdAt: now }
```

The only read-side branch the code has is "does `entries[h]` exist?" —
which is O(1) in a JS object. There is no fuzzy matching, no Levenshtein
distance, no "maybe this is the same task as that one." Either the hash
matches or it doesn't.

### 6.3 Why this is an upsert and not a migration

An obvious alternative is "on every run, recompute the entire state
from upstream and overwrite the target systems." That's conceptually
simpler but operationally terrifying — it means every Notion row is
archived and recreated on every run, which (a) loses the Notion page
history, (b) blows up the Morgen rate budget, and (c) produces endless
Notion notification spam to any collaborator.

Upsert sidesteps all three: if the hash is unchanged, we don't touch
the destination at all. NO-OP is the dominant case. CREATE is rare.
UPDATE is rarer still (because most edits happen in Obsidian and
produce a new hash, which takes the CREATE branch for the new row and
an implicit archive for the old one).

### 6.4 Atomicity

"Atomicity" in a distributed system that you don't own is aspirational.
What task-maxxing actually provides is **best-effort ordering with a
forgiving reconciliation loop**:

1. Compute the target state.
2. Attempt all writes.
3. If any fail, the mapping table records the partial state and the
   next run will retry.
4. The git commit that writes `.sync-state.json` is atomic at the
   filesystem level, so either the sync happened and was recorded, or
   it didn't happen (from the repo's perspective).

This is weaker than database transactions. It is stronger than "we
crash in the middle and leave a mess," which is what the first draft
did.

---

## 7. Why `SHA256::slice(0,24)`

"Use a hash" is the decision. "Which hash, how long, in what encoding"
is a pile of small decisions that matter disproportionately.

### 7.1 The constraints

- **Enough entropy that collisions are statistically impossible** at the
  scale of a personal task backlog (say, 10,000 tasks lifetime).
- **Short enough to read in logs** without making the commit message
  unreadable.
- **Short enough to fit in a Notion `rich_text` property** without
  wrapping ugly.
- **Stable across languages** (we might need to recompute hashes from
  JS in n8n AND from Python in a future script).
- **Derivable from string hashing**, not random UUIDs, because the
  whole point is "same content → same hash."

### 7.2 Why SHA-256

It's the default. It's in every language's stdlib. It's FIPS-blessed.
It's collision-resistant up to 2^128 operations. We are not trying to
be clever.

We considered:

- **MD5** — enough for uniqueness but smells wrong in 2026.
- **SHA-1** — same problem.
- **Blake3** — not in n8n's Code node runtime by default.
- **xxHash** — not cryptographic; overkill to plumb in a non-stdlib
  module when SHA-256 is free.

SHA-256 wins because it's free, it's everywhere, and it's fast enough
(we hash at most a few hundred short strings per sync run).

### 7.3 Why 24 hex characters (96 bits)

SHA-256's native output is 64 hex chars (256 bits). That's overkill.
The birthday bound for 96 bits is ~2^48 inputs — we'd need quintillions
of tasks before collision probability stopped being a rounding error.
Let's do some math:

With 96 bits, the probability of a collision across N items is
approximately `N^2 / 2^97`. For N = 10,000 (a generous lifetime budget
for a single Obsidian vault), that's `10^8 / 1.58 × 10^29 ≈ 6 × 10^-22`.
That's less than the probability of cosmic rays flipping a RAM bit
during the sync.

24 hex chars is:

- **Readable in commit messages.** `[bot:W1] created h=8f706dea1b2c...`
  fits in 72 columns.
- **Short enough for a Notion `rich_text` field** without forcing a
  secondary display column.
- **Long enough** that the birthday bound doesn't bite.
- **A round byte boundary** (12 bytes).
- **A multiple of 8** (so it aligns nicely in logs).

And it's not a number you need to remember, so picking 24 instead of
20 or 32 isn't going to confuse anyone who reads the code.

### 7.4 What we hash

Spelled out because it matters for reproducibility: the **input** to
the hash is the raw Obsidian Tasks plugin line, normalized as follows:

1. Strip leading `- [ ]` / `- [x]` checkbox markers.
2. Strip trailing whitespace.
3. Preserve all emoji markers (🔺 ⏫ 🔼 🔽 ⏬ 📅 ⏳ 🛫 ✅ 🔁).
4. Preserve the task text.
5. Preserve priority markers.

So the hash changes if the user edits the task text OR the priority OR
the due date, and DOESN'T change if the user just reorders lines in
the file or toggles `- [ ]` to `- [x]`. That last property is
intentional: completing a task does NOT change its identity, which is
exactly what we want for the close path.

### 7.5 What happens if two tasks collide

If two tasks somehow produce the same hash (they won't, see above), the
second one will be treated as an UPDATE of the first. The user would
notice because the Notion row would have the text of the first task
but the due date of the second. Recovery is: slightly edit the
second task's text (add a trailing dot) and the hash regenerates.

We do NOT try to detect collisions inline. The code cost of detection
is not justified by the probability.

---

## 8. Conflict resolution: last-writer-wins + Obsidian tiebreaker

This is where the split-brain problem from §1.1 gets resolved in
concrete code.

### 8.1 The rule

When the same task is touched on two different sides in the same sync
window, the resolution is:

1. **If Obsidian is one of the sides, Obsidian wins.** Full stop.
2. **If Obsidian is not involved** (Notion change + Morgen change in
   the same 15 min), the side that hits its workflow first wins, and
   the losing side's change is reconciled on the NEXT run via the
   Obsidian replay.

This sounds unprincipled. It is actually doing a lot of work.

### 8.2 Why Obsidian wins the tiebreaker

Obsidian is the only place where the WRITE is inherently a commit. The
user typed something, it's on disk, git has it, you can't un-type it.
Notion and Morgen are "live" APIs where the same data might be in
flight, or the user might be in the middle of editing, or there might
be a retry in flight. Obsidian is the settled state.

Put differently: Obsidian is the only side where we can run a git
commit hook and GUARANTEE the write happened. So when a conflict
resolves, the system's job is to re-emit from the settled Obsidian
state to the unsettled Notion/Morgen states, not the other way around.

### 8.3 Why we did NOT pick CRDTs

CRDTs (Conflict-free Replicated Data Types) — Automerge, Yjs, etc. —
are the "correct" answer to three-way sync in theory. They give you
field-level merging that converges regardless of operation order. They
are what Figma, Linear, and Notion themselves use internally.

They are also the wrong answer here, for three reasons:

1. **Integration cost.** To use Automerge across Obsidian, Notion, and
   Morgen, you'd have to make each of those systems CRDT-aware. Two of
   the three are closed SaaS products. You'd end up running a CRDT
   layer ABOVE them, which means translating every CRDT op into an API
   call, which means reimplementing the same sync-and-reconcile loop
   we're writing anyway, plus a CRDT runtime on top.
2. **Runtime cost.** CRDT documents grow without bound unless you run
   periodic compaction. For a single-user task list with a ~60-item
   working set, the bookkeeping dwarfs the payload.
3. **Conceptual cost.** A user looking at a conflict in a CRDT system
   sees "both edits merged automatically." A user looking at a conflict
   in task-maxxing sees "my Obsidian edit won, my Notion edit will be
   replayed on the next sync." The second is less elegant but more
   predictable, which is what you want from a tool that's running
   unattended on your calendar.

Vector clocks and Lamport timestamps were rejected for similar reasons:
they solve a problem one layer deeper than where our problem actually
lives.

### 8.4 What this means for users

If you edit a task in Obsidian AND in Notion within 15 minutes, the
Obsidian version wins. If you only edit in Notion, your edit
propagates to Obsidian on the next W3 run. If you only edit in
Morgen, your edit propagates to Obsidian on the next W2 run.

In practice, "I edited the same task in two places inside a 15-minute
window" basically never happens for a single user. It CAN happen when
a collaborator ticks a Notion checkbox simultaneously with the user
doing something in Obsidian. In that case, the user's Obsidian action
wins and the collaborator's checkbox is replayed on the next poll —
which, importantly, PRESERVES the collaborator's intent (the task is
still marked done) because the replay flows through Obsidian.

---

## 9. Safety rails

"It works for a single user with a 60-task backlog" is not the same as
"it's safe under pathological inputs." Here are the rails that exist to
keep pathological runs from wrecking state.

### 9.1 Morgen rate budget (100 points / 15 min)

Hard-coded into W1 and W2. If a sync run would spend more than 100
Morgen points, it stops at 100 and lets the next run pick up the
remainder. The rationale: better a slow sync than a throttled sync
that leaves state half-written.

This is why `morgen-backfill.js` exists as a separate script —
bootstrapping an existing 200-task vault takes several 15-min windows
and is worth doing explicitly, outside the W1 hot path.

### 9.2 Flip-ratio guard (30% max)

W3 aborts if a single run would flip the done state of more than 30%
of open tasks. This catches the "collaborator accidentally bulk-edited
the Notion database" failure mode — without this guard, W3 would
obediently mark 40 tasks done in Obsidian in one shot, which is
usually not what anyone wanted.

The number 30% is chosen by feel, not by math. 10% was too tight
(legitimate end-of-week sweeps triggered it). 50% was too loose
(actual mistakes slipped through). 30% has held up.

When the guard fires, W3 logs the planned actions, DOES NOT apply
them, and exits. The user gets a red-flag commit message ("W3
aborted: flip ratio exceeded") and has to decide what to do.

### 9.3 409 retries

Notion's API occasionally returns 409 Conflict when two writes hit the
same page "simultaneously" (within ~100ms). We retry 409s with an
exponential backoff capped at 3 attempts. Beyond 3, we log the failure
and move on. The next sync run will reconcile.

### 9.4 Idempotency keys are implicit

Every write derives its idempotency key from the hash (for creates) or
the existing mapping row (for updates). If a partial run committed
sync-state with `morgenTaskId=null` but already created the Notion row,
the next run sees "Notion row exists, Morgen row missing" and only
creates the Morgen row. We do not rely on Notion/Morgen's own
idempotency tokens.

### 9.5 Sync-state is write-last

Every sync run performs side effects FIRST and writes sync-state LAST.
If the run crashes between "created Notion row" and "wrote sync-state,"
the next run will see the Notion row already exists (by hash lookup
via `existingByHash`) and reconcile the state file without creating a
duplicate. This is the critical invariant that makes the W1 pipeline
safe to crash mid-run — and it's what Agent 2's `notionPageId`
back-fill fix (§14) was designed to preserve.

### 9.6 Dry-run mode (opt-in)

For the truly paranoid, every workflow supports `DRY_RUN=1` in its
Code node config. In dry-run mode, the Code node computes all the
intended actions and returns them as JSON without touching the
destination systems. The commit message is prefixed `[bot:W1][dry-run]`
so you can audit the log and see what WOULD have happened.

---

## 10. Morgen API quirks that shaped the design

Every integration is a love letter to the API it integrates against.
Here are the specific Morgen quirks that forced architectural
decisions.

### 10.1 Rate limit: 100 points / 15 min, variable cost per op

Creates are expensive (10+ points each). Lists are cheap (1 point).
Updates are medium. The budget is on the aggregate, not per-endpoint.

Consequences:

- W1's Morgen branch calls `list_tasks` first (cheap), diffs against
  sync-state, and only writes deltas.
- W2 polls via `list_tasks` (1 point) and only writes on state change.
- Backfill is a separate script because 200 creates × 10 points = 2000
  points, which is five full 15-min windows.

### 10.2 No task-to-calendar linking via API

Morgen's UI lets you drag a task onto a calendar slot, pinning it.
The API does not expose this operation. Which means:

- The sync cannot "schedule" tasks; it can only create them with a
  duration and due date and let Morgen's auto-scheduler place them.
- Manually pinned tasks survive sync (Morgen doesn't clobber pins on
  API update), but the sync also cannot REPRODUCE a pin if the user
  unpins it.
- "Drag to calendar" stays a human-only operation. The user is in
  charge of when tasks happen; the sync is in charge of what tasks
  exist.

This is actually fine. It matches §3.2's intentional restraint.

### 10.3 Tags are UUIDs, not strings

A Morgen tag `urgent` has a UUID like `f3d2c1...`. When you create a
task with `"tagIds": ["..."]`, you use the UUID, not the string. The
Morgen API will happily accept a task with no tags, but will NOT accept
`"tags": ["urgent"]`.

Consequences:

- W1 maintains a `_tagCache` inside sync-state, mapping string names
  ("urgent", "lorecraft") to UUIDs.
- First run populates the cache with `list_tags`.
- Every subsequent run uses the cache directly, avoiding repeat
  `list_tags` calls.
- New tag names trigger a cache refresh and a `create_tag` call.

This is why `.sync-state.json` has a `_tagCache` top-level key and is
not just `{ entries: {...} }`.

### 10.4 No native idempotency on create

Morgen does not support `Idempotency-Key` headers. If W1 creates the
same task twice, you get two Morgen tasks. The only defense is
sync-state: `if entries[h]?.morgenTaskId` → skip create. This is
another reason the hash-based upsert in §6 is not optional.

### 10.5 List pagination is uncertain

Morgen's `/v3/tasks/list` endpoint appears to return the full task
set in one response, but the API docs don't explicitly promise this.
If it turns out to paginate, W1/W2 will need to walk pages. Flagged
in Agent 2's handoff notes — not fixed yet.

---

## 11. n8n Code node constraints that shaped the design

Three things about n8n's Code node materially changed the design.

### 11.1 `httpRequestWithAuthentication` is blocked inside Code nodes

This is the big one. n8n credentials bound to a workflow are accessible
from the HTTP Request node and from the "call function" helper, but
they are NOT accessible from inside a Code node via
`$helpers.httpRequestWithAuthentication`. n8n blocks that method at
the sandbox level for security reasons (a Code node could otherwise
exfiltrate credentials).

What we wanted: store Morgen and Notion tokens in n8n credentials,
reference them from the Code node by credential ID, never have the
raw token leave the credential vault.

What we got: **tokens are hardcoded string literals inside the Code
node's JavaScript.**

The consequences ripple through the security story:

- The workflow JSON contains live API tokens.
- Exporting a workflow for sharing REQUIRES token scrubbing.
- Rotation means editing the workflow, not rotating a credential.
- CI cannot round-trip the workflow JSON without a scrubbing pass.

We accepted this trade because the alternative (splitting every
reconciliation loop into 10+ separate HTTP Request nodes wired
together with IF/Merge) produces a workflow graph that is impossible
to reason about and fragile to edit. The Code node's "one pile of JS"
is the only viable shape for the kind of stateful, hash-indexed logic
the sync performs.

For the task-maxxing public kit, this means:

- The workflow JSONs in `workflows/` ship with **placeholder tokens**
  (`<YOUR_MORGEN_TOKEN>`, `<YOUR_NOTION_TOKEN>`, `<YOUR_GITHUB_PAT>`).
- `scripts/install-workflows.sh` substitutes the user's real tokens in
  before uploading via n8n's API.
- The repo's `.gitignore` explicitly blocks `.env`, and CI checks for
  accidental token leakage on every push.
- Rotation is documented as "edit the workflow JSON, reimport."

### 11.2 Code node payload ceiling

n8n Code nodes have a soft-limit on jsCode length around ~50 KB before
the editor starts choking. Our W1 is ~34 KB post-Agent-2 fix. W2 and W3
are smaller. We are not in any imminent danger, but refactoring toward
ever-larger Code nodes is a smell.

The mitigation is "factor common helpers into `sync-helpers.js` and
copy-paste them into each workflow's Code node on build." That lets
the source of truth for helper functions be a plain .js file that CI
can test, even though the runtime copy lives inside the workflow JSON.

### 11.3 No shared state between nodes except via items

n8n's execution model is "each node transforms an array of items and
passes it to the next node." There is no "workflow-wide variable"
besides `staticData`, which is persisted across runs but isn't a great
place for a 60KB sync-state file.

This is why the sync-state file lives in the git repo, not in n8n
`staticData`. Reads fetch it via the GitHub API at the top of the run;
writes commit it back via the GitHub API at the bottom. n8n's role is
purely to drive the reconciliation loop, not to persist anything.

A nice side effect: the workflows are **stateless at the n8n level**.
You can delete and reimport a workflow and lose zero state, because all
the state is in the git repo.

---

## 12. Alternatives considered

Documenting the alternatives that were evaluated and rejected, so that
the next person who thinks "why don't we just use X?" has a prior answer.

### 12.1 GitHub Actions workflows

**Appeal:** free for public repos, trigger on push directly, no
separate infrastructure.

**Rejected because:**

- **Cold start times are 10–30 seconds** for every run. On a
  schedule-triggered workflow that runs every 15 min, that's pure
  latency overhead and noticeable lag on the sync.
- **Schedule triggers are unreliable.** GitHub explicitly disclaims
  schedule precision, saying `cron` schedules on public repos can be
  delayed by minutes or skipped under load. For a 15-min poll loop,
  this is unacceptable.
- **No workflow editor.** Every change is a git commit + wait. n8n's
  visual editor + live execution log is dramatically faster for
  iteration.
- **Secrets are per-repo.** That's fine, but it doesn't actually solve
  §11.1 — you're still hardcoding tokens, just in a different pile of
  YAML.

### 12.2 Self-hosted Temporal

**Appeal:** "proper" workflow engine, durable state, retries, signals.

**Rejected because:**

- **Wildly over-engineered** for three cron jobs. Temporal is designed
  for millions-of-workflows-per-day scenarios.
- **Requires running a cluster.** Even single-node Temporal is a
  PostgreSQL + Cassandra (or SQLite) + Temporal server + workers. That
  is a lot of box to maintain for "mark a task done."
- **No visual editor.** You write workflows as code in Go or TypeScript.
  That's the right shape for a team building production services; it's
  the wrong shape for a solo developer tweaking sync logic during
  coffee.
- **Irrelevant wins.** Temporal's big wins are durable state and
  signal-driven control flow. Our "durable state" is a JSON file in
  git; we do not need a workflow engine to own it.

### 12.3 Direct webhook gateway (bespoke Express app)

**Appeal:** full control, no platform lock-in.

**Rejected because:**

- **More infra to manage.** Now you need a server, a process manager,
  TLS certs, a DNS name, log aggregation, uptime monitoring, a deploy
  pipeline. That's a side project on top of the sync side project.
- **Worse iteration loop.** Every tweak is a deploy. n8n lets you
  edit a node and immediately re-run the last execution.
- **Replicates n8n's core value.** Building a "webhook to code" engine
  with schedule triggers and retry semantics IS n8n. We would not be
  outcompeting n8n at its own game.

### 12.4 CRDT-based sync (Automerge, Yjs)

**Appeal:** the theoretically "correct" answer to multi-party sync.

**Rejected because:**

- **Integration cost is prohibitive.** See §8.3 above.
- **Our collaboration model doesn't need it.** The user is the only
  "real" writer on one side; collaborators on Notion are more like
  read-through caches with occasional checkbox ticks than equal
  peers.
- **Obsidian has no CRDT runtime.** Making it CRDT-aware would require
  a plugin ecosystem we don't own.

If task-maxxing ever evolved toward true multi-writer collaboration
(say, a team of five editing the same Obsidian vault through a shared
sync layer), CRDTs would go back on the shortlist. For a personal +
projection-to-collaborators model, they're the wrong tool.

### 12.5 A monolithic Python script on a VPS

**Appeal:** simple, no platform cost, full debugger.

**Rejected because:**

- Same infra burden as §12.3.
- No visual debugging, no "replay last run," no built-in webhook
  endpoint, no retry semantics.
- Still has to solve §6 and §8 from scratch.

### 12.6 Obsidian plugins as the sync engine

**Appeal:** runs locally on the machine where the vault lives.

**Rejected because:**

- Only runs when Obsidian is open. The user wants the sync to happen
  on their phone, in a coffee shop, when their laptop is closed.
- Can't be triggered by Notion or Morgen webhooks.
- Couples the sync to the lifetime of the Obsidian app.

An Obsidian plugin might become a USEFUL addition (for instance, to
add an in-app "Sync now" button that hits the n8n webhook). It is not
viable as the engine.

### 12.7 Zapier / Pipedream / Make

All briefly evaluated, all rejected:

- **Zapier:** expensive per-task pricing, crippled code step, hostile
  to the loop-heavy reconciliation we need.
- **Pipedream:** credit-metered runtime, awkward for long code blocks,
  no native support for the GitHub push → specific file filter we
  need.
- **Make:** the iterator node's semantics are surprising in ways that
  cost us half a day of debugging when we tried to prototype there.

---

## 13. Trade-offs made

Every architectural decision is a trade. Here are the ones we chose
that we know are trades.

### 13.1 Token-in-jsCode vs. credential binding

**We chose:** hardcoded tokens in the Code node jsCode.

**Upside:**

- One coherent reconciliation loop per workflow.
- No explosion of HTTP Request nodes.
- Sync logic is one file, readable top-to-bottom.

**Downside:**

- Workflow JSON contains live secrets.
- Can't share workflows without scrubbing.
- Rotation means editing the workflow.

**Mitigation in the public kit:**

- Ship workflow JSON with placeholder tokens.
- Provide `install-workflows.sh` that substitutes real tokens at
  install time and uploads via n8n API.
- `.gitignore` blocks `.env*` and `*.pem`.
- CI runs `gitleaks` on every push.
- Document rotation as "edit the jsCode, reimport."

### 13.2 15-minute poll vs. realtime

**We chose:** 15-minute poll for W2 and W3. W1 is push-triggered.

**Upside:**

- Well under Morgen's rate budget (W2 uses ~2 Morgen points per poll).
- Well under Notion's rate budget.
- Predictable load shape: n8n runs exactly 4 times per hour per poll
  workflow.
- Easy to debug: "was my edit synced yet?" → worst case, 15 minutes.

**Downside:**

- Up to 15 min of lag between a Notion/Morgen edit and the Obsidian
  update.
- Collaborators ticking Notion checkboxes get no realtime feedback.

**Mitigation:**

- W1 is push-triggered, so Obsidian→(Notion+Morgen) direction is
  fast.
- The 15-min window matches "I'll tick some boxes and come back to my
  task list in a bit" rather than "I need realtime collaboration."
- Manual "Sync now" hook can be added via n8n webhook URL — this is
  noted as a future enhancement in §15.

### 13.3 Manual drag-to-calendar vs. API scheduling

**We chose:** tasks are created with duration + due date; Morgen
auto-scheduler places them. The sync never places tasks on specific
times.

**Upside:**

- Honors Morgen's core value prop.
- No round-tripping "scheduled start times" between systems that don't
  share a clock.
- Matches the user's mental model: Obsidian declares intent, Morgen
  decides the calendar.

**Downside:**

- Obsidian's `🛫 2026-04-20` start date marker is only a hint; Morgen
  may schedule the task earlier or later.
- Users who want pinned slots have to drag them in Morgen by hand.

### 13.4 One git repo for state and tasks

**We chose:** `.sync-state.json` and the task markdown files live in
the same git repo.

**Upside:**

- One atomic commit updates both.
- Git blame traces every sync action.
- Rollback is `git revert`.

**Downside:**

- `.sync-state.json` commits show up in `git log` and pollute the
  history if you're not expecting them.
- The user must remember to `.gitignore` editor temp files that would
  otherwise fire spurious W1 runs.

**Mitigation:**

- Bot commits are tagged `[bot:W1]` / `[bot:W2]` / `[bot:W3]` so
  they're filterable.
- The public kit's `.gitignore.example` explicitly lists known temp
  files.

### 13.5 Obsidian Tasks plugin lock-in

**We chose:** the task line format comes from Clare Macrae's Obsidian
Tasks plugin. task-maxxing will not parse arbitrary markdown to-do
lists.

**Upside:**

- Well-defined, documented, stable parser.
- Emojis are stable ASCII-round-trippable and won't get mangled by
  copy-paste.
- Community of Obsidian users already uses this syntax.

**Downside:**

- Users who don't use the plugin have to adopt the syntax or fork
  the parser.

**Judgment:** acceptable. The plugin is the de facto standard for
checkbox tasks in the Obsidian ecosystem.

### 13.6 No realtime UI updates

We never built a dashboard that shows "sync is running." The signal a
user gets is (a) the commit showing up in git, and (b) the Notion /
Morgen row changing. If a sync is silently failing, it shows up in
n8n's execution log, not in a user-facing UI.

This is a deliberate "don't build a UI for an operations tool"
stance. The operations UI IS the git log plus n8n's dashboard.

---

## 14. Known anti-patterns we explicitly chose

Calling these out so nobody "fixes" them in a refactor without reading
this section first.

1. **Big Code nodes, not wired graphs.** See §11.1. The giant jsCode
   block in each workflow is intentional. Do not split W1 into 15
   HTTP Request nodes.
2. **Tokens in jsCode.** See §11.1 and §13.1. Do not port to n8n
   credentials; it will not work (you'll discover this half a day
   in).
3. **Sync-state file in the task repo.** See §13.4. Do not move it
   to n8n `staticData` or a separate repo. Atomic git commits are
   the whole point.
4. **Hash primary key, not row IDs.** See §6. Do not replace with
   Notion page IDs or Morgen task IDs as the source-of-truth key.
   Row IDs are associate-table columns, not PKs.
5. **15-min poll, not realtime.** See §13.2. Do not add a webhook
   listener on the Notion side (Notion's webhook subscriptions are
   flaky and rate-limited; we tested).
6. **Hardcoded 100-point Morgen budget.** See §9.1. Do not remove
   the budget to "let backfill run inline" — instead, run
   `morgen-backfill.js` as the intended escape valve.
7. **Obsidian Tasks plugin syntax as the canonical format.** See
   §13.5. Do not write a "more flexible parser" that accepts random
   markdown todos. Parser surface area is a lie detector for state.

---

## 15. Future work

Things we know we want but consciously deferred. The kit is shippable
without any of these.

1. **Fix W3 schema mismatch.** The live W3 workflow reads
   `syncState.mappings[pageId]` but W1/W2 write `syncState.entries[hash]`.
   Surfaced during rswarm2 (Agent 2's post-fix bug hunt). The
   public kit ships with a CORRECTED W3 that uses `findByNotionId()` and
   the canonical helpers. The live workflow is still on the old shape
   until a dedicated follow-up lands.
2. **Notion webhook ingestion.** Would close the 15-min latency gap on
   the Notion→Obsidian path. Blocked on Notion webhook reliability.
3. **Morgen drag-to-pin feedback.** No API for it. Blocked on Morgen.
4. **Multi-user mode.** Would require revisiting §8 (last-writer-wins
   with Obsidian tiebreaker) and probably picking up at least a
   lightweight CRDT for the shared slice. Out of scope for v1.
5. **Operational dashboard.** A simple Grafana or web UI showing
   "last sync success time per workflow, flip ratio trend, error
   rate." Live, n8n's dashboard is sufficient.
6. **Test harness that spins up a scratch Notion DB + Morgen workspace.**
   Currently `scripts/sync-e2e-tests.js` asserts against a known
   fixture; a bootstrapping harness would make CI self-contained.
7. **Alternative tiebreaker policies.** Nothing in the architecture
   prevents someone from shipping a "Notion wins" variant for a
   team-collaborative fork.

---

## Appendix A — Decision log summary

| # | Decision | Alternatives rejected | Section |
|---|----------|-----------------------|---------|
| 1 | Obsidian is source of truth | Notion, Morgen | §2 |
| 2 | Morgen for scheduling | Motion, Reclaim, Todoist | §3 |
| 3 | Notion for collaboration | Airtable, Coda, Linear | §4 |
| 4 | n8n for orchestration | GitHub Actions, Temporal, Zapier, Pipedream, Make, self-hosted cron | §5, §12 |
| 5 | Hash-based upsert | Timestamp diff, string compare, position-in-file | §6 |
| 6 | SHA256::slice(0,24) | UUID, MD5, SHA-1, Blake3, xxHash, full SHA-256 | §7 |
| 7 | Last-writer-wins + Obsidian tiebreaker | CRDT, vector clocks, field-level merge | §8, §12.4 |
| 8 | Tokens in jsCode | n8n credentials, env injection, vault | §11.1, §13.1 |
| 9 | 15-min poll for W2/W3 | Realtime webhooks, 1-min poll, 60-min poll | §13.2 |
| 10 | `.sync-state.json` in task repo | n8n staticData, separate repo, redis | §11.3, §13.4 |
| 11 | Obsidian Tasks plugin syntax | Custom parser, markdown-wide | §13.5 |
| 12 | 100-point Morgen budget | Unlimited, per-endpoint | §9.1, §10.1 |
| 13 | 30% flip-ratio guard | No guard, per-area guard | §9.2 |

---

_This document is long on purpose. If you're about to disagree with a
decision, please cite the section and the trade it made, so the
conversation starts from shared context._

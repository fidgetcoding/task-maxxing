# Contributing

task-maxxing is a reference implementation that one person runs in production. It's
open to changes, but the bar is:

1. Does this make the sync more reliable, or less?
2. Does this reduce the number of foot-guns a new user can hit during setup?
3. Does this keep Obsidian as the canonical source of truth?

If a PR makes the answers worse, it's probably a no.

---

## Who this is for

- **Nate** (the maintainer) pushes changes directly to `main`. No branches, no PRs,
  no code review from himself.
- **Outside contributors** should open a PR on GitHub. A PR lets the maintainer review,
  run the e2e tests, and merge.
- **Issues are welcome** from anyone. Bug reports, feature requests, setup questions —
  all fair game.

---

## How to propose a change

### If you're Nate

```bash
git pull --rebase origin main
# make changes
npm test
git add -A
git commit -m "feat: describe what changed"
git push origin main
```

That's it. No PR, no review cycle.

### If you're not Nate

1. **Fork** the repo on GitHub.
2. **Clone** your fork locally.

   ```bash
   git clone https://github.com/{{YOUR_USERNAME}}/task-maxxing.git
   cd task-maxxing
   git remote add upstream https://github.com/lorecraft-io/task-maxxing.git
   ```

3. **Make your changes** in `main` directly. This repo doesn't use feature branches.
4. **Run the tests** (see below).
5. **Commit and push** to your fork.
6. **Open a PR** against `lorecraft-io/task-maxxing:main`. In the description:
   - What the change does.
   - Why it matters.
   - Which test scenarios you ran, and whether they passed.
   - Whether you actually ran this against a real Obsidian + Notion + Morgen stack,
     or just unit tests.

PRs from people who ran the full smoke test get merged faster than PRs with only unit
tests. This sync is too fiddly to trust tests alone.

---

## Code style

There are no rigid style rules. Match what's already there. Specifically:

- **2-space indent.**
- **Semicolons** at the end of statements in `.js` files.
- **Single quotes** for strings unless you need interpolation.
- **`const`** by default, `let` only when re-assignment is required, never `var`.
- **Async/await** over `.then()` chains.
- **camelCase** for variables and functions, **PascalCase** for classes, **SCREAMING_SNAKE_CASE**
  for env vars and module-level constants.
- **File names:** `kebab-case.js` for scripts, `lower-case.md` for docs.

If a new file has 300+ lines, think about splitting it. Files over 500 lines will get
a "can you split this" comment on PR.

### One real rule: no breaking `.sync-state.json`

If your change modifies the schema of `.sync-state.json`:

1. Bump the `version` field.
2. Add a migration path in `src/sync-helpers.js` (read old version, upgrade to new).
3. Document the schema change in `docs/ARCHITECTURE.md`.
4. Add a regression test that loads a v1 file and verifies it upgrades cleanly.

Users in the wild will have v1 state files. Breaking them is a hard no.

---

## Testing

task-maxxing has two tiers of tests.

### Unit tests

Fast, hermetic, no network. Cover `src/sync-helpers.js` (parsing, hashing,
diff computation, conflict resolution).

```bash
npm test
```

**Before committing, this must be green.** If you add logic in `src/`, add a test in
`tests/` that covers the happy path and at least one edge case.

### End-to-end smoke tests

Slow, require real credentials, **destructive** (they create and delete rows in your
Notion + Morgen). Point at a dedicated test database and task list, not your main one.

```bash
# Set up a dedicated test env
cp .env .env.test
# Edit .env.test and point NOTION_DATABASE_ID + MORGEN_API_KEY at scratch resources
$EDITOR .env.test

# Run the e2e suite
DOTENV_FILE=.env.test node scripts/sync-e2e-tests.js
```

**What it does:**

1. Creates a fresh scratch markdown file in a temp directory.
2. Runs the parser + `.sync-state.json` builder.
3. Simulates a W1 run by calling the Notion and Morgen APIs directly.
4. Verifies the rows appear.
5. Runs the four smoke-test scenarios from [SETUP.md](SETUP.md#14-smoke-test).
6. Cleans up all created rows.

**Before merging to main, this must be green against a real Notion + Morgen test
environment.** CI can run unit tests but not e2e, so the PR author has to report this
manually.

### Linting

```bash
npm run lint
```

Uses `eslint` with a minimal config. If the lint fails on style alone, `npm run lint -- --fix`
will handle most of it.

---

## Directory layout rules

- `src/` — production code (daemon, helpers).
- `scripts/` — one-shot maintenance scripts (backfill, e2e, install).
- `workflows/` — n8n workflow JSON exports.
- `daemon/` — launchd plist template.
- `notion/` — Notion schema reference.
- `examples/` — sample files users can copy.
- `docs/` — everything a user needs to read.
- `tests/` — unit tests (mirror the `src/` layout).

Don't create new top-level directories without talking to the maintainer first.

---

## What's in scope vs out of scope

**In scope:**

- Reliability improvements (fewer failed syncs, better conflict handling).
- Additional Obsidian Tasks plugin field support (start dates, recurrence, scheduled
  times if Morgen ever exposes them).
- Linux daemon port (systemd unit file + installer).
- Windows daemon port (Task Scheduler + installer).
- Better error messages in the daemon and workflows.
- Performance work (faster parse, smaller state files).

**Out of scope:**

- **Other apps.** task-maxxing is Obsidian ↔ Notion ↔ Morgen. Adding a fourth app
  means rethinking the architecture. If you want that, fork.
- **Web UI.** The point of task-maxxing is that the UI is already Obsidian, Notion,
  and Morgen. A fourth UI is a liability.
- **Mobile daemon.** Not happening. Run the daemon on your Mac; edit your vault from
  your phone via Obsidian sync.
- **Migrating from Todoist/Things/TickTick.** If you want to import from those, write
  a one-shot script that emits markdown, then let task-maxxing take over.

---

## Questions?

Open a [discussion](https://github.com/lorecraft-io/task-maxxing/discussions) rather
than an issue. Discussions are better for "how would I...?" questions; issues are for
"this is broken".

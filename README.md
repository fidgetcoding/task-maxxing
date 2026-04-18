# task-maxxing

> Perfect bidirectional task sync between Obsidian, Notion, and Morgen — a DIY kit.

**task-maxxing** is an opinionated pipeline that keeps your tasks in sync across the three
apps where knowledge workers actually live: Obsidian (the canonical file store), Notion
(the shareable UI), and Morgen (the calendar / auto-scheduler). Edit a task in any of
the three and it lands in the other two within a minute — priorities, due dates,
scheduled blocks, completion state, and all.

This repo is the reference implementation Nate built for his own vault. It's packaged
as a kit you can clone, re-point at your own accounts, and run in about two hours.

> **Template vs. instance:** task-maxxing is the template. When you run through setup,
> you'll create your own private `YOUR-VAULT-tasks` repo (step 8) — that's where your
> live sync state, `.sync-state.json`, and workflow commits actually live. This repo stays
> clean and reusable. Think of it like `create-react-app` vs your actual app.

---

## Why

If you're reading this you've probably already tried:

- **Notion alone** — beautiful UI, no local file store, no auto-scheduler.
- **Obsidian alone** — canonical files, no shareable UI, no calendar.
- **Motion / Morgen alone** — auto-scheduling, no knowledge graph.
- **Zapier / Make** — starts fine, dies the moment you need three-way sync with a
  source-of-truth rule and conflict resolution.
- **A single super-app** — doesn't exist, and if it did it would lock you in.

The missing piece is a **three-way sync with one canonical source**. task-maxxing makes
Obsidian canonical (plain markdown, lives in git, survives every tool change for the
next decade) and treats Notion and Morgen as live mirrors you can edit bidirectionally.

Concretely, you get:

- **Edit anywhere.** Check a task off in Morgen on your phone, it's checked in Notion
  and Obsidian 30 seconds later.
- **One source of truth.** Your `.md` files in `08-Tasks/` are canonical. Notion and
  Morgen are regenerated mirrors — if they ever drift, the markdown wins.
- **Git-backed history.** Every task edit is a git commit. Time-travel, blame,
  diffs, cherry-pick, the works.
- **No vendor lock-in.** Turn the pipeline off tomorrow and your data is still a
  directory of markdown files.

---

## Architecture

Six directed edges, three workflows, one local daemon.

```
                        ┌───────────────────────┐
                        │  Obsidian (canonical) │
                        │  08-Tasks/*.md        │
                        │  + .sync-state.json   │
                        └──────────┬────────────┘
                                   │
              ┌────────────────────┼─────────────────────┐
              │ local daemon       │ W1 (n8n)            │
              │ watches files,     │ git push →          │
              │ git commit,        │ Notion create/      │
              │ git push           │ update + Morgen     │
              │                    │ create/update       │
              ▼                    ▼                     │
      ┌──────────────┐    ┌──────────────┐               │
      │  GitHub      │    │   Notion     │◄──────────────┤
      │ (task mirror │    │   Tasks DB   │    W3 (n8n)   │
      │  repo)       │    └──────┬───────┘    Done/Dates │
      └──────────────┘           │            → Obsidian │
                                 │  (commit back)        │
                                 ▼                       │
                        ┌──────────────┐                 │
                        │   Morgen     │─────────────────┘
                        │  Tasks (inbox│   W2 (n8n)
                        │  list only)  │   closed → Obsidian
                        └──────────────┘   (commit back)
```

### Workflow glossary

| Label | Direction                          | Trigger             | What it does                                                                     |
|-------|------------------------------------|---------------------|----------------------------------------------------------------------------------|
| **W1**| Obsidian → Notion + Morgen         | GitHub push webhook | Parses changed `TASKS-*.md` files, creates / updates / archives rows in Notion, creates / updates / closes tasks in Morgen. |
| **W2**| Morgen → Obsidian                  | 60s cron            | Polls Morgen tasks. On a `closed` task, commits `- [x]` back to the source markdown file. |
| **W3**| Notion → Obsidian                  | 60s cron            | Polls Notion for rows where Status changed to Done or Due/Scheduled changed. Commits the change back to the source markdown file. |

### Daemon (local, macOS)

A small Node process watches `08-Tasks/**/*.md`, debounces edits, `git add && git commit &&
git push`. The daemon is the *only* part of the system that touches your local filesystem
— all three n8n workflows interact with your vault via the GitHub API. This keeps n8n
cloud out of your filesystem and lets W2 / W3 write back to markdown as regular commits.

---

## Prerequisites

You will need accounts (free tiers are fine for all of these except Morgen Pro):

- **Obsidian vault** with a `08-Tasks/` folder (any structure, area files named `TASKS-*.md`)
- **Notion workspace** + ability to create an internal integration
- **Morgen account** (Pro tier for API access)
- **n8n cloud** account (or a self-hosted instance — you do you)
- **GitHub account** with room for one private repo
- **macOS** (for the local daemon — the plist/launchd bits are macOS-specific; Linux users
  can adapt with systemd, PRs welcome)
- **Node.js 20+** and **git** locally
- **Homebrew** (optional, for installing dependencies)

---

## Quickstart

```bash
# 1. Clone
git clone https://github.com/lorecraft-io/task-maxxing.git
cd task-maxxing

# 2. Install deps (repo has zero runtime deps — just locks package.json)
npm install

# 3. Copy the example env file and fill in your tokens
cp examples/sample-.env.example .env
$EDITOR .env

# 4. Install the local daemon (wraps Node in a .app bundle + loads launchd)
BUNDLE_ID=io.example.task-maxxing-daemon \
WATCH_PATH="$HOME/path/to/your-vault/08-Tasks" \
SCRIPT_PATH="$(pwd)/src/auto-commit.js" \
  bash daemon/install-daemon.sh
# Then grant Full Disk Access to the printed .app bundle in System Settings.

# 5. Seed Morgen with your open tasks (one-shot backfill)
VAULT_PATH="$HOME/path/to/your-vault/08-Tasks" \
  node scripts/morgen-backfill.js --dry-run       # preview
VAULT_PATH="$HOME/path/to/your-vault/08-Tasks" \
  node scripts/morgen-backfill.js                 # live

# 6. Import n8n workflows (DRY_RUN=1 to preview)
./scripts/install-workflows.sh

# 7. Activate W1, W3, then W2 in the n8n UI
# 8. Smoke test — see docs/SETUP.md section 14
```

Full walkthrough with every click: **[docs/SETUP.md](docs/SETUP.md)**.

If something breaks: **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**.

If you want to understand how the pipes fit together: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## What's in the box

```
task-maxxing/
├── README.md              You are here
├── docs/                  SETUP / ARCHITECTURE / TROUBLESHOOTING / CONTRIBUTING
├── src/
│   ├── sync-helpers.js    Hashing, markdown parsing, diff detection
│   └── auto-commit.js     The local daemon (launchd-ticked git committer)
├── daemon/
│   ├── install-daemon.sh  Installer: builds .app bundle + loads LaunchAgent
│   ├── io.example.task-maxxing-daemon.plist.template
│   │                      launchd template for the daemon
│   └── README.md          FDA walkthrough + troubleshooting for the daemon
├── workflows/
│   ├── W1-obsidian-git-task-sync.json     n8n export
│   ├── W2-morgen-task-completion-sync.json
│   └── W3-notion-done-to-obsidian-sync.json
├── notion/
│   └── tasks-db-schema.md Copy-pasteable database schema for Notion
├── scripts/
│   ├── morgen-backfill.js       One-time tag/ID backfill
│   ├── sync-e2e-tests.js        End-to-end smoke tests
│   ├── install-workflows.sh     Imports workflows via the n8n API
│   └── validate-sync-state.js   Lints your `.sync-state.json`
└── examples/
    ├── sample-sync-state.json
    ├── sample-TASKS-URGENT.md
    └── sample-.env.example
```

---

## Status

**Alpha.** Running in production on Nate's vault since early 2026, but it has had
exactly one user. Looking for testers who:

- live in Obsidian for their PKM
- want Notion as a shareable UI
- use Morgen (or want to) as their auto-scheduler
- are comfortable running a local daemon and debugging n8n

Open an issue or a discussion if you try it. Bug reports with `.sync-state.json` snippets
and n8n execution logs are gold.

### Known quirks

- **macOS only** for the daemon (launchd). Linux/Windows users need to port.
- **Morgen "inbox" task list only.** Morgen's API doesn't yet expose task-list
  management, so all tasks land in your default inbox list.
- **Morgen task-to-calendar promotion is unavailable** via API. You'll still need to
  drag tasks onto the calendar in Morgen's UI (or rely on Morgen's auto-scheduler).
- **Rate budget:** W1 is capped at ~100 Notion ops and ~100 Morgen ops per run to stay
  inside Notion's 3 req/s and Morgen's 100 points / 15 min.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

Built by **Nate Davidovich** ([lorecraft-io](https://github.com/lorecraft-io)) after a
few too many hours wondering why nobody else had shipped a working three-way task sync.
This is the reference implementation that powers his personal 2ndBrain vault.

If you ship a port (Linux daemon, Windows service, Todoist replacement, etc.), open a
PR and I'll link it from here.

<a id="top"></a>

<div align="center">

# task-maxxing

![task-maxxing](https://raw.githubusercontent.com/lorecraft-io/task-maxxing/main/taskmaxxing.png)

**Perfect three-way task sync between Obsidian, Notion, and Morgen — a DIY kit.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

</div>

---

> [!IMPORTANT]
> **Template vs. instance.** `task-maxxing` is the **template**. When you run through setup, you'll create your own private `YOUR-VAULT-tasks` repo (step 8) — that's where your live sync state, `.sync-state.json`, and workflow commits actually live. This repo stays clean and reusable. Think `create-react-app` vs. your actual app.

---

## What this is

`task-maxxing` keeps one task in sync across the three apps I actually live in: **Obsidian** (my files), **Notion** (the pretty UI I can share), and **Morgen** (the calendar that auto-schedules my day). Tick a box in any one of them and the other two catch up in under a minute — priority, due date, scheduled block, completion state, everything.

This repo is the reference implementation I built for my own vault. It's packaged as a kit you can clone, re-point at your own accounts, and run in about two hours.

### Do you actually need a three-way sync?

Honestly? Probably not. For most people, pick one app and live there.

But if you're reading this you probably have ADHD and are trying to stay organized while juggling 43 side projects in 10+ Claude Code instances at the same time — and you refuse to update the same task in three different places like some kind of manual-labor peasant. Same. That's who this is for.

The only paid piece is an **n8n subscription** (which I was paying for anyway for other automation). Everything else — Obsidian, Notion, Morgen's free tier, GitHub, Node — is free or already on your machine.

---

## Why not just...

- **Notion alone** — gorgeous UI, no local files, no auto-scheduler. If Notion goes down, your day goes down.
- **Obsidian alone** — canonical markdown files, no shareable UI, no calendar.
- **Motion / Morgen alone** — auto-scheduling magic, no knowledge graph, no file store.
- **Zapier / Make** — fine for two-way flows, dies the moment you need **three-way** sync with a source-of-truth rule + real conflict resolution.
- **A single super-app** — doesn't exist. If it did, it'd lock you in and then get bought by Atlassian.

The missing piece is **three-way sync with one canonical source**. `task-maxxing` makes Obsidian canonical (plain markdown, lives in git, still readable in ten years when every SaaS in this list is dead) and treats Notion and Morgen as live mirrors you can edit bidirectionally.

### What you actually get

- **Edit anywhere.** Check a task off in Morgen on your phone, it's checked in Notion and Obsidian inside a minute.
- **One source of truth.** Your `.md` files in `08-Tasks/` are canonical. Notion and Morgen are regenerated mirrors — if they drift, the markdown wins.
- **Git-backed history.** Every task edit is a git commit. Time-travel, blame, diffs, the works.
- **No vendor lock-in.** Turn the whole pipeline off tomorrow and your data is still a folder of markdown files.

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

A small Node process watches `08-Tasks/**/*.md`, debounces edits, and runs `git add && git commit && git push`. The daemon is the **only** part of the system that touches your local filesystem — all three n8n workflows talk to your vault through the GitHub API. This keeps n8n cloud out of your disk and lets W2 / W3 write back to markdown as regular commits.

> *(A note on "daemon" — as a non-technical builder, I get excited seeing the word "daemon" because, in my experience — correct me if I'm wrong — it just means something might happen automatically, behind-the-scenes, or fast. I'm probably a bit wrong in some way, but I **won't** look it up right now because I feel a deep sense of pride in this parenthetical sentence.)*

---

## Prerequisites

You'll need accounts (free tiers are fine for all of these except Morgen Pro):

- **Obsidian vault** with a `08-Tasks/` folder (any structure — area files named `TASKS-*.md`)
  - 👉 **Don't have a vault yet?** Use my [**2ndBrain-mogging**](https://github.com/lorecraft-io/2ndBrain-mogging) setup as your starting point. It's the best-of-5 different second-brain systems — I merged the good parts of Karpathy / Jens / eugeniu / AgriciDaniel / NicholasSpisak, cut the dead folders and redundant logic, and shipped what's left. Everything you want, everything you actually need, nothing you don't. `task-maxxing` drops straight into its `08-Tasks/` folder.
- **Notion workspace** + the ability to create an internal integration
- **Morgen account** (Pro tier, for API access)
- **n8n cloud** account (or self-hosted — you do you)
- **GitHub account** with room for one private repo
- **macOS** (for the local daemon — the plist/launchd bits are macOS-specific; Linux users can adapt with systemd, PRs welcome)
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

**Alpha.** Running in production on my vault since early 2026, but it's had exactly one user. Looking for testers who:

- live in Obsidian for their PKM
- want Notion as a shareable UI
- use Morgen (or want to) as their auto-scheduler
- are comfortable running a local daemon and debugging n8n

Open an issue or a discussion if you try it. Bug reports with `.sync-state.json` snippets and n8n execution logs are gold.

### Known quirks

- **macOS only** for the daemon (launchd). Linux / Windows users need to port it.
- **Morgen "inbox" task list only.** Morgen's API doesn't yet expose task-list management, so everything lands in your default inbox list.
- **Morgen task-to-calendar promotion is unavailable** via API. You'll still drag tasks onto the calendar in Morgen's UI (or lean on Morgen's auto-scheduler).
- **Rate budget:** W1 is capped at ~100 Notion ops and ~100 Morgen ops per run to stay inside Notion's 3 req/s and Morgen's 300 points / 15 min.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

Built by **Nate Davidovich** ([lorecraft-io](https://github.com/lorecraft-io)) after a few too many hours wondering why nobody else had shipped a working three-way task sync. This is the reference implementation that powers my personal 2ndBrain vault.

If you ship a port (Linux daemon, Windows service, Todoist replacement, etc.), open a PR and I'll link it from here.

<a id="top"></a>

<div align="center">

# task-maxxing

![task-maxxing](https://raw.githubusercontent.com/lorecraft-io/task-maxxing/main/taskmaxxing.png)

**Two-way task sync between Obsidian and Morgen — a DIY kit.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[![Follow on X](https://img.shields.io/badge/FOLLOW%20%40fidgetcoding-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/fidgetcoding) [![LinkedIn](https://img.shields.io/badge/LINKEDIN-CONNECT-0A66C2?style=for-the-badge&logo=linkedin&logoColor=white&labelColor=555555)](https://www.linkedin.com/in/nate-davidovich/) [![YouTube](https://img.shields.io/badge/YOUTUBE-SUBSCRIBE-FF0000?style=for-the-badge&logo=youtube&logoColor=white&labelColor=555555)](https://youtube.com/@fidgetcoding) [![Instagram](https://img.shields.io/badge/INSTAGRAM-FOLLOW-E4405F?style=for-the-badge&logo=instagram&logoColor=white&labelColor=555555)](https://instagram.com/fidgetcoding)

</div>

> [!WARNING]
> **Prerequisite — [`2ndBrain-mogging`](https://github.com/lorecraft-io/2ndBrain-mogging) must be installed and running first.** task-maxxing syncs the `06-Tasks/` folder of that vault — if the vault isn't there, this kit has nothing to sync. Don't clone this repo until 2ndBrain-mogging is live.

> [!NOTE]
> **2026-05-04 cutover:** Notion was dropped from this kit. The maintained pipeline is now **Obsidian ↔ Morgen** two-way. The W3 (Notion → Obsidian) workflow has been removed and W1 no longer touches the Notion API. If you cloned the kit before this date and want the original three-way mode, pin to a commit on `main` before this banner. References to Notion still appear in some doc files (ARCHITECTURE.md, DESIGN-RATIONALE.md, etc.) — those sections are kept as historical context but the working code is now two-way.

---

## Quick Navigation

| Link | Section | What it does | Time |
|---|---|---|---|
| [What this is](#what-this-is) | Overview | The TL;DR — what the kit actually does | ~1 min |
| [Do you actually need this?](#do-you-actually-need-a-two-way-sync) | Audience | ADHD honesty check — who this is (and isn't) for | ~1 min |
| [Why not just...](#why-not-just) | Context | Why Obsidian / Motion / Zapier alone all fail | ~2 min |
| [What you actually get](#what-you-actually-get) | Reference | Edit-anywhere, canonical source, git history, no lock-in | ~1 min |
| [Architecture](#architecture) | Overview | Four directed edges, two workflows, one daemon | ~1 min |
| [Workflow glossary](#workflow-glossary) | Reference | W1 / W2 — what each triggers and does | ~1 min |
| [Daemon (local, macOS)](#daemon-local-macos) | Reference | The only thing that touches your filesystem | ~1 min |
| [Prerequisites](#prerequisites) | Setup | Accounts + tools (Obsidian, Morgen, n8n, GitHub, macOS) | ~2 min |
| [Quickstart](#quickstart) | Setup | Clone → env → daemon → backfill → n8n → smoke test | ~2 min |
| [What's in the box](#whats-in-the-box) | Reference | Repo file-tree tour | ~1 min |
| [Status](#status) | Meta | Alpha — running on my vault, looking for testers | ~1 min |
| [Known quirks](#known-quirks) | Reference | macOS-only daemon, Morgen inbox-only, rate budget | ~1 min |
| [Using these tools outside the sync](#using-these-tools-outside-the-sync) | Reference | Optional Morgen MCP + Obsidian download | ~1 min |
| [The maxxing series](#the-maxxing-series) | Meta | Sibling repos: cli-maxxing + creativity-maxxing | — |
| [License](#license) | Meta | MIT | — |
| [Credits](#credits) | Meta | Built by Nate Davidovich | — |

---

> [!IMPORTANT]
> **Template vs. instance.** `task-maxxing` is the **template**. When you run through setup (see [docs/SETUP.md](docs/SETUP.md) for the full walkthrough), you'll create your own private `YOUR-VAULT-tasks` repo — that's where your live sync state, `.sync-state.json`, and workflow commits actually live. This repo stays clean and reusable. Think `create-react-app` vs. your actual app.

---

## What this is

`task-maxxing` keeps one task in sync across the two apps I actually live in: **Obsidian** (my files) and **Morgen** (the calendar that auto-schedules my day). Tick a box in either one and the other catches up in under a minute — priority, due date, scheduled block, completion state, everything.

This repo is the reference implementation I built for my own vault. It's packaged as a kit you can clone, re-point at your own accounts, and run in about an hour.

### Do you actually need a two-way sync?

Honestly? Probably not. For most people, pick one app and live there.

But if you're reading this you probably have ADHD and are trying to stay organized while juggling 43 side projects in 10+ Claude Code instances at the same time — and you refuse to update the same task in two different places like some kind of manual-labor peasant. Same. That's who this is for.

---

## Why not just...

- **Obsidian alone** — canonical markdown files, no calendar, no auto-scheduler. Tasks just sit there.
- **Motion / Morgen alone** — auto-scheduling magic, no knowledge graph, no file store, no git history.
- **Zapier / Make** — fine for the simple cases, dies the moment you want a real source-of-truth rule + conflict resolution + an echo guard so the system doesn't re-ingest its own writes.
- **A single super-app** — doesn't exist. If it did, it'd lock you in and then get bought by Atlassian.

The missing piece is **two-way sync with one canonical source**. `task-maxxing` makes Obsidian canonical (plain markdown, lives in git, still readable in ten years when every SaaS in this list is dead) and treats Morgen as a live mirror you can edit bidirectionally — so you can tick a task off on your phone in the calendar app and it lands back in your vault as a real commit.

### What you actually get

- **Edit anywhere.** Check a task off in Morgen on your phone, it's checked in Obsidian inside a minute.
- **One source of truth.** Your `.md` files in `06-Tasks/` are canonical. Morgen is a regenerated mirror — if it drifts, the markdown wins.
- **Git-backed history.** Every task edit is a git commit. Time-travel, blame, diffs, the works.
- **No vendor lock-in.** Turn the whole pipeline off tomorrow and your data is still a folder of markdown files.

---

## Architecture

Bidirectional. Edit anywhere; it converges everywhere. Two sub-workflows, one orchestrator, one local daemon.

```
                       ┌────────────────────────┐
                       │  Obsidian (canonical)  │
                       │  06-Tasks/*.md         │
                       │  + .sync-state.json    │
                       └────────────▲───────────┘
                                    │
                  ▲ local daemon    │   ▼ local daemon
                  │ git pull on     │   │ fs watch →
                  │ remote change   │   │ git commit + push
                                    │
                       ┌────────────▼───────────┐
                       │  GitHub                │
                       │  obsidian-tasks-sync   │
                       └─▲────────────────────┬─┘
                         │                    │
                W2 commits│                    │ W1 reads
                Morgen    │                    │ Obsidian
                changes   │                    │ state and
                back      │                    │ syncs to
                          │                    │ Morgen
                         │                    │
                         │                    ▼
                       ┌─┴────────────────────┐
                       │  Morgen Tasks        │
                       │  (calendar-side,     │
                       │   you can edit here  │
                       │   too)               │
                       └──────────────────────┘

            ┌──────────────────────────────────────┐
            │  W0 — Sync Orchestrator (every 20 m) │
            │  executeWorkflow W2 → W1, wait=true  │
            │  The ONLY workflow you activate.     │
            └──────────────────────────────────────┘
```

**How the loop closes:** the local daemon makes the GitHub repo a two-way mirror of `06-Tasks/` on disk — it pushes your edits up AND pulls W2's commits back down. So once W2 lands a commit, the change reaches your Obsidian vault on the next daemon tick without you doing anything.

### Workflow glossary

| Label | Direction                          | Trigger                     | What it does                                                                     |
|-------|------------------------------------|-----------------------------|----------------------------------------------------------------------------------|
| **W0**| *meta*                             | Schedule (every 20 min)     | **The orchestrator.** Runs W2 → W1 in sequence via `executeWorkflow` (wait=true). This is the *only* workflow you activate — it serializes the others so they never race on `.sync-state.json`. |
| **W1**| Obsidian → Morgen                  | Called by W0 (GitHub push trigger present but dormant in default install) | Parses changed `TASKS-*.md` files, creates / updates / closes tasks in Morgen. Mints `🆔 m-XXXXXXXX` IDs in Obsidian for new tasks. |
| **W2**| Morgen → Obsidian                  | Called by W0                | Polls Morgen tasks. On a `closed` task, commits `- [x]` back to the source markdown file. On new Morgen-origin tasks, appends them to the right `TASKS-{AREA}.md`. |

> **Why an orchestrator?** Two independent cron triggers can race each other and interleave commits — W1 mid-run clobbers a `.sync-state.json` update from W2, or vice versa. The orchestrator sequences `pull from Morgen → push merged state out` so the state file mutates serially. If you really want the un-sequenced version (e.g. you're self-hosting and have your own scheduling), pass `SKIP_ORCHESTRATOR=1` to the installer and leave W1/W2's own triggers active.
>
> **Trade-off: W1 is no longer push-instant.** In the default install, you leave W1 inactive so only W0 can fire it — which means an edit to `06-Tasks/` propagates on the next 20-min tick, not on the next `git push`. If you want instant push→Morgen, either (a) activate W1 alongside W0 and accept occasional double-fires (n8n handles duplicate work cheaply because the jsCode is diff-aware), or (b) use `SKIP_ORCHESTRATOR=1` and run bare W1/W2 with their own triggers.
>
> **Known quirk: W0 self-overlap.** n8n's schedule triggers don't skip-if-running. If a 20-min tick lands while the previous W0 is still executing (possible during a large backfill), the second W0 queues up and starts immediately after — which re-introduces the very race W0 was built to prevent. In practice a full W2+W1 cycle finishes in well under 60 seconds, so the overlap window is tiny. If you see it, bump W0 to every 30 min.

### Daemon (local, macOS)

A small Node process watches `06-Tasks/**/*.md`, debounces edits, and runs `git add && git commit && git push`. The daemon is the **only** part of the system that touches your local filesystem — both n8n workflows talk to your vault through the GitHub API. This keeps n8n cloud out of your disk and lets W2 write back to markdown as regular commits.

> *(A note on "daemon" — as a non-technical builder, I get excited seeing the word "daemon" because, in my experience — correct me if I'm wrong — it just means something might happen automatically, behind-the-scenes, or fast. I'm probably a bit wrong in some way, but I **won't** look it up right now because I feel a deep sense of pride in this parenthetical sentence.)*

---

## Prerequisites

You'll need accounts (free tiers are fine for all of these except Morgen Pro):

- **Obsidian vault** with a `06-Tasks/` folder (any structure — area files named `TASKS-*.md`)
  - 👉 **Don't have a vault yet?** Use my [**2ndBrain-mogging**](https://github.com/lorecraft-io/2ndBrain-mogging) setup as your starting point. It's the best-of-5 different second-brain systems — I merged the good parts of Karpathy / Jens / eugeniu / AgriciDaniel / NicholasSpisak, cut the dead folders and redundant logic, and shipped what's left. Everything you want, everything you actually need, nothing you don't. `task-maxxing` drops straight into its `06-Tasks/` folder.
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

# 3b. Load .env into the current shell (steps 5 + 6 read these env vars)
set -a; source .env; set +a

# 4. Install the local daemon (wraps Node in a .app bundle + loads launchd)
BUNDLE_ID=io.example.task-maxxing-daemon \
WATCH_PATH="$HOME/path/to/your-vault/06-Tasks" \
SCRIPT_PATH="$(pwd)/src/auto-commit.js" \
  bash daemon/install-daemon.sh
# Then grant Full Disk Access to the printed .app bundle in System Settings.

# 5. Seed Morgen with your open tasks (one-shot backfill)
#    Reads MORGEN_API_KEY + VAULT_PATH from the .env you sourced in step 3b.
node scripts/morgen-backfill.js --dry-run       # preview
node scripts/morgen-backfill.js                 # live

# 6. Import n8n workflows — W1/W2 + the W0 orchestrator, with IDs
#    auto-templated into W0 after W1/W2 are created.
#    (DRY_RUN=1 to preview, SKIP_ORCHESTRATOR=1 to import W1/W2 only.)
./scripts/install-workflows.sh

# 7. Activate ONLY the W0-Sync-Orchestrator in the n8n UI.
#    Leave W1/W2 inactive — W0 calls them directly, in sequence, every 20 min.

# 8. (Optional) Wire the n8n MCP to Claude Code so you can manage workflows
#    from the terminal. Your N8N_API_KEY + N8N_BASE_URL are already in .env.
claude mcp add n8n-mcp \
  --env N8N_API_URL="${N8N_BASE_URL}/api/v1" \
  --env N8N_API_KEY="${N8N_API_KEY}" \
  -- npx -y n8n-mcp

# 9. Smoke test — see docs/SETUP.md section 14
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
│   ├── README.md               Import-order notes + placeholder reference
│   ├── W0-orchestrator-sync-sequencer.json  Sequences W2 → W1 every 20 min
│   ├── W1-obsidian-git-task-sync.json       n8n export (called by W0)
│   ├── W2-morgen-task-completion-sync.json  n8n export (called by W0)
├── scripts/
│   ├── morgen-backfill.js       One-time tag/ID backfill
│   ├── sync-e2e-tests.js        End-to-end smoke tests
│   ├── test-helpers.js          Unit tests for src/sync-helpers.js
│   ├── install-workflows.sh     Imports workflows via the n8n API
│   ├── validate-sync-state.js   Lints your `.sync-state.json`
│   └── validate-workflows.js    Lints exported n8n workflow JSON
└── examples/
    ├── sample-sync-state.json
    ├── sample-TASKS-URGENT.md
    └── sample-.env.example
```

---

## Status

**Alpha.** Running in production on my vault since early 2026, but it's had exactly one user. Looking for testers who:

- live in Obsidian for their PKM
- use Morgen (or want to) as their auto-scheduler
- are comfortable running a local daemon and debugging n8n

Open an issue or a discussion if you try it. Bug reports with `.sync-state.json` snippets and n8n execution logs are gold.

### Known quirks

- **macOS only** for the daemon (launchd). Linux / Windows users need to port it.
- **Morgen "inbox" task list only.** Morgen's API doesn't yet expose task-list management, so everything lands in your default inbox list.
- **Morgen task-to-calendar promotion is unavailable** via API. You'll still drag tasks onto the calendar in Morgen's UI (or lean on Morgen's auto-scheduler).
- **Rate budget:** W1 is capped at `RATE_BUDGET = 250` Morgen ops per run (well under Morgen's 300 points / 15 min API budget). Because W0 fires W2 + W1 serially on every 20-min tick, plan your ops budget against the *cumulative* per-20-min total (W2 + W1 combined) — not W1 in isolation. A fresh backfill that touches 300+ tasks will blow past the Morgen budget; pre-stage via `scripts/morgen-backfill.js` instead.
- **Existing users with a `W2-3-1-Sync-Orchestrator`:** the installer creates a new `W0-Sync-Orchestrator` beside your existing one. Delete the old `W2-3-1-Sync-Orchestrator` in the n8n UI before running `scripts/install-workflows.sh`, or you'll end up with two orchestrators firing on independent 20-min cadences — which defeats the whole serialization guarantee.

---

## Using these tools outside the sync

None of these are required for the two-way sync — W1/W2 talk to Morgen with a direct API token through n8n, no MCPs involved. But if you landed here cold and want to actually *talk* to these tools from Claude Code (add a task from the terminal, open your vault, manage workflows), here's the optional add-on layer:

- **Morgen MCP** — my unofficial MCP for Morgen.
  ```bash
  claude mcp add morgen -- npx -y fidgetcoding-morgen-mcp
  ```
  Lets Claude Code create / update / reflow Morgen tasks and events from the CLI. Repo: [`lorecraft-io/morgen-mcp`](https://github.com/lorecraft-io/morgen-mcp).
- **n8n MCP** — manage the sync workflows from Claude Code after they're installed. Step 8 of the [Quickstart](#quickstart) wires this up with the same `N8N_API_KEY` / `N8N_BASE_URL` the installer already uses:
  ```bash
  claude mcp add n8n-mcp \
    --env N8N_API_URL="${N8N_BASE_URL}/api/v1" \
    --env N8N_API_KEY="${N8N_API_KEY}" \
    -- npx -y n8n-mcp
  ```
  Heads up: `n8n-mcp` is maintained by [czlonkowski](https://github.com/czlonkowski/n8n-mcp), unaffiliated with n8n.io or lorecraft-io. Third-party package on the unscoped `n8n-mcp` name.
- **Obsidian** — the app itself. Download at [obsidian.md](https://obsidian.md). Pair it with the [Obsidian Tasks plugin](https://publish.obsidian.md/tasks/) (Clare Macrae) — that's the plugin whose syntax `task-maxxing` parses.

If you want all of this pre-wired alongside Claude Code, shell aliases, and a dozen other productivity MCPs, [`cli-maxxing`](https://github.com/lorecraft-io/cli-maxxing) is the one-shot installer.

---

## The maxxing series

This is one of three repos in the stack:

| Repo | What it does |
|------|-------------|
| [`cli-maxxing`](https://github.com/lorecraft-io/cli-maxxing) | Foundation — Claude Code, shell aliases, dev tools, productivity MCPs (Morgen, Motion, n8n, Notion, Playwright, SwiftKit). |
| [`creativity-maxxing`](https://github.com/lorecraft-io/creativity-maxxing) | Design skills, video prompt engines, transcription lab, Canva in terminal. |
| **`task-maxxing`** | **This repo** — two-way task sync, Obsidian ↔ Morgen. |

Install `cli-maxxing` first (it drops `claude` onto your `PATH`). After that, `creativity-maxxing` and `task-maxxing` can be installed in either order.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

Built by **Nate Davidovich** ([lorecraft-io](https://github.com/lorecraft-io)) after a few too many hours wondering why nobody else had shipped a working two-way task sync between a markdown vault and an auto-scheduling calendar. This is the reference implementation that powers my personal 2ndBrain vault.

[⤴ back to top](#top)

## Security: gitleaks pre-commit hook

This repo ships with a `.gitleaks.toml` config and a one-liner installer for a local
pre-commit hook that scans staged content for secrets (GitHub tokens, API keys, JWTs,
etc.) before every commit.

```bash
bash scripts/install-pre-commit-hook.sh
```

The hook runs `gitleaks protect --staged` and blocks commits that contain secrets.
For emergencies you can bypass with `git commit --no-verify` — but DO NOT bypass for
real secrets. Use env vars or a secret manager instead.

If gitleaks isn't installed yet:
- macOS: `brew install gitleaks`
- Linux: https://github.com/gitleaks/gitleaks/releases

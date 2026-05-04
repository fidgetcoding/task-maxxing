# Setup

Zero-to-working install for **task-maxxing**, the two-way Obsidian ↔ Morgen task sync. Budget ~60–90 minutes the first time, mostly clicking through third-party UIs (n8n, GitHub, Morgen). Every command in this doc is copy-pasteable; placeholders look like `{{YOUR_THING}}` and need to be replaced before you run.

> Coming from a pre-2026-05-04 install (3-way with Notion)? Skip to [Migrating from the 3-way version](#migrating-from-the-3-way-version) at the end.

---

## What you'll have at the end

- A 2-way live sync between your Obsidian vault's `06-Tasks/` folder and your Morgen account.
- A local launchd daemon on your Mac that auto-commits every task edit and pushes it to a private GitHub repo.
- Three workflows running in n8n cloud — **W0** (orchestrator), **W1** (Obsidian → Morgen), **W2** (Morgen → Obsidian) — firing on a 20-minute cycle.

Tick a checkbox in either Obsidian or Morgen, the other side catches up within ~60 seconds of the next W0 tick.

---

## Prerequisites

You need accounts at:

- **Obsidian** — desktop app at [obsidian.md](https://obsidian.md), with a vault that has a `06-Tasks/` folder. If you don't have a vault yet, clone [`2ndBrain-mogging`](https://github.com/lorecraft-io/2ndBrain-mogging) first — it's the recommended starting layout and `task-maxxing` drops straight into its `06-Tasks/`.
- **Obsidian Tasks plugin** by Clare Macrae — install via Obsidian → Settings → Community plugins → Browse → "Tasks". Enable it.
- **GitHub account** with one private repo slot free.
- **n8n cloud** — sign up at [n8n.io](https://n8n.io). The free Starter tier works; the Pro tier is recommended for reliable cron triggers.
- **Morgen account** with API access — Pro tier required (Morgen's free tier doesn't expose the API). [morgen.so](https://www.morgen.so).

Local tools (macOS):

```bash
node --version    # need v20 or newer
git --version     # any 2.x
gh --version      # GitHub CLI — used once for repo creation
jq --version      # required by the workflow installer
```

If anything is missing:

```bash
brew install node git gh jq
```

---

## Step 0 — Vault prep

Make sure the Tasks plugin is enabled, then create the folder and one sample file the sync needs.

```bash
mkdir -p /path/to/your-vault/06-Tasks
```

Inside the vault, create `06-Tasks/TASKS-URGENT.md`:

```markdown
# Urgent

- [ ] task-maxxing smoke test 📅 2099-12-31 ⏫ 🆔 m-deadbeef
```

The canonical task line shape is mandatory — the W1 parser only matches this token order:

```
- [ ] <task text> <priority?> 📅 YYYY-MM-DD 🆔 m-XXXXXXXX
```

- `🆔 m-XXXXXXXX` is required on every task. The 8 chars are lowercase hex.
- For new tasks you create by hand, you can leave the 🆔 off — W1 will mint and inject one on its first run. Once minted, **never** rewrite it; the sync uses it as the join key.
- Priorities: 🔺 highest · ⏫ high · 🔼 medium · 🔽 low · ⏬ lowest.
- See [`examples/sample-TASKS-URGENT.md`](../examples/sample-TASKS-URGENT.md) for a fuller reference file.

---

## Step 1 — Clone the repo and prep your env file

```bash
cd ~/Desktop      # or wherever you keep dev repos
git clone https://github.com/lorecraft-io/task-maxxing.git
cd task-maxxing
npm install       # repo has zero runtime deps; this just locks package.json

cp examples/sample-.env.example .env
$EDITOR .env
```

You'll fill in `.env` as you walk through the next steps. The shape you'll end up with:

```bash
VAULT_PATH=/absolute/path/to/your-vault/06-Tasks
TASK_MAXXING_REPO=/absolute/path/to/your-vault/06-Tasks   # same value

GITHUB_REPO_OWNER={{YOUR_GH_USERNAME}}
GITHUB_REPO_NAME={{YOUR_VAULT_NAME}}-tasks
GITHUB_TOKEN=github_pat_{{YOUR_PAT}}

MORGEN_API_KEY={{YOUR_MORGEN_KEY}}
MORGEN_KEY=${MORGEN_API_KEY}

N8N_BASE_URL=https://{{YOUR_SUBDOMAIN}}.app.n8n.cloud
N8N_API_KEY={{YOUR_N8N_KEY}}
```

Leave the file open. Notion env vars (`NOTION_TOKEN`, `NOTION_DATABASE_ID`) are no-ops as of 2026-05-04 — leave them unset.

---

## Step 2 — GitHub repo for sync state

n8n cloud can't reach your laptop's filesystem, so the sync uses a tiny private GitHub repo as the shared state surface. The local daemon pushes your `06-Tasks/` markdown into it; n8n reads and writes it via the GitHub API.

### 2a. Create the private repo

```bash
gh repo create {{YOUR_GH_USERNAME}}/{{YOUR_VAULT_NAME}}-tasks \
  --private \
  --description "task-maxxing sync state for my vault" \
  --clone=false
```

Paste the values into `.env`:

```bash
GITHUB_REPO_OWNER={{YOUR_GH_USERNAME}}
GITHUB_REPO_NAME={{YOUR_VAULT_NAME}}-tasks
```

### 2b. Initialize `06-Tasks/` as a git working tree

The simplest setup is to make `06-Tasks/` itself a git working tree pointing at the new mirror repo. (If your vault is already a git repo, treat `06-Tasks/` as a submodule instead — same end state.)

```bash
cd /path/to/your-vault/06-Tasks
git init
git remote add origin https://github.com/{{YOUR_GH_USERNAME}}/{{YOUR_VAULT_NAME}}-tasks.git
git branch -M main
git add .
git commit -m "[bot:save] initial 06-Tasks snapshot"
git push -u origin main
```

You should see one commit on the GitHub repo. If you don't, fix that before continuing — the rest of the pipeline depends on the daemon being able to push here.

### 2c. Create a fine-grained PAT

```text
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
```

Configure it like this:

- **Token name:** `task-maxxing`
- **Expiration:** 1 year (set a calendar reminder to rotate)
- **Resource owner:** your GitHub username
- **Repository access:** **Only select repositories** → pick `{{YOUR_VAULT_NAME}}-tasks` (the one you just created — nothing else)
- **Repository permissions:**
  - **Contents:** Read and write
  - **Metadata:** Read-only (auto-enabled)
  - Everything else: No access

Click **Generate token**, copy it once (it's only shown one time), and paste into `.env`:

```bash
GITHUB_TOKEN=github_pat_{{YOUR_PAT}}
```

---

## Step 3 — Morgen API token

1. Open [platform.morgen.so/integrations/developers-api](https://platform.morgen.so/integrations/developers-api) and sign in.
2. Click **Create API key**, name it `task-maxxing`.
3. Copy the key. Paste into `.env`:

   ```bash
   MORGEN_API_KEY={{YOUR_MORGEN_KEY}}
   # MORGEN_KEY is an alias the workflow installer reads — it should already
   # be set to ${MORGEN_API_KEY} from the sample file.
   ```

Sanity check the key:

```bash
set -a; source .env; set +a
curl -sS \
  -H "Authorization: ApiKey ${MORGEN_API_KEY}" \
  "https://api.morgen.so/v3/tasks/list?limit=1" | head
```

- 401 → wrong key.
- 403 → your Morgen account doesn't have API access. Upgrade to Pro and try again.
- JSON with a `tasks` array → you're good.

---

## Step 4 — n8n cloud

### 4a. Sign up

Go to [n8n.io](https://n8n.io), pick a subdomain — that becomes `{{YOUR_SUBDOMAIN}}.app.n8n.cloud`. Verify your email and log in.

Paste into `.env`:

```bash
N8N_BASE_URL=https://{{YOUR_SUBDOMAIN}}.app.n8n.cloud
```

### 4b. Generate the n8n API key

In n8n: avatar (bottom-left) → **Settings** → **API** → **Create an API key**. Name it `task-maxxing-installer`, copy it, paste into `.env`:

```bash
N8N_API_KEY={{YOUR_N8N_KEY}}
```

### 4c. Import the workflows

```bash
cd ~/Desktop/task-maxxing
set -a; source .env; set +a    # reload all the new values

# Preview the rendered JSON without sending it (writes to /tmp)
DRY_RUN=1 ./scripts/install-workflows.sh

# Import for real
./scripts/install-workflows.sh
```

What the script does:

1. Validates every required env var is set, exits non-zero with a clear message if not.
2. Substitutes `{{GITHUB_TOKEN}}`, `{{MORGEN_KEY}}`, `{{GITHUB_OWNER}}`, `{{GITHUB_REPO_NAME}}`, etc. into the workflow JSON files.
3. Refuses to continue if any unreplaced `{{PLACEHOLDER}}` remains.
4. POSTs W1 and W2 first, captures their assigned IDs, then templates those IDs into W0 and POSTs it last.
5. Prints the three created workflow IDs and the next step.

> **The script is not idempotent.** n8n's API has no upsert-by-name. Re-running creates duplicate workflows. If you need to reinstall, delete the previous W0/W1/W2 in the n8n UI first.

Open the n8n UI → **Workflows**. You should see three new entries, all currently **inactive**.

---

## Step 5 — Local daemon (auto-commit)

The daemon watches `06-Tasks/` via launchd's `WatchPaths`, debounces, and runs `git add && git commit && git push` once per fire (30s throttle, 5min heartbeat). This is the **only** part of the system that touches your local disk.

```bash
cd ~/Desktop/task-maxxing

BUNDLE_ID=io.example.task-maxxing-daemon \
WATCH_PATH="/path/to/your-vault/06-Tasks" \
SCRIPT_PATH="$(pwd)/src/auto-commit.js" \
  bash daemon/install-daemon.sh
```

The installer:

1. Wraps your `node` binary in a `.app` bundle at `~/Library/Application Support/task-maxxing/TaskMaxxingDaemon.app`. (macOS Full Disk Access only applies to `.app`-wrapped executables — a bare Node script can't be granted FDA.)
2. Renders `daemon/io.example.task-maxxing-daemon.plist.template` to `~/Library/LaunchAgents/${BUNDLE_ID}.plist`.
3. Loads it with `launchctl bootstrap`.
4. Prints the path you'll need for the FDA grant in the next step.

### Grant Full Disk Access

Without FDA, the daemon will log `FATAL: cannot read .../.git/HEAD` on every tick — macOS sandbox policy blocks reading anything in `~/Desktop`, `~/Documents`, `~/Downloads`, or iCloud-synced folders.

1. **System Settings** → **Privacy & Security** → **Full Disk Access**.
2. Click **+**, unlock with Touch ID.
3. Press **Cmd+Shift+G**, paste the `.app` path the installer printed (something like `~/Library/Application Support/task-maxxing/TaskMaxxingDaemon.app`).
4. Make sure the toggle next to the new entry is **ON** (green).

Reload the agent so launchctl picks up the permission:

```bash
launchctl bootout  "gui/$(id -u)/${BUNDLE_ID}"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
```

Verify it's running:

```bash
launchctl list | grep task-maxxing
# expect one line with a numeric PID, not "-"
```

---

## Step 6 — Backfill Morgen with your existing tasks

The first time you run task-maxxing, Morgen has no idea your tasks exist. The backfill script walks `VAULT_PATH`, creates a Morgen task for each open markdown task, and writes a seed `.sync-state.json` so the workflows can dedupe.

```bash
# Always preview first
node scripts/morgen-backfill.js --dry-run

# If the projected payload + point cost looks right, run live
node scripts/morgen-backfill.js
```

The script reads `VAULT_PATH` and `MORGEN_API_KEY` from your sourced `.env`. It is resume-safe — re-running picks up where it left off using the partial `.sync-state.json` it wrote on the previous abort.

When it's done:

```bash
cd "$VAULT_PATH"
git diff .sync-state.json
git add .sync-state.json
git commit -m "[bot:backfill] seed Morgen task IDs"
git push
```

> **Budget abort?** If the projected cost exceeds `--max-points` (default 85, ceiling 300/15min), the script exits 2 and tells you the suggested batch size. Wait 15 minutes between batches.

---

## Step 7 — First sync test

Don't activate W0 yet — manually fire it once and watch the executions panel.

1. In n8n, open **W0-Sync-Orchestrator**.
2. Click **Execute Workflow** (top-right).
3. Watch the **Executions** tab. W0 should call W2 first (Morgen → Obsidian), then W1 (Obsidian → Morgen). Both should finish green.
4. In Morgen, look for your "task-maxxing smoke test" task. It should be in your inbox list with priority High and due 2099-12-31.
5. In Obsidian, open `06-Tasks/TASKS-URGENT.md`. The line you wrote should now have a `🆔 m-XXXXXXXX` token (W1 minted it during the run).

If both checks pass, the sync is working end-to-end. If not, jump to [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Step 8 — Activate the orchestrator

In the n8n UI:

1. Open **W0-Sync-Orchestrator**.
2. Toggle **Active** on (top-right).
3. **Leave W1 and W2 inactive.** W0 calls them directly via `executeWorkflow` with `wait=true`, which serializes them so they never race on `.sync-state.json`. If you activate W1 or W2's own triggers alongside W0, you'll get double-fires.

That's it. The sync is now live. W0 fires every 20 minutes; an edit on either side propagates by the next tick.

### End-to-end smoke test (round-trip)

1. In Morgen, tick the "task-maxxing smoke test" task complete.
2. Wait one W0 cycle (≤20 min).
3. Open `06-Tasks/TASKS-URGENT.md` — the line should have flipped from `- [ ]` to `- [x]`, and `git log --oneline` on the mirror repo should show a `[bot:w2]` commit applying the change.

Then test the other direction:

1. In Obsidian, add a new line to `TASKS-URGENT.md`:
   `- [ ] hello from obsidian 📅 2099-12-31 ⏫`
2. Save. The daemon will commit and push within ~30s; check the GitHub repo to confirm.
3. Wait one W0 cycle.
4. Open Morgen — a new task appears. Open the markdown again — the line now has a `🆔 m-XXXXXXXX` token.

If both round-trips pass, you have a working install.

---

## Step 9 (optional) — Sync-Health-Watchdog

There's a fourth workflow you can wire in to ping you when the sync silently breaks (e.g., n8n cron pauses, GitHub PAT expires). It's not in the default `install-workflows.sh` flow because most people don't need it for the first install — add it later if you start losing signal.

The minimum useful watchdog:

- A schedule trigger every 30 minutes.
- An HTTP node that hits `${N8N_BASE_URL}/api/v1/executions?workflowId=<W0_ID>&status=success&limit=1`.
- An IF node that compares the latest execution timestamp to "now" — if older than 60 minutes, fire a Telegram (or Slack, or email) alert.

If you want to wire Telegram specifically: create a bot via [@BotFather](https://t.me/BotFather), grab the token, send a message to your bot, then GET `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat ID. Plug both into n8n credentials and point the alert node at them.

---

## Troubleshooting one-liners

Don't reinvent these — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the full table.

- Daemon shows up as `-` in `launchctl list` → FDA not granted, see Step 5.
- Daemon log says `FATAL: cannot read .../.git/HEAD` → same root cause, FDA.
- W1 fails with `403 Resource not accessible by personal access token` → PAT scope wrong, redo Step 2c.
- W2 fails with `401 Unauthorized` against Morgen → key copied wrong, redo Step 3.
- `install-workflows.sh` errors on `unreplaced placeholders` → an env var is empty in your sourced `.env`. Re-run `set -a; source .env; set +a`.
- Tasks appearing in Morgen but flipping `- [x]` doesn't propagate to Obsidian → the daemon isn't pushing. `tail -50 ~/Library/Logs/task-maxxing.log`.
- Two orchestrators firing at once → you re-ran the installer without deleting the old workflows. Delete duplicates in the n8n UI.
- Commit on the mirror repo not prefixed `[bot:daemon]` / `[bot:w2]` / `[bot:backfill]` → manual edit slipped past the prefix guard. Amend the message before W1 re-ingests.

---

## Migrating from the 3-way version

If you set this up before 2026-05-04, your install still has Notion in the loop. The 2-way cutover is short:

1. **Pull the latest code:**

   ```bash
   cd ~/Desktop/task-maxxing
   git pull origin main
   ```

2. **Delete the old workflows in the n8n UI.** Specifically the `W3-Notion-Done-To-Obsidian-Sync` workflow, plus any older `W2-3-1-Sync-Orchestrator` from before W0 existed. Keep only the new W0/W1/W2 you're about to import.

3. **Re-run the installer:**

   ```bash
   set -a; source .env; set +a
   ./scripts/install-workflows.sh
   ```

   Activate the new W0 only.

Your `06-Tasks/` markdown, your Morgen tasks, and your `.sync-state.json` keep working — none of those changed shape. The Notion database is no longer touched; you can archive it (or keep it around as a read-only backup; the kit will not write to it again). Leave `NOTION_TOKEN` / `NOTION_DATABASE_ID` unset in `.env`.

---

You're done. Day-to-day usage is "edit your markdown tasks like you always have" — the rest happens behind the scenes on a 20-minute cadence.

If something breaks: [TROUBLESHOOTING.md](TROUBLESHOOTING.md). If you want to understand the wiring: [ARCHITECTURE.md](ARCHITECTURE.md).

# Setup

This is the zero-to-working walkthrough for task-maxxing. Budget **1–2 hours** end to
end. There are 15 steps; none of them are hard, but most of them require a click in a
third-party UI, so grab a coffee and take it in order.

> Every command is copy-pasteable. Every placeholder like `{{YOUR_THING}}` needs to be
> replaced with your own value before running.

---

## Table of contents

1. [Prerequisites checklist](#1-prerequisites-checklist)
2. [Clone the repo and install dependencies](#2-clone-the-repo-and-install-dependencies)
3. [Create the Notion integration](#3-create-the-notion-integration)
4. [Create the Notion Tasks database](#4-create-the-notion-tasks-database)
5. [Get your Morgen API key](#5-get-your-morgen-api-key)
6. [Sign up for n8n cloud (or self-host)](#6-sign-up-for-n8n)
7. [Generate your n8n API key](#7-generate-your-n8n-api-key)
8. [Create the vault-mirror GitHub repo](#8-create-the-vault-mirror-github-repo)
9. [Set up the local daemon](#9-set-up-the-local-daemon)
10. [Grant Full Disk Access to the daemon](#10-grant-full-disk-access-to-the-daemon)
11. [Run the backfill script](#11-run-the-backfill-script)
12. [Import the n8n workflows](#12-import-the-n8n-workflows)
13. [Activate W1, W3, then W2](#13-activate-w1-w3-then-w2)
14. [Smoke test](#14-smoke-test)
15. [Verify the daemon is pushing](#15-verify-the-daemon-is-pushing)

---

## 1. Prerequisites checklist

Before you start, make sure you have all of the following. If any of these are
missing, circle back before continuing — the rest of the guide assumes they're done.

**Accounts**

- [ ] **Obsidian vault** with a `08-Tasks/` folder (at minimum, one `TASKS-URGENT.md` file)
- [ ] **Notion workspace** you own (personal or team, free tier is fine)
- [ ] **Morgen** account (Pro tier needed for API access)
- [ ] **n8n cloud** account OR a self-hosted n8n instance
- [ ] **GitHub** account with room for one private repo

**Installed locally (macOS)**

- [ ] **Node.js 20 or newer** — check with `node --version`
- [ ] **git** — check with `git --version`
- [ ] **Homebrew** (optional but convenient — [brew.sh](https://brew.sh))
- [ ] **gh** (GitHub CLI) — `brew install gh` if you don't have it
- [ ] **jq** — required by `scripts/install-workflows.sh` to render workflow JSON

**Quick check:**

```bash
node --version   # should print v20.x or higher
git --version    # should print 2.x
gh --version     # should print gh version 2.x
jq --version     # should print jq-1.7.x (or similar)
```

If any of those are missing:

```bash
brew install node git gh jq
```

---

## 2. Clone the repo and install dependencies

```bash
cd ~/Desktop   # or wherever you keep dev repos
git clone https://github.com/lorecraft-io/task-maxxing.git
cd task-maxxing
npm install
```

**Expected output:** dependencies install cleanly with no `npm ERR!` lines. If you see
peer dependency warnings, ignore them.

Copy the example env file:

```bash
cp examples/sample-.env.example .env
```

Open `.env` in your editor — you'll fill in values throughout this guide:

```bash
$EDITOR .env
```

The file is heavily commented — read the comments in the file directly. The
canonical shape (matches `examples/sample-.env.example`) is:

```bash
# Local vault — absolute path to the 08-Tasks directory inside your Obsidian
# vault (NOT the vault root — point at the dir that holds TASKS-*.md).
VAULT_PATH=/absolute/path/to/your-vault/08-Tasks
TASK_MAXXING_REPO=/absolute/path/to/your-vault/08-Tasks   # usually same value

# GitHub — split owner + repo name (easier for callers to concat than the
# joined "owner/repo" form).
GITHUB_REPO_OWNER={{YOUR_GH_USERNAME}}
GITHUB_REPO_NAME={{YOUR_VAULT_NAME}}-tasks
GITHUB_TOKEN=github_pat_{{YOUR_TOKEN}}

# Notion
NOTION_TOKEN=ntn_{{YOUR_NOTION_TOKEN}}
NOTION_DATABASE_ID={{YOUR_NOTION_DB_ID}}    # with or without dashes

# Morgen
MORGEN_API_KEY={{YOUR_MORGEN_KEY}}
MORGEN_KEY=${MORGEN_API_KEY}                # alias read by install-workflows.sh

# n8n
N8N_BASE_URL=https://{{YOUR_SUBDOMAIN}}.app.n8n.cloud
N8N_API_KEY={{YOUR_N8N_API_KEY}}
```

Leave the file open — you'll come back to it several times.

> **Env-var naming (load-bearing):** the canonical names are `VAULT_PATH`,
> `NOTION_DATABASE_ID`, `GITHUB_REPO_OWNER` + `GITHUB_REPO_NAME`, and
> `MORGEN_API_KEY` (aliased as `MORGEN_KEY` for the installer). An older
> joined `GITHUB_REPO="owner/repo"` is accepted by `install-workflows.sh` for
> back-compat, but the split pair above is the recommended form.

---

## 3. Create the Notion integration

1. Open [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations) in your browser.
2. Click **+ New integration**.
3. Give it a name: `task-maxxing` (exact name doesn't matter but pick something you'll
   recognize).
4. Pick the workspace you want the Tasks database in.
5. Click **Save**.
6. On the next screen, scroll to **Internal Integration Secret** and click **Show**,
   then **Copy**. This is your `NOTION_TOKEN`. Notion integration tokens now use
   the `ntn_` prefix (the old `secret_` prefix was retired in late 2024).
7. Paste it into `.env`:

   ```bash
   NOTION_TOKEN=ntn_{{YOUR_NOTION_TOKEN}}
   ```

8. Still in the integration config, go to **Capabilities**:
   - Read content: ON
   - Update content: ON
   - Insert content: ON
   - Read user info with email: OFF (we don't need it)
9. **Save** again.

> *Screenshot placeholder: `docs/images/notion-integration-capabilities.png`*

---

## 4. Create the Notion Tasks database

1. In your Notion workspace, click **+** (new page) in the sidebar.
2. Give it a title: **Tasks**.
3. Hit `/table` and pick **Table — Inline**. You'll get a basic table.
4. Delete the two default columns (Tags, and whatever the other one is called), then
   add the columns in this exact order and type. Use `notion/tasks-db-schema.md` as
   your reference — it has the full spec.

   | Column name | Type           | Notes                                                  |
   |-------------|----------------|--------------------------------------------------------|
   | **Name**    | Title          | Already exists — just rename if needed.                |
   | **Status**  | Select         | Add options: `To Do`, `Doing`, `Done`.                 |
   | **Priority**| Select         | Add options: `Highest`, `High`, `Medium`, `Low`, `Lowest`, `None`. |
   | **Area**    | Select         | Add one option per `TASKS-*.md` file you have. Example: `URGENT`, `LORECRAFT`, `GENERAL`. |
   | **Due**     | Date           |                                                        |
   | **Scheduled**| Date          |                                                        |
   | **Source**  | Text           | (plain text, not rich)                                 |
   | **Hash**    | Text           |                                                        |
   | **Tags**    | Multi-select   | Leave empty — task-maxxing will fill it in.            |
   | **Synced At**| Date          |                                                        |

5. **Connect the integration to this database.** Click the `•••` in the top-right of
   the database page, then **Connections** → **Connect to** → pick your `task-maxxing`
   integration. Click **Confirm**.

   > If you skip this step, every Notion API call will return `403: could not find database`.

6. **Grab the database ID.** Copy the page URL from your browser. It looks like:

   ```
   https://www.notion.so/{{YOUR_WORKSPACE}}/Tasks-{{32_CHAR_ID}}?v={{VIEW_ID}}
   ```

   The 32-character hex string after `Tasks-` is your database ID. Paste it into `.env`:

   ```bash
   NOTION_DATABASE_ID={{32_CHAR_ID}}
   ```

   *(Dashes are optional — task-maxxing normalizes them.)*

> *Screenshot placeholder: `docs/images/notion-db-columns.png`*

---

## 5. Get your Morgen API key

1. Open [https://platform.morgen.so/integrations/developers-api](https://platform.morgen.so/integrations/developers-api) in your browser.
2. Sign in with your Morgen account.
3. You should see a **Developer API** panel. If you don't have an API key yet, click
   **Create API key**. Give it a name like `task-maxxing`.
4. Copy the key. Paste into `.env`:

   ```bash
   MORGEN_API_KEY={{YOUR_MORGEN_KEY}}
   # MORGEN_KEY is an alias used by scripts/install-workflows.sh; the sample
   # .env points it at ${MORGEN_API_KEY}, so you only set the value once.
   ```

**Quick sanity check** — this should return your task list:

```bash
curl -sS \
  -H "Authorization: ApiKey $(grep MORGEN_API_KEY .env | cut -d= -f2)" \
  https://api.morgen.so/v3/tasks/list \
  | head -50
```

If you get a 401, your key is wrong. If you get a 403, your Morgen account doesn't
have API access (upgrade to Pro). If you get JSON, you're good.

---

## 6. Sign up for n8n

Two options — pick one.

### Option A: n8n cloud (recommended for first install)

1. Go to [https://n8n.io](https://n8n.io) → **Start for free**.
2. Pick a subdomain. This becomes `{{YOUR_SUBDOMAIN}}.app.n8n.cloud`.
3. Verify your email. Log in.
4. You're in.

Paste the URL into `.env`:

```bash
N8N_BASE_URL=https://{{YOUR_SUBDOMAIN}}.app.n8n.cloud
```

### Option B: Self-hosted

Follow the [n8n self-hosting guide](https://docs.n8n.io/hosting/installation/).
task-maxxing works against any n8n instance — cloud, Docker, Kubernetes — as long as
the API is reachable from your machine for the workflow import step.

Paste the URL into `.env`:

```bash
N8N_BASE_URL=https://n8n.{{YOUR_DOMAIN}}.com
```

---

## 7. Generate your n8n API key

1. In n8n, click your avatar (bottom-left) → **Settings**.
2. Go to **API**.
3. Click **Create an API key**.
4. Name it `task-maxxing-installer`. Expiry: whatever you want (1 year is fine).
5. Copy the key. Paste into `.env`:

   ```bash
   N8N_API_KEY={{YOUR_N8N_API_KEY}}
   ```

The installer script (`scripts/install-workflows.sh`) uses this key to push the three
workflow JSON files into your n8n instance without you having to import them one at a
time.

---

## 8. Create the vault-mirror GitHub repo

This is a *separate* repo from your vault. It's a tiny mirror of the `08-Tasks/`
directory plus a `sync-state.json` file at the root. The daemon syncs it from your
local vault; n8n reads and writes it via the GitHub API.

**Why a mirror and not the vault?** Because n8n cloud can't ssh into your Mac, and
most vaults are too big to shove into git on every save.

Create it:

```bash
# Private repo. Name it whatever — I use `{{YOUR_VAULT_NAME}}-tasks`.
gh repo create {{YOUR_GH_USERNAME}}/{{YOUR_VAULT_NAME}}-tasks \
  --private \
  --description "task-maxxing mirror for my Obsidian vault" \
  --clone=false
```

**Expected output:** `https://github.com/{{YOUR_GH_USERNAME}}/{{YOUR_VAULT_NAME}}-tasks`.

Paste the owner and repo name into `.env`:

```bash
GITHUB_REPO_OWNER={{YOUR_GH_USERNAME}}
GITHUB_REPO_NAME={{YOUR_VAULT_NAME}}-tasks
```

### Create a fine-grained PAT

The daemon needs a token with write access to **only this repo**.

1. Open [https://github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. **Token name:** `task-maxxing-daemon`
3. **Expiration:** 1 year (renew when it rotates)
4. **Resource owner:** `{{YOUR_GH_USERNAME}}`
5. **Repository access:** **Only select repositories** → pick `{{YOUR_VAULT_NAME}}-tasks`.
6. **Permissions → Repository permissions:**
   - **Contents:** Read and write
   - **Metadata:** Read-only (required, always on)
   - Everything else: leave at **No access**
7. Click **Generate token**. Copy it.
8. Paste into `.env`:

   ```bash
   GITHUB_TOKEN=github_pat_{{YOUR_TOKEN}}
   ```

### Initialize the mirror

```bash
# Make a working directory for the mirror (NOT inside your vault)
mkdir -p ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
cd ~/Desktop/{{YOUR_VAULT_NAME}}-tasks
git init
git remote add origin https://github.com/{{YOUR_GH_USERNAME}}/{{YOUR_VAULT_NAME}}-tasks.git

# Put a README in so the first push isn't empty
echo "# Tasks mirror for {{YOUR_VAULT_NAME}}" > README.md
git add README.md
git commit -m "initial"
git branch -M main
git push -u origin main
```

Check in your browser: the repo should now have a `README.md` and one commit.

---

## 9. Set up the local daemon

The daemon watches your vault's `08-Tasks/` folder via launchd's `WatchPaths`, then
runs `src/auto-commit.js` once per fire (with a 30-second throttle and a 5-minute
heartbeat). The script stages, commits, and pushes any changes to the tasks mirror.
It's a one-shot script per tick — no long-running file watcher — and it has zero
npm dependencies.

The installer lives at `daemon/install-daemon.sh`. It takes its configuration from
three environment variables (not from `.env`):

| Variable      | Purpose                                                                |
|---------------|------------------------------------------------------------------------|
| `BUNDLE_ID`   | Reverse-DNS label for the LaunchAgent (e.g. `io.example.task-maxxing-daemon`). |
| `WATCH_PATH`  | Absolute path to the `08-Tasks/` dir inside your vault. This MUST be a git working tree (`git init` it if needed) and its `origin` remote must point at the mirror repo you created in step 8. |
| `SCRIPT_PATH` | Absolute path to `src/auto-commit.js` in this clone of task-maxxing.   |

See `daemon/README.md` for the full list (optional `NODE_BIN`, `APP_SUPPORT_DIR`,
`LOG_DIR`).

**Run the installer:**

```bash
cd ~/Desktop/task-maxxing   # back into the cloned repo

BUNDLE_ID=io.example.task-maxxing-daemon \
WATCH_PATH="$HOME/path/to/your-vault/08-Tasks" \
SCRIPT_PATH="$(pwd)/src/auto-commit.js" \
  bash daemon/install-daemon.sh
```

**What it does:**

1. Copies your Node binary into a `.app` bundle at
   `~/Library/Application Support/task-maxxing/TaskMaxxingDaemon.app/Contents/MacOS/TaskMaxxingDaemon`.
   (Why an `.app` bundle? macOS Full Disk Access only applies to `.app`-wrapped
   executables. A bare Node script can't be granted FDA.)
2. Writes an `Info.plist` alongside it describing the bundle.
3. Renders `daemon/io.example.task-maxxing-daemon.plist.template` →
   `~/Library/LaunchAgents/${BUNDLE_ID}.plist`, substituting `${BUNDLE_ID}`,
   `${WATCH_PATH}`, `${SCRIPT_PATH}`, and the log paths.
4. Lints the plist with `plutil`.
5. Loads it with `launchctl bootstrap gui/$(id -u) …`.
6. Prints the Full Disk Access walkthrough — see the next section.

The agent will start firing immediately, but until you grant FDA (next section), it
will log `FATAL: cannot read …/.git/HEAD` on every tick. That's expected.

---

## 10. Grant Full Disk Access to the daemon

If you skip this step, you will see the most common failure mode:

```
FATAL: EPERM: operation not permitted, open '/Users/you/Desktop/.../08-Tasks/...'
```

macOS sandbox policy blocks reading *anything* in `~/Desktop`, `~/Documents`,
`~/Downloads`, or iCloud folders unless the app has been explicitly granted Full Disk
Access. The `.app` bundle from step 9 exists specifically to make this grant possible.

**To grant FDA:**

1. Open **System Settings**.
2. Go to **Privacy & Security** → **Full Disk Access**.
3. Click the **+** button (you'll need to unlock with Touch ID or password).
4. In the file picker press **Cmd+Shift+G** and paste the `.app` path the installer
   printed (something like
   `~/Library/Application Support/task-maxxing/TaskMaxxingDaemon.app`). Select it.
5. Make sure the toggle next to the new entry is **ON** (green).

> *Screenshot placeholder: `docs/images/macos-fda-grant.png`*

**Reload the agent so launchctl picks up the new permission:**

```bash
launchctl bootout  "gui/$(id -u)/${BUNDLE_ID}"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
```

(Substitute your real `BUNDLE_ID` — e.g. `io.example.task-maxxing-daemon` — if you
don't still have it exported from the previous step.)

**Check it's running:**

```bash
launchctl list | grep task-maxxing
```

**Expected output:** one line with a PID (a positive integer), not `-` (which means
crashed). If you see `-` in the first column, check:

```bash
tail -50 ~/Library/Logs/task-maxxing.log
```

If FDA is not granted, you'll see the explicit `FATAL: cannot read …/.git/HEAD …
macOS Full Disk Access likely not granted` line from `src/auto-commit.js`, which
tells you exactly which Node binary needs FDA. Re-check step 10.1–10.5.

---

## 11. Run the backfill script

The first time you run task-maxxing, there are no task IDs anywhere. The backfill
script walks your `VAULT_PATH`, parses every open task, creates a matching task in
Morgen (one per unique hash), and writes an initial `.sync-state.json` into
`VAULT_PATH` so the workflows can dedupe.

The supported flags (run `node scripts/morgen-backfill.js --help` for the full
list) are:

| Flag                | Purpose                                                          |
|---------------------|------------------------------------------------------------------|
| `--dry-run`         | Print planned payloads + point cost. No API calls.               |
| `--max-points <n>`  | Hard cap on the rate-limit budget (default `85` of Morgen's 100). |
| `--vault <dir>`     | Override `VAULT_PATH` on the CLI.                                |
| `--api-key <key>`   | Override `MORGEN_API_KEY` on the CLI.                            |
| `--verbose`, `-v`   | Log every API call.                                              |

The backfill only touches Morgen and `.sync-state.json`. Notion backfilling happens
automatically on the first W1 run (from `08-Tasks/**/*.md` + the seeded state).

**Preview first:**

```bash
cd ~/Desktop/task-maxxing
VAULT_PATH="$HOME/path/to/your-vault/08-Tasks" \
  node scripts/morgen-backfill.js --dry-run
```

**Expected output:** one section per area, sample payloads, point-cost projection,
and a `dry run complete — no API calls were made` footer.

If the numbers look right, drop `--dry-run` and run for real:

```bash
VAULT_PATH="$HOME/path/to/your-vault/08-Tasks" \
MORGEN_API_KEY=ntn_...replace... \
  node scripts/morgen-backfill.js
```

This will:

1. Fetch existing Morgen tags (`/v3/tags/list`) and cache them in state.
2. Create any missing area tags (one tag per unique `TASKS-*.md` file).
3. Create a Morgen task for every open markdown task (rate-limited under the
   `--max-points` budget).
4. Write `.sync-state.json` into `VAULT_PATH`. **The script does NOT commit.** Review
   the diff and commit the file manually:

   ```bash
   cd "$VAULT_PATH"
   git diff .sync-state.json
   git add .sync-state.json
   git commit -m "[bot:backfill] seed Morgen task IDs"
   git push
   ```

**Expected runtime:** 30–90 seconds for a typical backlog of <80 tasks. The
300 pts / 15 min ceiling (raised from 100 on 2026-04-15) is the upper bound — the
default `--max-points 85` leaves generous headroom.

**Budget abort?** If the projected cost exceeds `--max-points`, the script exits 2
with a suggested batch size. Split the backfill into batches (wait 15 min between)
and re-run.

**Recovery — rerunning after an error:** the script is resume-safe. On every run it
reads the existing `.sync-state.json` and skips any task whose hash is already
present, so aborting mid-run and re-running later just picks up where you left off
— no `--resume` flag needed. If a tag-create or task-create call fails, the script
writes partial state to disk before exiting, so the next invocation picks up the
remaining work automatically.

> If you're on Morgen's free tier you'll hit 403s. That's the point at which you
> upgrade to Pro — it's a one-time cost and doesn't recur per user.

---

## 12. Import the n8n workflows

The `scripts/install-workflows.sh` script substitutes your tokens into each workflow
JSON, strips the n8n-internal top-level fields via `jq`, and POSTs the result to
`${N8N_BASE_URL}/api/v1/workflows`. It reads these env vars:

- `GITHUB_TOKEN`, `NOTION_TOKEN`, `MORGEN_KEY`, `NOTION_DATABASE_ID`
- `GITHUB_REPO_OWNER` + `GITHUB_REPO_NAME` (or the joined `GITHUB_REPO="owner/repo"`)
- `N8N_API_KEY`, `N8N_BASE_URL`
- Optional: `DRY_RUN=1` to render substituted JSONs to `/tmp` without calling n8n

```bash
# Load .env into the current shell
set -a; source .env; set +a

# Preview what would be sent
DRY_RUN=1 ./scripts/install-workflows.sh

# Import for real
./scripts/install-workflows.sh
```

**What it does:**

1. Validates every required env var is set (exits non-zero with a clear message if not).
2. Renders each `workflows/W*.json` with token substitutions into a tmp file.
3. Refuses to continue if any `{{PLACEHOLDER}}` is still present in the rendered file.
4. Extracts `{name, nodes, connections, settings}` via `jq`.
5. POSTs to `${N8N_BASE_URL}/api/v1/workflows` with `X-N8N-API-KEY` auth.
6. Prints the created workflow IDs + names and the activation order (`W1 → W3 → W2`).

The workflows are imported **inactive**. You activate them manually in the n8n UI
(see step 13) — there is no `--activate` flag.

### Credentials in n8n

The W1/W2/W3 workflow JSONs in this repo have tokens baked into the workflow `Code`
nodes at import time (via the `sed` substitution in step 12). The `Code` nodes read
the baked-in tokens directly — they do NOT reference n8n "Credential" objects for the
three HTTP calls, so you do not need to create `Notion (task-maxxing)` /
`Morgen (task-maxxing)` / `GitHub (task-maxxing)` credential entries in the UI.

If you adapt the workflows to use n8n HTTP Request nodes instead of `Code` nodes
(a common customization), create the credentials like this:

- **Notion API** → name it anything, paste `NOTION_TOKEN`.
- **HTTP Header Auth** (NOT HTTP Bearer Auth) → header name `Authorization`, header
  value `ApiKey {{MORGEN_API_KEY}}`. This is Morgen's required shape — Bearer auth
  returns 401.
- **GitHub API** → PAT = `GITHUB_TOKEN`.

Then bind each HTTP Request node to the corresponding credential in the node editor.

### Set the GitHub webhook (for W1)

1. Open W1 in n8n. Click the **Webhook** trigger node.
2. Copy the **Production URL** (not the Test URL — production is what GitHub will hit).
3. Go to your tasks mirror repo on GitHub → **Settings** → **Webhooks** → **Add webhook**.
4. **Payload URL:** paste the production URL.
5. **Content type:** `application/json`.
6. **Secret:** leave blank (W1 verifies via the commit message prefix, not HMAC).
7. **Which events?** Just the `push` event.
8. **Active:** checked.
9. Click **Add webhook**. You should see a green check next to the webhook entry
   within a few seconds (GitHub sends a ping).

---

## 13. Activate W1, W3, then W2

Order matters. W1 needs to be active before W3 writes anything, and W2 needs to be
last so it can verify the round-trip.

Activation is **manual in the n8n UI** — there is no CLI flag for it (the n8n
public API does not expose a stable "activate workflow" endpoint today, and the
UI handles the trigger-binding side effects correctly).

1. Open n8n in your browser and go to **Workflows**.
2. Click into **W1** (the `Obsidian-Git-Task-Sync` workflow). Toggle **Active** on
   in the top-right. Confirm the githubTrigger webhook URL is reachable from GitHub.
3. Click into **W3** (`Notion-Done-To-Obsidian-Sync`). Toggle **Active** on.
4. Click into **W2** (`Morgen-Task-Completion-Sync`). Toggle **Active** on.

If a workflow refuses to activate, n8n will usually tell you which node is
mis-configured. The common causes are: a credential isn't bound, or the
`githubTrigger` node wasn't able to register the webhook with GitHub (PAT missing
`metadata: read` scope on the mirror repo).

---

## 14. Smoke test

Four scenarios. Run them in order. You should be able to feel the system working.

### Scenario 1: Create in Obsidian → appears in Notion + Morgen

1. In your vault, open `08-Tasks/TASKS-URGENT.md`.
2. Add a new line: `- [ ] task-maxxing smoke test 📅 2099-12-31 ⏫`.
3. Save.
4. Wait 60 seconds.
5. **Check Notion:** a new row with the title "task-maxxing smoke test", priority High,
   due 2099-12-31, area URGENT.
6. **Check Morgen:** a new task in your inbox with the same fields.

**Expected latency:** 30–90s.

**If it doesn't appear:**

- Check the daemon log: `tail -20 ~/Library/Logs/task-maxxing-daemon.log`
- Check the mirror repo on GitHub — the commit should exist.
- Check the W1 execution log in n8n.

### Scenario 2: Complete in Morgen → checks off in Obsidian

1. In Morgen, find your "task-maxxing smoke test" task.
2. Click the checkbox to mark it complete.
3. Wait 60 seconds (W2 is on a 60s cron).
4. **Check the vault:** `- [ ] task-maxxing smoke test ...` should now be `- [x] task-maxxing smoke test ...`.
5. **Check Notion:** Status should now be "Done".

### Scenario 3: Change due date in Notion → updates Obsidian + Morgen

1. In Notion, open the row and change the **Due** date from `2099-12-31` to `2099-11-30`.
2. Wait 60 seconds.
3. **Check the vault:** the markdown should show `📅 2099-11-30`.
4. **Check Morgen:** the task's due date should also be updated.

### Scenario 4: Delete in Obsidian → archives in Notion, deletes in Morgen

1. In the vault, delete the line `- [x] task-maxxing smoke test ...`.
2. Save.
3. Wait 60 seconds.
4. **Check Notion:** the row should be in the Trash (archived).
5. **Check Morgen:** the task should be gone.

If all four scenarios pass, **you have a working task-maxxing install**. Celebrate.

---

## 15. Verify the daemon is pushing

Final sanity check — make sure the daemon is running and actually committing.

```bash
# The daemon should be listed with a PID > 0
launchctl list | grep task-maxxing

# Logs should show recent "auto-commit" / "pushed" lines
tail -20 ~/Library/Logs/task-maxxing.log
```

**Expected log lines** (from the actual `src/auto-commit.js`):

```
[2026-04-14 11:42:01 EDT] auto-commit: TASKS-URGENT.md
[2026-04-14 11:42:03 EDT] pushed successfully
```

The commit message pushed to your mirror repo will start with `[bot:daemon]` —
e.g. `[bot:daemon] auto: task edit 2026-04-14T15:33:01Z`. This prefix is how W1's
echo-loop guard knows to skip re-syncing the push back into Notion/Morgen, so if
you amend the message by hand make sure the `[bot:daemon]` prefix is preserved.

If you see errors here, jump to [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and search
for the error text.

---

## You're done

Day-to-day usage from here is "edit your markdown tasks like you always have". Notion
and Morgen will stay in sync on a 60-90 second cadence.

If you want to tune something or add fields, see [CONTRIBUTING.md](CONTRIBUTING.md)
and [ARCHITECTURE.md](ARCHITECTURE.md).

If something breaks, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

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

**Quick check:**

```bash
node --version   # should print v20.x or higher
git --version    # should print 2.x
gh --version     # should print gh version 2.x
```

If any of those are missing:

```bash
brew install node git gh
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

The file looks like this (values redacted):

```bash
# Notion
NOTION_TOKEN=
NOTION_DB_ID=

# Morgen
MORGEN_API_KEY=
MORGEN_INTEGRATION_ID=task-maxxing

# n8n
N8N_BASE_URL=https://{{YOUR_SUBDOMAIN}}.app.n8n.cloud
N8N_API_KEY=

# GitHub (the tasks mirror)
GITHUB_TOKEN=
GITHUB_OWNER={{YOUR_GH_USERNAME}}
GITHUB_REPO={{YOUR_TASKS_MIRROR_REPO_NAME}}
GITHUB_BRANCH=main

# Local vault
VAULT_PATH={{ABSOLUTE_PATH_TO_VAULT}}
TASKS_SUBDIR=08-Tasks
```

Leave it open — you'll come back to it several times.

---

## 3. Create the Notion integration

1. Open [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations) in your browser.
2. Click **+ New integration**.
3. Give it a name: `task-maxxing` (exact name doesn't matter but pick something you'll
   recognize).
4. Pick the workspace you want the Tasks database in.
5. Click **Save**.
6. On the next screen, scroll to **Internal Integration Secret** and click **Show**,
   then **Copy**. This is your `NOTION_TOKEN`.
7. Paste it into `.env`:

   ```bash
   NOTION_TOKEN=secret_{{YOUR_NOTION_TOKEN}}
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
   NOTION_DB_ID={{32_CHAR_ID}}
   ```

   *(Dashes are optional — task-maxxing normalizes them.)*

> *Screenshot placeholder: `docs/images/notion-db-columns.png`*

---

## 5. Get your Morgen API key

1. Open [https://platform.morgen.so/integrations/developers-api](https://platform.morgen.so/integrations/developers-api) in your browser.
2. Sign in with your Morgen account.
3. You should see a **Developer API** panel. If you don't have an API key yet, click
   **Create API key**. Give it a name like `task-maxxing`.
4. Copy the key (it starts with `morgen_` typically). Paste into `.env`:

   ```bash
   MORGEN_API_KEY=morgen_{{YOUR_KEY}}
   ```

5. Leave `MORGEN_INTEGRATION_ID=task-maxxing` as the default. This is the string we'll
   stamp onto every task task-maxxing creates, so W2 can filter out tasks from other
   integrations.

**Quick sanity check** — this should return your task list:

```bash
curl -sS \
  -H "Authorization: Bearer $(grep MORGEN_API_KEY .env | cut -d= -f2)" \
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

Paste the owner and repo into `.env`:

```bash
GITHUB_OWNER={{YOUR_GH_USERNAME}}
GITHUB_REPO={{YOUR_VAULT_NAME}}-tasks
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

The daemon watches your vault's `08-Tasks/` folder, runs the parser, and pushes to the
mirror. It runs under launchd on macOS so it auto-starts on login and restarts on
crash.

**Fill in the remaining env vars first:**

```bash
cd ~/Desktop/task-maxxing   # back into the cloned repo

# Edit .env and set VAULT_PATH to your Obsidian vault's absolute path
# Example: VAULT_PATH=/Users/{{YOUR_USERNAME}}/Desktop/WORK/OBSIDIAN/2ndBrain
$EDITOR .env
```

Now run the installer. It's interactive — it'll confirm paths with you before writing
anything.

```bash
./src/install.sh
```

**What it does:**

1. Reads `.env` and validates that every variable is set.
2. Prompts you to confirm the vault path (`VAULT_PATH`) and the tasks subdir (`TASKS_SUBDIR`).
3. Builds a macOS `.app` bundle at `~/Applications/task-maxxing-daemon.app` wrapping
   `src/auto-commit.js`.
   (Why an `.app` bundle? macOS Full Disk Access only applies to `.app`-wrapped
   executables. A bare Node script can't be granted FDA.)
4. Writes a launchd plist to
   `~/Library/LaunchAgents/io.{{YOUR_ORG_OR_NAME}}.task-maxxing-daemon.plist` (based on
   `daemon/io.example.task-maxxing-daemon.plist.template`).
5. Prints a "next steps" message telling you to grant FDA (which is the next section).

**Do not load the plist yet.** Grant FDA first, or the daemon will crash on its first
file read.

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
4. Navigate to `~/Applications/task-maxxing-daemon.app` and select it.
5. Make sure the toggle next to it is **ON** (green).

> *Screenshot placeholder: `docs/images/macos-fda-grant.png`*

**Now load the daemon:**

```bash
launchctl load ~/Library/LaunchAgents/io.{{YOUR_ORG_OR_NAME}}.task-maxxing-daemon.plist
```

**Check it's running:**

```bash
launchctl list | grep task-maxxing
```

**Expected output:** one line with a PID (a positive integer), not `-` (which means
crashed). If you see `-` in the first column, check:

```bash
tail -50 ~/Library/Logs/task-maxxing-daemon.log
```

If FDA is not granted, you'll see `EPERM` errors. Re-check step 10.1–10.5.

---

## 11. Run the backfill script

The first time you run task-maxxing, there are no task IDs anywhere. The backfill
script walks your vault, parses every task, builds an initial `.sync-state.json`, and
pushes it to the mirror.

```bash
cd ~/Desktop/task-maxxing
node scripts/morgen-backfill.js --dry-run
```

**Expected output:**

```
Parsing 08-Tasks/TASKS-URGENT.md...  12 tasks
Parsing 08-Tasks/TASKS-LORECRAFT.md...  7 tasks
...
Total: 47 tasks parsed.
Morgen backfill: would create 47 tasks.
Notion backfill: would create 47 pages.
sync-state.json: would write 47 entries.
Dry run. No changes made.
```

If the numbers look right, drop `--dry-run` and run for real:

```bash
node scripts/morgen-backfill.js
```

This will:

1. Create a Morgen task for every task in your markdown (rate-limited).
2. Create a Notion page for every task (rate-limited).
3. Write the initial `.sync-state.json` to the mirror repo.
4. Git-push the mirror.

**Expected runtime:** 30–90 seconds for a typical backlog of <100 tasks.

> If you're on Morgen's free tier you'll hit 403s. That's the point at which you
> upgrade to Pro — it's a one-time cost and doesn't recur per user.

---

## 12. Import the n8n workflows

The `scripts/install-workflows.sh` script POSTs the three workflow JSON files to your
n8n instance via the API, sets up the webhook URLs, and binds credentials.

```bash
./scripts/install-workflows.sh
```

**What it does:**

1. Reads `N8N_BASE_URL` and `N8N_API_KEY` from `.env`.
2. For each workflow in `workflows/`:
   - `POST /rest/workflows` with the JSON.
   - Captures the new workflow ID.
3. Tells you which credential slots you need to fill in via the n8n UI.

**Expected output:**

```
Importing W1-obsidian-git-task-sync.json... workflow id: {{W1_WORKFLOW_ID}}
Importing W2-morgen-task-completion-sync.json... workflow id: {{W2_WORKFLOW_ID}}
Importing W3-notion-done-to-obsidian-sync.json... workflow id: {{W3_WORKFLOW_ID}}

Next steps:
  1. Open your n8n workflows list.
  2. For each imported workflow, click into it and check the credential slots.
     You'll need:
       - "Notion (task-maxxing)"     — API key = NOTION_TOKEN
       - "Morgen (task-maxxing)"     — API key = MORGEN_API_KEY
       - "GitHub (task-maxxing)"     — PAT     = GITHUB_TOKEN
  3. Save each workflow.
  4. Come back and run `./scripts/install-workflows.sh --activate` to turn them on.
```

### Create credentials in n8n

1. Open n8n in your browser.
2. Go to **Credentials** (left sidebar).
3. Click **+ Add credential**.
4. Create three credentials:
   - **Notion API** — name `Notion (task-maxxing)`, paste `NOTION_TOKEN`.
   - **HTTP Bearer Auth** — name `Morgen (task-maxxing)`, token = `MORGEN_API_KEY`.
   - **GitHub API** — name `GitHub (task-maxxing)`, PAT = `GITHUB_TOKEN`.
5. Open each workflow. Each HTTP-request node should already be pointing at the
   correct credential slot name. If it isn't, the node will glow red — click and
   pick the credential from the dropdown.

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

```bash
./scripts/install-workflows.sh --activate
```

**Expected output:**

```
Activating W1 (id={{W1_WORKFLOW_ID}})... ok
Activating W3 (id={{W3_WORKFLOW_ID}})... ok
Activating W2 (id={{W2_WORKFLOW_ID}})... ok

All three workflows active. Run a smoke test next — see docs/SETUP.md section 14.
```

If a workflow fails to activate, the error message is usually "no active trigger".
That means a credential isn't bound. Fix it in the UI and re-run.

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

# Logs should show recent "committed" lines
tail -20 ~/Library/Logs/task-maxxing-daemon.log
```

**Expected log lines:**

```
[daemon] watching /Users/.../2ndBrain/08-Tasks
[daemon] debounced: 3 files changed
[daemon] parsed 47 tasks, 2 created, 1 updated, 0 deleted
[daemon] committed [bot:daemon] 2026-04-14T15:33:01Z
[daemon] pushed to origin/main
```

If you see errors here, jump to [TROUBLESHOOTING.md](TROUBLESHOOTING.md) and search
for the error text.

---

## You're done

Day-to-day usage from here is "edit your markdown tasks like you always have". Notion
and Morgen will stay in sync on a 60-90 second cadence.

If you want to tune something or add fields, see [CONTRIBUTING.md](CONTRIBUTING.md)
and [ARCHITECTURE.md](ARCHITECTURE.md).

If something breaks, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

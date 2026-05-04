# Workflows

> [!NOTE]
> **2026-05-04 cutover:** This is now a two-workflow setup (W2 + W1)
> orchestrated by W0. The W3 (Notion → Obsidian) workflow has been removed
> from the kit. See [`../CHANGELOG.md`](../CHANGELOG.md).

n8n workflow JSON exports for the two sync paths. Import these into your
n8n instance via `../scripts/install-workflows.sh` (preferred) or manually.

## Files

| File                                         | Purpose                                                                          |
|----------------------------------------------|----------------------------------------------------------------------------------|
| `W1-obsidian-git-task-sync.json`             | Obsidian → Notion/Morgen. Runs on GitHub push webhook (triggered by the daemon). |
| `W2-morgen-task-completion-sync.json`        | Morgen → Obsidian/Notion. Polls Morgen every 15 min and applies completions.     |
| `W3-notion-done-to-obsidian-sync.json`       | Notion → Obsidian/Morgen. Polls Notion every 15 min for "Done" flips.            |

All three inline the same canonical logic from `src/sync-helpers.js` inside
their Code nodes — the source library is the `sync-helpers.js` file in this
repo, and the workflows are kept in sync with it manually.

## Placeholders

Every workflow ships with placeholder tokens instead of real credentials:

| Placeholder             | What it becomes                                                  |
|-------------------------|------------------------------------------------------------------|
| `{{GITHUB_TOKEN}}`       | `Bearer <your-github-oauth-or-pat>` used for GitHub API calls.  |
| `{{NOTION_TOKEN}}`       | `Bearer ntn_…` from your Notion internal integration.           |
| `{{MORGEN_KEY}}`         | `ApiKey …` from your Morgen API settings.                        |
| `{{NOTION_DATABASE_ID}}` | Your Notion tasks database ID (with or without dashes).         |
| `{{GITHUB_REPO}}`        | `<owner>/<repo>` of the repo n8n watches for pushes.             |
| `{{GITHUB_OWNER}}`       | Just `<owner>` — used by the GitHub trigger parameters (W1).     |
| `{{GITHUB_REPO_NAME}}`   | Just `<repo>` — used by the GitHub trigger parameters (W1).     |

`scripts/install-workflows.sh` substitutes all of these from env vars and
POSTs the result to the n8n public API.

## Automated import

```bash
export GITHUB_TOKEN=gho_xxx            # or ghp_… / fine-grained PAT
export NOTION_TOKEN=ntn_xxx
export MORGEN_KEY=xxx
export NOTION_DATABASE_ID=00000000-0000-0000-0000-000000000000
export GITHUB_REPO=yourname/your-vault-tasks-repo
export N8N_API_KEY=eyJhbGciOi…
export N8N_BASE_URL=https://your-tenant.app.n8n.cloud   # optional
bash scripts/install-workflows.sh
```

The script prints the three created workflow IDs at the end. Activate them
in the n8n UI in the order **W1 → W3 → W2**.

## Manual import (fallback)

1. Render placeholders yourself (or use `scripts/install-workflows.sh` with
   `DRY_RUN=1` and grab the temp files from `/tmp`).
2. In the n8n UI, click **Import from File** in the Workflows view.
3. Open each rendered JSON one at a time.
4. For each imported workflow, open the Code node(s) and confirm the
   `__AUTH_*` constants now contain real tokens, then activate.

## Why this order (W1 → W3 → W2)?

- **W1** is the fast Obsidian→external path. Activate it first so new edits
  in your vault start flowing immediately.
- **W3** is the Notion→Obsidian reverse guard. Activate second so tasks
  completed in Notion get mirrored back before the slow Morgen poller runs.
- **W2** is the Morgen→Obsidian/Notion completion sweeper. It's the least
  time-sensitive and runs a poll every 15 minutes; activating it last lets
  the other two stabilize first.

## Safety

- None of the committed JSON contains real tokens, real Notion DB IDs, or
  real GitHub repo names. The sanitizer replaces all three before commit.
- The install script writes rendered files to `/tmp` and deletes them on
  success. A failed run may leave temp files — they are named
  `/tmp/W{1,2,3}.rendered.*.json` and `/tmp/W{1,2,3}.clean.*.json`.

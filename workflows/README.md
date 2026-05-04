# Workflows

> [!NOTE]
> **2026-05-04 cutover:** This is now a two-workflow setup (W1 + W2)
> sequenced by the W0 orchestrator. The W3 (Notion → Obsidian) workflow
> has been removed from the kit. See [`../CHANGELOG.md`](../CHANGELOG.md).

n8n workflow JSON exports for the two sync paths plus the orchestrator
that sequences them. Import these into your n8n instance via
`../scripts/install-workflows.sh` (preferred) or manually.

## Files

| File                                          | Purpose                                                                               |
|-----------------------------------------------|---------------------------------------------------------------------------------------|
| `W0-orchestrator-sync-sequencer.json`         | Sequences W2 → W1 every 20 min via `executeWorkflow(wait=true)`. The only one you activate. |
| `W1-obsidian-git-task-sync.json`              | Obsidian → Morgen. GitHub-push trigger present but dormant; W0 invokes it directly.   |
| `W2-morgen-task-completion-sync.json`         | Morgen → Obsidian. Polls Morgen, commits closed/created tasks back to the markdown.   |

W1 and W2 inline the same canonical logic from `src/sync-helpers.js`
inside their Code nodes — the source library is the `sync-helpers.js`
file in this repo, and the workflows are kept in sync with it manually.

The W3 (`Notion-Done-To-Obsidian-Sync`) workflow is no longer shipped.
The kit author's own n8n instance still has a W3 entry as an archived
no-op stub returning `{ok:true, skipped:'notion-dropped-2026-05-04'}` —
it is not part of any orchestrator graph and is not imported by
`install-workflows.sh`. Fresh installs simply do not get a W3.

## Placeholders

Every workflow ships with placeholder tokens instead of real credentials:

| Placeholder             | What it becomes                                                  |
|-------------------------|------------------------------------------------------------------|
| `{{GITHUB_TOKEN}}`       | `Bearer <your-github-oauth-or-pat>` used for GitHub API calls.  |
| `{{MORGEN_KEY}}`         | `ApiKey …` from your Morgen API settings.                        |
| `{{GITHUB_REPO}}`        | `<owner>/<repo>` of the repo n8n watches for pushes.             |
| `{{GITHUB_OWNER}}`       | Just `<owner>` — used by the GitHub trigger parameters (W1).     |
| `{{GITHUB_REPO_NAME}}`   | Just `<repo>` — used by the GitHub trigger parameters (W1).     |
| `{{W1_WORKFLOW_ID}}`     | n8n workflow ID for W1 — substituted into W0 after import.       |
| `{{W2_WORKFLOW_ID}}`     | n8n workflow ID for W2 — substituted into W0 after import.       |

`scripts/install-workflows.sh` substitutes all of these from env vars
and POSTs the result to the n8n public API. It also captures the
n8n-assigned IDs for W1/W2 and templates them into W0 before posting
the orchestrator last.

> Pre-2026-05-04 installs also referenced `{{NOTION_TOKEN}}` and
> `{{NOTION_DATABASE_ID}}`. Those placeholders are gone from the
> shipped JSON — leave the corresponding env vars unset on fresh
> installs (the `examples/sample-.env.example` keeps them as
> commented-out deprecated entries for back-compat clarity).

## Automated import

```bash
export GITHUB_TOKEN=gho_xxx            # or ghp_… / fine-grained PAT
export MORGEN_KEY=xxx
export GITHUB_REPO_OWNER=yourname
export GITHUB_REPO_NAME=your-vault-tasks-repo
export N8N_API_KEY=eyJhbGciOi…
export N8N_BASE_URL=https://your-tenant.app.n8n.cloud
bash scripts/install-workflows.sh
```

The script prints the created workflow IDs at the end. Activate ONLY
the **W0-Sync-Orchestrator** in the n8n UI. Leave W1/W2 inactive — the
orchestrator triggers them via `executeWorkflow` so they never race on
`.sync-state.json`.

## Manual import (fallback)

1. Render placeholders yourself (or use `scripts/install-workflows.sh`
   with `DRY_RUN=1` and grab the temp files from `$TMPDIR`).
2. In the n8n UI, click **Import from File** in the Workflows view.
3. Open each rendered JSON one at a time. Import W1 and W2 first, note
   the IDs n8n assigns, paste them into the W0 placeholders, then
   import W0 last.
4. For each imported workflow, open the Code node(s) and confirm the
   `__AUTH_*` constants now contain real tokens, then activate W0
   (only).

## Optional: Sync-Health-Watchdog

A separate hourly watchdog workflow that opens a GitHub issue if no
`[bot:W1]` commit has landed in the last 60 minutes is documented in
`docs/SETUP.md` (Step 9) and `docs/ARCHITECTURE.md`
(Sync-Health-Watchdog). It is not imported by `install-workflows.sh`
because it is opt-in and its alerting destinations (GitHub, optional
Telegram) vary per user. Build it from the snippets in those docs.

## Safety

- None of the committed JSON contains real tokens or real GitHub repo
  names. The sanitizer replaces all of them before commit, and CI greps
  the rendered workflows for hardcoded secret shapes
  (`ghp_…`, `ntn_…`, `sk-…`, `ApiKey …`).
- The install script writes rendered files to `$TMPDIR` and deletes
  them on success. A failed run may leave temp files — they are named
  `W{0,1,2}.rendered.*.json` and `W{0,1,2}.clean.*.json`.

# Changelog

All notable changes to `task-maxxing` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2026-05-04

### Removed (BREAKING)
- **Notion is dropped from the kit.** The W3 workflow (Notion → Obsidian) and `notion/tasks-db-schema.md` have been deleted. The W1 workflow no longer makes Notion API calls — its `Code` node is renamed `Parse + Sync to Morgen` and the `notionApi` credential branch is now a tripwire that throws if anything reaches it.
- W0 orchestrator: rewired from `Every 15m → W2 → W3 → W1` to `Every 20m → W2 → W1`. The W3 step is gone.
- `examples/sample-sync-state.json`: every `notionPageId` is `null`. The field is preserved as nullable on each entry for backward-compat with pre-cutover entries; no code path reads or writes it post-cutover.
- `examples/sample-.env.example`: `NOTION_TOKEN` and `NOTION_DATABASE_ID` are commented as deprecated. Leave them unset on fresh installs.
- README: tagline + workflow table + project tree updated 3-way → 2-way. A top-of-README NOTE banner explains the cutover.

### Why
- Kit author's own instance (`obsidian-tasks-sync`) dropped Notion on the same date after the Notion bearer in W1+W3 was found to be silently 401-ing on every orchestrator tick. Morgen and Obsidian had become the only legs that mattered. The full investigation is in the kit author's vault under `05-Projects/LAVA-NET/invoices/2026-05-04-morgen-task-creation-and-sync-diagnosis.md` and the cutover memory at `project_notion_drop_2026_05_04.md`.

### Added
- README: social-links badge strip (X · LinkedIn · YouTube · Instagram, ruvnet-style for-the-badge) inserted into the centered header block beneath the project license badge.
- **Sync-Health-Watchdog (optional 4th workflow).** Hourly check that the orchestrator is actually committing — opens a GitHub issue (and optional Telegram ping) if no `[bot:W1]` commit lands within `STALE_MINUTES` (default 60). Documented in `docs/ARCHITECTURE.md` and `docs/SETUP.md` Step 9. Not imported by `scripts/install-workflows.sh` because alert destinations vary per user. The kit author's own instance has it as workflow ID `mzpCCbqD1MvxJhAm`.
- Four canonical docs rewritten end-to-end for the 2-way state: `docs/SETUP.md` (`a5cce71`), `docs/ARCHITECTURE.md` (`43f4df3`), `docs/TROUBLESHOOTING.md` (`6b224a3`), `docs/DESIGN-RATIONALE.md` (`c44fef7`).

### Changed
- **Orchestrator workflow renamed.** The orchestrator is now `W0-Sync-Orchestrator` everywhere in the kit. Pre-cutover installs (and pre-tonight installs) had it named `W2-3-1-Sync-Orchestrator` after the original W2 → W3 → W1 sequence. The kit author's own n8n instance was renamed tonight (workflow ID unchanged: `WJig0XZ7NV1pCa8e`). Existing-user migration notes in `README.md` and `docs/SETUP.md` already reference the old name so upgraders can find their old workflow to delete.
- Git history rewrite: `git filter-repo` collapsed all author/committer identities (dependabot[bot], Agent 13, lorecraft-io, fidgetcoding variants) into a single `Nate Davidovich <nate@lorecraft.io>` identity across `main`. All `Co-authored-by:` trailers stripped. This repo has no release tags and no published npm artifact, so no downstream impact.
- `package.json` description: `Perfect task sync between Obsidian, Notion, and Morgen` → `Two-way task sync between Obsidian and Morgen`.
- `daemon/README.md`, `src/auto-commit.js` echo-loop comment, `examples/sample-.env.example` GitHub-PAT scope notes, `workflows/README.md`, and `docs/CONTRIBUTING.md`: all stripped of live-state Notion references. Migration / historical notes are preserved verbatim where they help upgraders.
- `.github/workflows/validate.yml` `install-workflows DRY_RUN smoke` step: dropped unused `NOTION_TOKEN` and `NOTION_DATABASE_ID` env vars (the installer has not consumed them since the cutover).

## [0.1.0] - 2026-04-20 (untagged)

### Added — Initial public release

`task-maxxing` is the DIY kit for the three-way task sync between Obsidian (`06-Tasks/`), Notion, and Morgen. It assumes `2ndBrain-mogging` is installed first (the vault is the source of truth for the `06-Tasks/` folder this kit syncs).

- **W0 sync orchestrator** (`W0-orchestrator-sync-sequencer.json`) — n8n workflow that sequences W2 → W3 → W1 via `executeWorkflow(wait=true)` every 15 min. Solves the `.sync-state.json` race per `[[project_w231_orchestrator]]`. The only workflow users need to activate.
- **`scripts/install-workflows.sh`** — installs all four workflow JSONs via the n8n API; captures created IDs and substitutes them into the W0 placeholders. macOS BSD `mktemp` bug fixed; `SKIP_ORCHESTRATOR=1` escape hatch supported.
- **`scripts/validate-workflows.js`** — CI gate for the workflow JSONs (W0 placeholders allowlisted via the `parameters.workflowId` regex).
- **CI** (`.github/workflows/validate.yml`) — `bash -n` syntax check, shellcheck (pinned `00cae500`), `node --check`, and full DRY_RUN smoke on every push/PR.
- **README** — maxxing-series footer block + "Using these tools outside the sync" section + n8n MCP attribution + W1-webhook trade-off callout + W0 self-overlap quirk + existing-users migration note + 2ndBrain-mogging prerequisite warning.
- **`docs/`** — sync-helpers reference, daemon installation, sync state architecture.
- **`examples/`** — sample task entries demonstrating Obsidian Tasks plugin syntax + UUID preservation.

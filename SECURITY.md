# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email: nate@lorecraft.io
3. Include: description of the vulnerability, steps to reproduce, and potential impact.
4. You will receive acknowledgment within 48 hours.

## Credential Model

`task-maxxing` stitches together four services. Each has its own credential, each stored in a **local** `.env` file (gitignored, `chmod 600` recommended):

| Credential | Grants | Rotation |
|------------|--------|----------|
| `GITHUB_TOKEN` | Read/write to the private task-mirror repo | GitHub → Settings → Developer settings → Fine-grained PATs |
| `NOTION_TOKEN` | Read/write to the Notion Tasks database you shared with the integration | Notion → My integrations → rotate secret |
| `MORGEN_API_KEY` | Full access to your Morgen calendar + tasks | https://platform.morgen.so/developers-api |
| `N8N_API_KEY` | Full access to your n8n instance (create / edit / activate workflows) | n8n UI → Settings → API → rotate |

**`.mcp.json` / `claude_desktop_config.json` are NOT used** by this project — the workflows run in n8n and read credentials from n8n's credential store after the initial `install-workflows.sh` substitution.

**If you suspect any credential has been compromised:**

1. Rotate the credential at its source (links above).
2. Update the value in your local `.env` file.
3. Re-run `./scripts/install-workflows.sh` to push the new credential into n8n.
4. In the n8n UI, deactivate and reactivate W1 / W2 / W3 so their credential references refresh.

## Scope

- Source code in this repository
- n8n workflow JSON exports under `workflows/`
- The local daemon (`src/auto-commit.js` + `daemon/install-daemon.sh`)
- GitHub Actions workflows under `.github/workflows/`

Out of scope: your personal fork of this repo (`YOUR-VAULT-tasks`), your n8n instance, and any third-party services (Notion, Morgen, GitHub) that this project integrates with — please report issues in those systems to the upstream vendor.

## Defense in Depth

- **No secrets at rest in the repo.** Workflow JSONs use `{{PLACEHOLDER}}` tokens substituted at install time by `scripts/install-workflows.sh`. The rendered files go to `/tmp/`, are POSTed to n8n, then deleted.
- **CI grep guards.** `.github/workflows/validate.yml` scans workflow JSONs on every push for hardcoded token shapes (`ghp_`, `ntn_`, `sk-`, `ApiKey ...`). A PR that accidentally bakes a secret into a committed JSON will fail CI.
- **Bot-prefix echo guard.** Every automated commit carries a `[bot:daemon]` / `[bot:W1]` / `[bot:W2]` / `[bot:W3]` / `[bot:backfill]` prefix so W1's webhook handler can skip them and avoid an infinite ping-pong.
- **Flip-ratio guard.** W1 and W3 refuse to proceed if a single run would flip >25% (W1) / >30% (W3) of your task state. This catches "I accidentally deleted TASKS-URGENT.md" before it replicates to Notion + Morgen.

## Known Limitations

- The daemon shells out to `git` via `execFileSync`. A hostile `$PATH` could swap out `git` for a malicious binary — the installer hardens `PATH` to well-known system locations (`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`), but if you install the daemon in an environment with a compromised `$PATH` at that moment, that hardening won't help.
- Morgen's API does not expose webhook notifications — W2 polls on a 60s cron. An attacker who compromises your Morgen account has a ≤60s window before W2 propagates the change to Obsidian + Notion.

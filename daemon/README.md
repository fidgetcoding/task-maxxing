# task-maxxing daemon

A macOS LaunchAgent that watches your Obsidian vault's `06-Tasks/` directory
and auto-commits + pushes every change to a git remote. Used as the trigger
for workflow W1 (Obsidian → Notion/Morgen).

## What this does

1. launchd runs `src/auto-commit.js` under Node whenever a file changes
   inside your watch path, throttled to at most once every 30s and at least
   once every 5 minutes.
2. The script runs `git add -A && git commit -m "auto: task edit …" && git push`.
3. The push to GitHub triggers an n8n `githubTrigger` webhook (workflow W1),
   which parses your task files and mirrors them into Notion and Morgen.

## Why Plan B (wrapper `.app` bundle)?

The first version of this daemon used a bash script. On macOS that means
granting **Full Disk Access** to `/bin/bash` — which transitively grants
FDA to every bash script you ever run, forever. That's unacceptable.

Plan B: install a tiny `.app` bundle that wraps your Node binary. macOS TCC
identifies binaries by bundle identity, so FDA on this bundle applies only
to this one daemon. The launchd plist points at the bundle's binary, and
launchd invokes the script through it.

This is what `install-daemon.sh` sets up for you.

## Prerequisites

- macOS (launchd is a macOS feature).
- Node 18+ in your PATH (or set `NODE_BIN=/absolute/path/to/node`).
- A local git clone of your vault (the `06-Tasks` dir must be a git repo,
  or be inside one).
- A passwordless git remote. The daemon runs headless — it cannot answer
  SSH passphrase prompts. Use one of:
    - `gh auth login` (recommended) with HTTPS.
    - An SSH key that's loaded into your agent (`ssh-add`).
    - A PAT stored in the macOS keychain via `git credential-osxkeychain`.

## Install

```bash
BUNDLE_ID=io.example.task-maxxing-daemon \
WATCH_PATH="$HOME/path/to/vault/06-Tasks" \
SCRIPT_PATH="$HOME/code/task-maxxing/src/auto-commit.js" \
  bash daemon/install-daemon.sh
```

Required env vars:

| Variable      | Purpose                                                                |
|---------------|------------------------------------------------------------------------|
| `BUNDLE_ID`   | Reverse-DNS label for the launchd agent + Info.plist identifier.       |
| `WATCH_PATH`  | Absolute path to the directory launchd should watch (your 06-Tasks).   |
| `SCRIPT_PATH` | Absolute path to `src/auto-commit.js` from this repo clone.            |

Optional env vars:

| Variable          | Default                                                     | Purpose                                |
|-------------------|-------------------------------------------------------------|----------------------------------------|
| `NODE_BIN`        | `$(command -v node)`                                        | Which Node binary to wrap.             |
| `APP_SUPPORT_DIR` | `$HOME/Library/Application Support/task-maxxing`            | Where the wrapper `.app` is installed. |
| `LOG_DIR`         | `$HOME/Library/Logs`                                        | Where launchd stdout/stderr go.        |

The installer will:

1. Copy your Node binary into `~/Library/Application Support/task-maxxing/TaskMaxxingDaemon.app/Contents/MacOS/TaskMaxxingDaemon`.
2. Write an `Info.plist` for the bundle.
3. Render `io.example.task-maxxing-daemon.plist.template` → `~/Library/LaunchAgents/${BUNDLE_ID}.plist`.
4. Lint the plist with `plutil`.
5. Load it via `launchctl bootstrap gui/$(id -u) …`.
6. Print the Full Disk Access walkthrough.

## Full Disk Access walkthrough

After the installer finishes, macOS will block the daemon from reading
anything under `~/Desktop`, `~/Documents`, iCloud Drive, etc. Grant FDA:

1. **Open** System Settings -> Privacy & Security -> Full Disk Access.
2. Click **+**.
3. Press **Cmd+Shift+G** to bring up "Go to folder".
4. Paste the path to the bundle the installer printed (something like
   `~/Library/Application Support/task-maxxing/TaskMaxxingDaemon.app`).
5. Select it and click **Open**.
6. **Toggle the entry ON**.
7. Reload the agent so launchctl picks up the new permission:

   ```bash
   launchctl bootout  "gui/$(id -u)/${BUNDLE_ID}"
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
   ```

## Verify it works

```bash
# Watch the log.
tail -f "$HOME/Library/Logs/task-maxxing.log"

# Touch a tracked file in the watch path.
touch "$WATCH_PATH/README.md"
```

Within 30s (the `ThrottleInterval`) you should see:

```
[2026-04-14 11:42:01 EDT] auto-commit: README.md
[2026-04-14 11:42:03 EDT] pushed successfully
```

If you see a `FATAL: cannot read …/.git/HEAD` line, FDA isn't actually
granted to the bundle — re-check steps 4–6 above. The log line includes
the exact path to the Node binary you need to grant FDA to (it's inside
the bundle's `Contents/MacOS/`).

## Uninstall

```bash
BUNDLE_ID=io.example.task-maxxing-daemon
launchctl bootout "gui/$(id -u)/${BUNDLE_ID}" || true
rm -f "$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"
rm -rf "$HOME/Library/Application Support/task-maxxing"
```

Then remove the bundle entry from System Settings -> Privacy & Security ->
Full Disk Access.

## Troubleshooting

- **Nothing commits, log is empty** — launchd probably refused to load the
  plist. Check `launchctl print gui/$(id -u)/${BUNDLE_ID}` and
  `log show --predicate 'subsystem == "com.apple.xpc.launchd"' --last 10m`.
- **Commits happen but push fails** — the log will say `push failed — will
  retry next tick: …`. Usually a credential issue; try running
  `git -C "$WATCH_PATH" push origin main` from your terminal and see what
  credential prompt appears.
- **Heartbeat log is quiet** — the daemon isn't firing. Check
  `StartInterval` and `WatchPaths` in the installed plist with
  `plutil -p "$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"`.

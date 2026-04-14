#!/usr/bin/env bash
#
# install-daemon.sh — create the task-maxxing launchd agent on macOS.
#
# What it does:
#   1. Wraps your Node binary in a tiny .app bundle (Plan B) so macOS Full
#      Disk Access can be granted narrowly — to this .app only — instead of
#      to /bin/bash or the system-wide node binary.
#   2. Substitutes placeholders in io.example.task-maxxing-daemon.plist.template
#      from the env vars listed below.
#   3. Copies the filled plist into ~/Library/LaunchAgents/.
#   4. Loads the agent via `launchctl bootstrap`.
#   5. Prints the Full Disk Access walkthrough.
#
# Required env vars:
#   BUNDLE_ID        Reverse-DNS label (e.g. io.example.task-maxxing-daemon)
#   WATCH_PATH       Absolute path to your vault's 08-Tasks dir (the git repo to commit)
#   SCRIPT_PATH      Absolute path to src/auto-commit.js in your clone of this repo
#
# Optional env vars:
#   NODE_BIN         Path to your Node binary (default: `command -v node`)
#   APP_SUPPORT_DIR  Where to install the .app bundle
#                    (default: "$HOME/Library/Application Support/task-maxxing")
#   LOG_DIR          Where to put stdout/stderr logs
#                    (default: "$HOME/Library/Logs")
#
# Usage:
#   BUNDLE_ID=io.example.task-maxxing-daemon \
#   WATCH_PATH="$HOME/path/to/vault/08-Tasks" \
#   SCRIPT_PATH="$HOME/code/task-maxxing/src/auto-commit.js" \
#     bash daemon/install-daemon.sh

set -euo pipefail

: "${BUNDLE_ID:?BUNDLE_ID env var required (e.g. io.example.task-maxxing-daemon)}"
: "${WATCH_PATH:?WATCH_PATH env var required (absolute path to your 08-Tasks dir)}"
: "${SCRIPT_PATH:?SCRIPT_PATH env var required (absolute path to src/auto-commit.js)}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "[install-daemon] ERROR: Node binary not found. Set NODE_BIN or install node." >&2
  exit 1
fi

APP_SUPPORT_DIR="${APP_SUPPORT_DIR:-$HOME/Library/Application Support/task-maxxing}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

APP_NAME="TaskMaxxingDaemon"
APP_BUNDLE="${APP_SUPPORT_DIR}/${APP_NAME}.app"
APP_MACOS_DIR="${APP_BUNDLE}/Contents/MacOS"
NODE_APP_PATH="${APP_MACOS_DIR}/${APP_NAME}"

LOG_STDOUT="${LOG_DIR}/task-maxxing.stdout.log"
LOG_STDERR="${LOG_DIR}/task-maxxing.stderr.log"

PLIST_FILENAME="${BUNDLE_ID}.plist"
PLIST_TEMPLATE="$(cd "$(dirname "$0")" && pwd)/io.example.task-maxxing-daemon.plist.template"
PLIST_DEST="${LAUNCH_AGENTS_DIR}/${PLIST_FILENAME}"

if [[ ! -f "${PLIST_TEMPLATE}" ]]; then
  echo "[install-daemon] ERROR: template not found: ${PLIST_TEMPLATE}" >&2
  exit 1
fi

mkdir -p "${APP_MACOS_DIR}" "${LOG_DIR}" "${LAUNCH_AGENTS_DIR}"

# --- Step 1: build the .app bundle around the real Node binary -----------------
echo "[install-daemon] creating ${APP_BUNDLE}"
cp -f "${NODE_BIN}" "${NODE_APP_PATH}"
chmod +x "${NODE_APP_PATH}"

cat > "${APP_BUNDLE}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSBackgroundOnly</key>
  <true/>
</dict>
</plist>
PLIST

# --- Step 2: render the launchd plist from the template ------------------------
echo "[install-daemon] rendering ${PLIST_DEST}"

escape_sed() {
  printf '%s' "$1" | sed -e 's/[&/|]/\\&/g'
}

tmp_plist="$(mktemp)"
sed \
  -e "s|{{BUNDLE_ID}}|$(escape_sed "${BUNDLE_ID}")|g" \
  -e "s|{{NODE_APP_PATH}}|$(escape_sed "${NODE_APP_PATH}")|g" \
  -e "s|{{SCRIPT_PATH}}|$(escape_sed "${SCRIPT_PATH}")|g" \
  -e "s|{{WATCH_PATH}}|$(escape_sed "${WATCH_PATH}")|g" \
  -e "s|{{LOG_STDOUT}}|$(escape_sed "${LOG_STDOUT}")|g" \
  -e "s|{{LOG_STDERR}}|$(escape_sed "${LOG_STDERR}")|g" \
  -e "s|{{HOME}}|$(escape_sed "${HOME}")|g" \
  "${PLIST_TEMPLATE}" > "${tmp_plist}"

mv "${tmp_plist}" "${PLIST_DEST}"
chmod 644 "${PLIST_DEST}"

if ! /usr/bin/plutil -lint "${PLIST_DEST}" >/dev/null; then
  echo "[install-daemon] ERROR: plist failed lint: ${PLIST_DEST}" >&2
  exit 1
fi

# --- Step 3: load into launchd -------------------------------------------------
echo "[install-daemon] loading launchd agent"
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "${PLIST_DEST}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "${PLIST_DEST}"
launchctl enable "gui/${UID_NUM}/${BUNDLE_ID}"

echo
echo "[install-daemon] SUCCESS."
echo "  plist       : ${PLIST_DEST}"
echo "  app bundle  : ${APP_BUNDLE}"
echo "  node bin    : ${NODE_APP_PATH}"
echo "  log stdout  : ${LOG_STDOUT}"
echo "  log stderr  : ${LOG_STDERR}"
echo "  watch path  : ${WATCH_PATH}"
echo

cat <<FDA
====================================================================
  NEXT STEP — grant Full Disk Access to the wrapper .app

  macOS will block the daemon from reading anything under ~/Desktop,
  ~/Documents, iCloud, etc. until you grant Full Disk Access to the
  bundle we just created.

  1. Open System Settings -> Privacy & Security -> Full Disk Access.
  2. Click the "+" button.
  3. Press Cmd+Shift+G to bring up "Go to folder".
  4. Paste the .app path printed above (the "app bundle" line).
  5. Select it and click Open.
  6. Toggle the entry ON.
  7. Reload the agent:
       launchctl bootout  "gui/\$(id -u)/${BUNDLE_ID}"
       launchctl bootstrap "gui/\$(id -u)" "\$HOME/Library/LaunchAgents/${BUNDLE_ID}.plist"

  Verify it works:
    tail -f "\$HOME/Library/Logs/task-maxxing.log"
    touch "${WATCH_PATH}/README.md"

  You should see an "auto-commit" log line within 30s, followed by
  "pushed successfully".
====================================================================
FDA

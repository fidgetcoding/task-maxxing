#!/usr/bin/env bash
#
# install-workflows.sh — import W1/W2 + the W0 sync-orchestrator into an
# n8n instance after substituting placeholders with real tokens from env vars.
#
# The orchestrator sequences W2 → W1 every 20 min via executeWorkflow
# (wait=true) so the three sub-workflows never race each other on the shared
# .sync-state.json file. After the script captures real W1/W2 workflow IDs
# from the n8n API, it templates them into W0 before posting it last.
#
# Required env vars:
#   GITHUB_TOKEN          OAuth/PAT used by W1 (fine-grained PAT ok)
#   MORGEN_KEY            Morgen API key (used as "ApiKey <key>")
#   GITHUB_REPO_OWNER     The GitHub user/org that owns the task-mirror repo
#   GITHUB_REPO_NAME      The name of the task-mirror repo
#   N8N_API_KEY           Your n8n public API key
#   N8N_BASE_URL          Your n8n instance base URL
#                         (e.g. https://your-tenant.app.n8n.cloud)
#
# Back-compat shim:
#   GITHUB_REPO           "<owner>/<repo>" — if set instead of the split pair
#                         above, the script will split on '/' for you.
#
# Optional knobs:
#   DRY_RUN=1             Render substituted JSON to $TMPDIR, do not POST.
#   SKIP_ORCHESTRATOR=1   Only import W1/W2 (advanced — you're wiring
#                         your own scheduling and accept that W1/W2 can
#                         race on .sync-state.json).
#
# After import, activate ONLY the W0-Sync-Orchestrator in the n8n UI.
# Leave W1/W2 inactive — the orchestrator calls them directly.
#
# ⚠️  Not idempotent.  n8n's POST /workflows endpoint creates a NEW workflow
# on every call (no upsert by name). Re-running this script doubles your
# workflow set. If you need to re-import, delete the previous W0/W1/W2
# in the n8n UI first.

set -euo pipefail

# Rollback hint on mid-run failure.  We start with an empty array so the trap
# is safe to fire before the import loop begins.
declare -a CREATED_IDS=()
declare -a CREATED_NAMES=()

cleanup_on_error() {
  local rc=$?
  if [[ ${#CREATED_IDS[@]} -gt 0 && "${DRY_RUN:-0}" != "1" ]]; then
    echo >&2
    echo "[install-workflows] FAILED mid-install. Workflows created so far:" >&2
    for i in "${!CREATED_IDS[@]}"; do
      printf '  %s (%s)\n' "${CREATED_IDS[$i]}" "${CREATED_NAMES[$i]:-?}" >&2
    done
    echo "[install-workflows] To roll back each one:" >&2
    echo "  curl -X DELETE -H \"X-N8N-API-KEY: \$N8N_API_KEY\" \\" >&2
    echo "    \"\$N8N_BASE_URL/api/v1/workflows/<ID>\"" >&2
  fi
  exit "${rc}"
}
trap cleanup_on_error ERR

: "${GITHUB_TOKEN:?GITHUB_TOKEN env var required}"
: "${MORGEN_KEY:?MORGEN_KEY env var required}"
: "${N8N_API_KEY:?N8N_API_KEY env var required}"

: "${N8N_BASE_URL:?N8N_BASE_URL env var required (e.g. https://your-tenant.app.n8n.cloud)}"
DRY_RUN="${DRY_RUN:-0}"

# Preferred: split owner + name (easier to string-concat in shell/JS callers).
# Back-compat: accept joined GITHUB_REPO="owner/repo".
if [[ -z "${GITHUB_REPO_OWNER:-}" || -z "${GITHUB_REPO_NAME:-}" ]]; then
  if [[ -n "${GITHUB_REPO:-}" ]]; then
    if [[ "${GITHUB_REPO}" != */* ]]; then
      echo "[install-workflows] ERROR: GITHUB_REPO must be '<owner>/<repo>' (got: ${GITHUB_REPO})" >&2
      exit 1
    fi
    GITHUB_REPO_OWNER="${GITHUB_REPO%%/*}"
    GITHUB_REPO_NAME="${GITHUB_REPO##*/}"
  else
    echo "[install-workflows] ERROR: set GITHUB_REPO_OWNER + GITHUB_REPO_NAME (or GITHUB_REPO)" >&2
    exit 1
  fi
fi

GITHUB_OWNER="${GITHUB_REPO_OWNER}"
GITHUB_REPO="${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[install-workflows] ERROR: 'jq' is required but not installed." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "[install-workflows] ERROR: 'curl' is required but not installed." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WF_DIR="${REPO_ROOT}/workflows"

WORKFLOWS=(
  "W1:W1-obsidian-git-task-sync.json"
  "W2:W2-morgen-task-completion-sync.json"
)

escape_sed() {
  printf '%s' "$1" | sed -e 's/[&/\|]/\\&/g'
}

GH_E="$(escape_sed "${GITHUB_TOKEN}")"
MORGEN_E="$(escape_sed "${MORGEN_KEY}")"
GH_REPO_E="$(escape_sed "${GITHUB_REPO}")"
GH_OWNER_E="$(escape_sed "${GITHUB_OWNER}")"
GH_REPO_NAME_E="$(escape_sed "${GITHUB_REPO_NAME}")"

# CREATED_IDS + CREATED_NAMES declared at top so the ERR trap can see them
# before the first import succeeds.

for pair in "${WORKFLOWS[@]}"; do
  label="${pair%%:*}"
  file="${pair##*:}"
  src="${WF_DIR}/${file}"

  if [[ ! -f "${src}" ]]; then
    echo "[install-workflows] ERROR: missing ${src}" >&2
    exit 1
  fi

  rendered="$(mktemp -t "${label}.rendered.XXXXXX").json"
  : > "${rendered}"

  sed \
    -e "s|{{GITHUB_TOKEN}}|${GH_E}|g" \
    -e "s|{{MORGEN_KEY}}|${MORGEN_E}|g" \
    -e "s|{{MORGEN_API_KEY}}|${MORGEN_E}|g" \
    -e "s|{{GITHUB_REPO}}|${GH_REPO_E}|g" \
    -e "s|{{GITHUB_OWNER}}|${GH_OWNER_E}|g" \
    -e "s|{{GITHUB_REPO_NAME}}|${GH_REPO_NAME_E}|g" \
    "${src}" > "${rendered}"

  if grep -q '{{[A-Z_]*}}' "${rendered}"; then
    echo "[install-workflows] ERROR: unreplaced placeholders in ${rendered}:" >&2
    grep -oE '\{\{[A-Z_]+\}\}' "${rendered}" | sort -u >&2
    exit 1
  fi

  clean="$(mktemp -t "${label}.clean.XXXXXX").json"
  jq '{name, nodes, connections, settings}' "${rendered}" > "${clean}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[install-workflows] DRY RUN — would POST ${label} from ${clean}"
    CREATED_IDS+=("dry-run-${label}")
    CREATED_NAMES+=("$(jq -r .name "${clean}")")
    continue
  fi

  echo "[install-workflows] POST ${label} → ${N8N_BASE_URL}/api/v1/workflows"
  response="$(curl -sS -X POST "${N8N_BASE_URL}/api/v1/workflows" \
    -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
    -H "Content-Type: application/json" \
    --data-binary @"${clean}")"

  wf_id="$(printf '%s' "${response}" | jq -r '.id // empty')"
  wf_name="$(printf '%s' "${response}" | jq -r '.name // empty')"

  if [[ -z "${wf_id}" ]]; then
    echo "[install-workflows] ERROR: no id in response for ${label}:" >&2
    printf '%s\n' "${response}" >&2
    exit 1
  fi

  echo "[install-workflows]   ${label} id=${wf_id} name='${wf_name}'"
  CREATED_IDS+=("${wf_id}")
  CREATED_NAMES+=("${wf_name}")

  rm -f "${rendered}" "${clean}"
done

SKIP_ORCHESTRATOR="${SKIP_ORCHESTRATOR:-0}"

# ---------------------------------------------------------------------------
# W0 — Sync Orchestrator
# Sequences W2 → W1 every 20 min via executeWorkflow(wait=true).
# Imported last because it needs the real W1/W2 workflow IDs assigned by
# n8n in the loop above (or from a DRY_RUN placeholder).
# ---------------------------------------------------------------------------

if [[ "${SKIP_ORCHESTRATOR}" == "1" ]]; then
  echo "[install-workflows] SKIP_ORCHESTRATOR=1 — skipping W0 orchestrator import."
else
  ORCH_SRC="${WF_DIR}/W0-orchestrator-sync-sequencer.json"
  if [[ ! -f "${ORCH_SRC}" ]]; then
    echo "[install-workflows] ERROR: missing ${ORCH_SRC}" >&2
    exit 1
  fi

  W1_ID="${CREATED_IDS[0]}"
  W2_ID="${CREATED_IDS[1]}"

  W1_ID_E="$(escape_sed "${W1_ID}")"
  W2_ID_E="$(escape_sed "${W2_ID}")"

  orch_rendered="$(mktemp -t W0.rendered.XXXXXX).json"
  : > "${orch_rendered}"
  sed \
    -e "s|{{W1_WORKFLOW_ID}}|${W1_ID_E}|g" \
    -e "s|{{W2_WORKFLOW_ID}}|${W2_ID_E}|g" \
    "${ORCH_SRC}" > "${orch_rendered}"

  if grep -q '{{[A-Z_]*}}' "${orch_rendered}"; then
    echo "[install-workflows] ERROR: unreplaced placeholders in orchestrator:" >&2
    grep -oE '\{\{[A-Z_]+\}\}' "${orch_rendered}" | sort -u >&2
    exit 1
  fi

  orch_clean="$(mktemp -t W0.clean.XXXXXX).json"
  jq '{name, nodes, connections, settings}' "${orch_rendered}" > "${orch_clean}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[install-workflows] DRY RUN — would POST W0 orchestrator from ${orch_clean}"
    CREATED_IDS+=("dry-run-W0")
    CREATED_NAMES+=("$(jq -r .name "${orch_clean}")")
  else
    echo "[install-workflows] POST W0 → ${N8N_BASE_URL}/api/v1/workflows"
    response="$(curl -sS -X POST "${N8N_BASE_URL}/api/v1/workflows" \
      -H "X-N8N-API-KEY: ${N8N_API_KEY}" \
      -H "Content-Type: application/json" \
      --data-binary @"${orch_clean}")"

    wf_id="$(printf '%s' "${response}" | jq -r '.id // empty')"
    wf_name="$(printf '%s' "${response}" | jq -r '.name // empty')"

    if [[ -z "${wf_id}" ]]; then
      echo "[install-workflows] ERROR: no id in response for W0:" >&2
      printf '%s\n' "${response}" >&2
      exit 1
    fi

    echo "[install-workflows]   W0 id=${wf_id} name='${wf_name}'"
    CREATED_IDS+=("${wf_id}")
    CREATED_NAMES+=("${wf_name}")

    rm -f "${orch_rendered}" "${orch_clean}"
  fi

  WORKFLOWS+=("W0:W0-orchestrator-sync-sequencer.json")
fi

# Derive the orchestrator's display name from its JSON so we stay honest if
# someone renames it in-place — no hardcoded magic string in the banner.
ORCH_NAME_DEFAULT="W0-Sync-Orchestrator"
if [[ "${SKIP_ORCHESTRATOR}" != "1" && -f "${WF_DIR}/W0-orchestrator-sync-sequencer.json" ]]; then
  ORCH_NAME="$(jq -r '.name // empty' "${WF_DIR}/W0-orchestrator-sync-sequencer.json" 2>/dev/null)"
  ORCH_NAME="${ORCH_NAME:-${ORCH_NAME_DEFAULT}}"
else
  ORCH_NAME="${ORCH_NAME_DEFAULT}"
fi

echo
echo "====================================================================="
echo "  Workflows created:"
for i in "${!CREATED_IDS[@]}"; do
  label="${WORKFLOWS[$i]%%:*}"
  printf "    %-4s %s  (%s)\n" "${label}" "${CREATED_IDS[$i]}" "${CREATED_NAMES[$i]}"
done
echo
if [[ "${SKIP_ORCHESTRATOR}" == "1" ]]; then
  echo "  NEXT: SKIP_ORCHESTRATOR=1 — you asked for bare W1/W2 with their own"
  echo "  schedule triggers. Activate them in this order:  W1 → W2"
  echo "  (W1 is the fast push-based path, W2 sweeps Morgen.)"
else
  echo "  NEXT: activate ONLY the ${ORCH_NAME} in the n8n UI."
  echo "  Leave W1/W2 inactive — the orchestrator triggers them directly"
  echo "  via executeWorkflow so they never race each other on the shared"
  echo "  .sync-state.json file."
fi
echo
echo "  ⚠️  Re-running this script creates DUPLICATE workflows — n8n's API"
echo "  does not upsert by name. If you need to reinstall, delete the"
echo "  existing W0/W1/W2 in the n8n UI (or via DELETE /api/v1/workflows/<id>)"
echo "  before running again, or you will end up with two copies of each."
echo "====================================================================="

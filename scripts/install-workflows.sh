#!/usr/bin/env bash
#
# install-workflows.sh — import W1/W2/W3 into an n8n instance after
# substituting placeholders with real tokens from env vars.
#
# Required env vars:
#   GITHUB_TOKEN          OAuth/PAT used by W1/W3 (fine-grained PAT ok)
#   NOTION_TOKEN          Notion internal integration token ("ntn_…")
#   MORGEN_KEY            Morgen API key (used as "ApiKey <key>")
#   NOTION_DATABASE_ID    Target Notion database ID (with or without dashes)
#   GITHUB_REPO           "<owner>/<repo>" — the repo n8n watches
#   N8N_API_KEY           Your n8n public API key
#
# Optional env vars:
#   N8N_BASE_URL          Your n8n instance base URL (no default — must be set)
#   DRY_RUN=1             Render substituted JSON to /tmp, do not POST
#
# After import, activate the workflows in the n8n UI in this order:
#   W1 → W3 → W2

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN env var required}"
: "${NOTION_TOKEN:?NOTION_TOKEN env var required}"
: "${MORGEN_KEY:?MORGEN_KEY env var required}"
: "${NOTION_DATABASE_ID:?NOTION_DATABASE_ID env var required}"
: "${GITHUB_REPO:?GITHUB_REPO env var required (format: owner/repo)}"
: "${N8N_API_KEY:?N8N_API_KEY env var required}"

: "${N8N_BASE_URL:?N8N_BASE_URL env var required (e.g. https://your-tenant.app.n8n.cloud)}"
DRY_RUN="${DRY_RUN:-0}"

if [[ "${GITHUB_REPO}" != */* ]]; then
  echo "[install-workflows] ERROR: GITHUB_REPO must be in '<owner>/<repo>' form (got: ${GITHUB_REPO})" >&2
  exit 1
fi
GITHUB_OWNER="${GITHUB_REPO%%/*}"
GITHUB_REPO_NAME="${GITHUB_REPO##*/}"

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
  "W3:W3-notion-done-to-obsidian-sync.json"
)

escape_sed() {
  printf '%s' "$1" | sed -e 's/[&/\|]/\\&/g'
}

GH_E="$(escape_sed "${GITHUB_TOKEN}")"
NOTION_E="$(escape_sed "${NOTION_TOKEN}")"
MORGEN_E="$(escape_sed "${MORGEN_KEY}")"
NOTION_DB_E="$(escape_sed "${NOTION_DATABASE_ID}")"
GH_REPO_E="$(escape_sed "${GITHUB_REPO}")"
GH_OWNER_E="$(escape_sed "${GITHUB_OWNER}")"
GH_REPO_NAME_E="$(escape_sed "${GITHUB_REPO_NAME}")"

declare -a CREATED_IDS=()
declare -a CREATED_NAMES=()

for pair in "${WORKFLOWS[@]}"; do
  label="${pair%%:*}"
  file="${pair##*:}"
  src="${WF_DIR}/${file}"

  if [[ ! -f "${src}" ]]; then
    echo "[install-workflows] ERROR: missing ${src}" >&2
    exit 1
  fi

  rendered="$(mktemp "/tmp/${label}.rendered.XXXXXX.json")"

  sed \
    -e "s|{{GITHUB_TOKEN}}|${GH_E}|g" \
    -e "s|{{NOTION_TOKEN}}|${NOTION_E}|g" \
    -e "s|{{MORGEN_KEY}}|${MORGEN_E}|g" \
    -e "s|{{NOTION_DATABASE_ID}}|${NOTION_DB_E}|g" \
    -e "s|{{GITHUB_REPO}}|${GH_REPO_E}|g" \
    -e "s|{{GITHUB_OWNER}}|${GH_OWNER_E}|g" \
    -e "s|{{GITHUB_REPO_NAME}}|${GH_REPO_NAME_E}|g" \
    "${src}" > "${rendered}"

  if grep -q '{{[A-Z_]*}}' "${rendered}"; then
    echo "[install-workflows] ERROR: unreplaced placeholders in ${rendered}:" >&2
    grep -oE '\{\{[A-Z_]+\}\}' "${rendered}" | sort -u >&2
    exit 1
  fi

  clean="$(mktemp "/tmp/${label}.clean.XXXXXX.json")"
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

echo
echo "====================================================================="
echo "  Workflows created:"
for i in "${!CREATED_IDS[@]}"; do
  label="${WORKFLOWS[$i]%%:*}"
  printf "    %-4s %s  (%s)\n" "${label}" "${CREATED_IDS[$i]}" "${CREATED_NAMES[$i]}"
done
echo
echo "  NEXT: activate workflows in the n8n UI in this order:"
echo "    W1 → W3 → W2"
echo
echo "  Why this order? W1 is the fast Obsidian→Notion/Morgen path, W3 is"
echo "  the reverse guard for Notion-originated edits, and W2 is the slow"
echo "  Morgen-completion sweeper that depends on both being live."
echo "====================================================================="

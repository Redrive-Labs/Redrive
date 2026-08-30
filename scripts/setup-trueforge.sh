#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Bootstrap Redrive's TrueForge MCP resources and investigation skills.

Required:
  REDRIVE_TRUEFORGE_MODEL     TrueForge model/resource name configured in the UI.

Optional:
  REDRIVE_TRUEFORGE_URL       TrueForge API base URL (default: http://127.0.0.1:8790)
  REDRIVE_MCP_BASE_URL        URL TrueForge uses to reach Redrive (default: http://127.0.0.1:3001)
  REDRIVE_TRUEFORGE_TOKEN     Bearer token for a protected/hosted TrueForge API
  REDRIVE_GITHUB_CONNECTION_MCP_TOKEN
  REDRIVE_RECEIVER_MCP_TOKEN  Existing Redrive MCP bearer tokens; generated if absent
  REDRIVE_ENV_FILE            Env file to update (default: .env.local)

Options:
  --verify                    Also require TrueForge to list the expected MCP tools.
  --help                      Show this help.

Run this from the Redrive repository root.
USAGE
}

VERIFY=0
case "${1:-}" in
  "") ;;
  --verify) VERIFY=1 ;;
  --help|-h) usage; exit 0 ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

for command in curl node git openssl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

[[ -d .git ]] || {
  echo "Run this script from the Redrive repository root." >&2
  exit 1
}

ENV_FILE="${REDRIVE_ENV_FILE:-.env.local}"

read_env_key() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { value=substr($0, length(key)+2) } END { if (value != "") print value }' "$ENV_FILE"
}

TRUEFORGE_URL="${REDRIVE_TRUEFORGE_URL:-$(read_env_key REDRIVE_TRUEFORGE_URL)}"
TRUEFORGE_URL="${TRUEFORGE_URL:-http://127.0.0.1:8790}"
MCP_BASE_URL="${REDRIVE_MCP_BASE_URL:-http://127.0.0.1:3001}"
MODEL="${REDRIVE_TRUEFORGE_MODEL:-$(read_env_key REDRIVE_TRUEFORGE_MODEL)}"
TRUEFORGE_TOKEN="${REDRIVE_TRUEFORGE_TOKEN:-$(read_env_key REDRIVE_TRUEFORGE_TOKEN)}"
GITHUB_MCP_NAME="redrive-github"
RECEIVER_MCP_NAME="redrive-receiver"
PROVIDER_SKILL_NAME="redrive-connection-provider-investigation"
RECEIVER_SKILL_NAME="redrive-connection-receiver-investigation"
REPO_URL="https://github.com/Redrive-Labs/Redrive.git"
REF="$(git rev-parse HEAD)"

trim_trailing_slash() {
  local value="$1"
  while [[ "$value" == */ ]]; do value="${value%/}"; done
  printf '%s' "$value"
}
TRUEFORGE_URL="$(trim_trailing_slash "$TRUEFORGE_URL")"
MCP_BASE_URL="$(trim_trailing_slash "$MCP_BASE_URL")"

[[ -n "$MODEL" ]] || {
  echo "REDRIVE_TRUEFORGE_MODEL is required. Configure a model in TrueForge, then rerun with its resource name." >&2
  exit 1
}

[[ "$TRUEFORGE_URL" =~ ^https?://[^[:space:]]+$ ]] || {
  echo "REDRIVE_TRUEFORGE_URL must be an http(s) URL." >&2
  exit 1
}
[[ "$MCP_BASE_URL" =~ ^https?://[^[:space:]]+$ ]] || {
  echo "REDRIVE_MCP_BASE_URL must be an http(s) URL." >&2
  exit 1
}

GITHUB_TOKEN="${REDRIVE_GITHUB_CONNECTION_MCP_TOKEN:-$(read_env_key REDRIVE_GITHUB_CONNECTION_MCP_TOKEN)}"
RECEIVER_TOKEN="${REDRIVE_RECEIVER_MCP_TOKEN:-$(read_env_key REDRIVE_RECEIVER_MCP_TOKEN)}"
[[ -n "$GITHUB_TOKEN" ]] || GITHUB_TOKEN="$(openssl rand -hex 32)"
[[ -n "$RECEIVER_TOKEN" ]] || RECEIVER_TOKEN="$(openssl rand -hex 32)"

[[ "$GITHUB_TOKEN" != "$RECEIVER_TOKEN" ]] || {
  echo "GitHub and Receiver MCP tokens must be distinct." >&2
  exit 1
}

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

export ENV_FILE TRUEFORGE_URL MODEL GITHUB_TOKEN RECEIVER_TOKEN GITHUB_MCP_NAME RECEIVER_MCP_NAME
node <<'NODE'
const fs = require('node:fs');
const path = process.env.ENV_FILE;
const updates = new Map([
  ['REDRIVE_TRUEFORGE_URL', process.env.TRUEFORGE_URL],
  ['REDRIVE_TRUEFORGE_MODEL', process.env.MODEL],
  ['REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME', process.env.GITHUB_MCP_NAME],
  ['REDRIVE_GITHUB_CONNECTION_MCP_TOKEN', process.env.GITHUB_TOKEN],
  ['REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME', process.env.RECEIVER_MCP_NAME],
  ['REDRIVE_RECEIVER_MCP_TOKEN', process.env.RECEIVER_TOKEN],
]);
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
lines = lines.filter((line) => ![...updates.keys()].some((key) => line.startsWith(`${key}=`)));
while (lines.length && lines.at(-1) === '') lines.pop();
if (lines.length) lines.push('');
for (const [key, value] of updates) lines.push(`${key}=${value}`);
lines.push('');
fs.writeFileSync(path, lines.join('\n'), { mode: 0o600 });
NODE

TF_HEADERS=(-H 'content-type: application/json')
if [[ -n "$TRUEFORGE_TOKEN" ]]; then
  TF_HEADERS+=(-H "Authorization: Bearer $TRUEFORGE_TOKEN")
fi

trueforge_request() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  if [[ -n "$payload" ]]; then
    curl --fail-with-body --silent --show-error \
      -X "$method" "${TF_HEADERS[@]}" \
      --data "$payload" \
      "$TRUEFORGE_URL$path"
  else
    curl --fail-with-body --silent --show-error \
      -X "$method" "${TF_HEADERS[@]}" \
      "$TRUEFORGE_URL$path"
  fi
}

export MCP_BASE_URL REPO_URL REF PROVIDER_SKILL_NAME RECEIVER_SKILL_NAME
mcp_payload() {
  local name="$1" url="$2" token="$3" description="$4"
  NAME="$name" URL="$url" TOKEN="$token" DESCRIPTION="$description" node <<'NODE'
process.stdout.write(JSON.stringify({
  manifest: {
    type: 'remote',
    name: process.env.NAME,
    url: process.env.URL,
    description: process.env.DESCRIPTION,
    auth: { type: 'header', headers: { Authorization: `Bearer ${process.env.TOKEN}` } },
  },
}));
NODE
}

skill_payload() {
  local name="$1" path="$2" description="$3"
  NAME="$name" SKILL_PATH="$path" DESCRIPTION="$description" node <<'NODE'
process.stdout.write(JSON.stringify({
  manifest: {
    type: 'git',
    name: process.env.NAME,
    url: process.env.REPO_URL,
    ref: process.env.REF,
    path: process.env.SKILL_PATH,
    description: process.env.DESCRIPTION,
  },
}));
NODE
}

echo "Checking TrueForge at $TRUEFORGE_URL ..."
trueforge_request GET /healthz >/dev/null

echo "Registering read-only MCP resources ..."
trueforge_request PUT /api/v1/settings/mcp-servers "$(mcp_payload \
  "$GITHUB_MCP_NAME" \
  "$MCP_BASE_URL/api/mcp/github" \
  "$GITHUB_TOKEN" \
  'Read-only GitHub delivery evidence for Redrive.')" >/dev/null
trueforge_request PUT /api/v1/settings/mcp-servers "$(mcp_payload \
  "$RECEIVER_MCP_NAME" \
  "$MCP_BASE_URL/api/mcp/receiver" \
  "$RECEIVER_TOKEN" \
  'Read-only receiver business-state evidence for Redrive.')" >/dev/null

echo "Registering investigation skills at $REF ..."
trueforge_request PUT /api/v1/settings/skills "$(skill_payload \
  "$PROVIDER_SKILL_NAME" \
  'skills/redrive-connection-provider-investigation' \
  'Read-only connection-backed GitHub delivery investigation for a Redrive incident.')" >/dev/null
trueforge_request PUT /api/v1/settings/skills "$(skill_payload \
  "$RECEIVER_SKILL_NAME" \
  'skills/redrive-connection-receiver-investigation' \
  'Read-only receiver business-state investigation for a Redrive incident.')" >/dev/null

if [[ "$VERIFY" -eq 1 ]]; then
  echo "Verifying MCP tools through TrueForge ..."
  github_tools="$(trueforge_request GET "/api/v1/mcp-servers/$GITHUB_MCP_NAME/tools")"
  receiver_tools="$(trueforge_request GET "/api/v1/mcp-servers/$RECEIVER_MCP_NAME/tools")"
  GITHUB_TOOLS="$github_tools" RECEIVER_TOOLS="$receiver_tools" node <<'NODE'
function names(value) {
  const parsed = JSON.parse(value);
  if (!parsed || !Array.isArray(parsed.data)) return [];
  return parsed.data.map((tool) => tool && tool.name).filter(Boolean);
}
const github = names(process.env.GITHUB_TOOLS);
const receiver = names(process.env.RECEIVER_TOOLS);
if (!github.includes('get_webhook_delivery')) {
  throw new Error('redrive-github did not expose get_webhook_delivery');
}
for (const expected of ['get_business_state', 'get_receiver_health']) {
  if (!receiver.includes(expected)) {
    throw new Error(`redrive-receiver did not expose ${expected}`);
  }
}
NODE
  echo "TrueForge MCP verification passed."
fi

echo
echo "TrueForge bootstrap complete."
echo "Updated: $ENV_FILE"
echo "MCP resources: $GITHUB_MCP_NAME, $RECEIVER_MCP_NAME"
echo "Skills pinned to: $REF"
echo "Secrets were written to $ENV_FILE and were not printed."
if [[ "$VERIFY" -eq 0 ]]; then
  echo "After Redrive is running with this env, verify with: bash scripts/setup-trueforge.sh --verify"
fi

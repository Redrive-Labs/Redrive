#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Capture one real failed GitHub webhook delivery as a connection-bound Redrive incident.

Required:
  REDRIVE_OPERATOR_TOKEN   Operator token, or set it in .env.local.

Optional:
  --investigate            After capture, run the read-only Provider + Receiver investigation.
  REDRIVE_URL              Redrive base URL (default: http://127.0.0.1:3001)
  REDRIVE_CONNECTION_ID    Required only when more than one GitHub connection exists.
  REDRIVE_DELIVERY_ID      Required only when more than one failed delivery exists.
  REDRIVE_ENV_FILE         Env file to read (default: .env.local)

Without --investigate, the script only reads GitHub delivery history and creates the local Redrive incident.
With --investigate, it also runs Redrive's read-only TrueForge Provider + Receiver investigation.
It never starts sandbox recovery, deploys, approves, or redelivers anything.
USAGE
}

INVESTIGATE=0
case "${1:-}" in
  "") ;;
  --investigate) INVESTIGATE=1 ;;
  --help|-h) usage; exit 0 ;;
  *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
esac

for command in curl node; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done

ENV_FILE="${REDRIVE_ENV_FILE:-.env.local}"
read_env_key() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" 'index($0, key "=") == 1 { value=substr($0, length(key)+2) } END { if (value != "") print value }' "$ENV_FILE"
}

BASE_URL="${REDRIVE_URL:-http://127.0.0.1:3001}"
while [[ "$BASE_URL" == */ ]]; do BASE_URL="${BASE_URL%/}"; done
OPERATOR_TOKEN="${REDRIVE_OPERATOR_TOKEN:-$(read_env_key REDRIVE_OPERATOR_TOKEN)}"
CONNECTION_ID="${REDRIVE_CONNECTION_ID:-}"
DELIVERY_ID="${REDRIVE_DELIVERY_ID:-}"

[[ -n "$OPERATOR_TOKEN" ]] || {
  echo "REDRIVE_OPERATOR_TOKEN is required (environment or $ENV_FILE)." >&2
  exit 1
}
[[ "$BASE_URL" =~ ^https?://[^[:space:]]+$ ]] || {
  echo "REDRIVE_URL must be an http(s) URL." >&2
  exit 1
}

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

login_payload="$(OPERATOR_TOKEN="$OPERATOR_TOKEN" node <<'NODE'
process.stdout.write(JSON.stringify({ token: process.env.OPERATOR_TOKEN }));
NODE
)"

status="$(curl --silent --show-error \
  -o /dev/null \
  -w '%{http_code}' \
  -c "$COOKIE_JAR" \
  -H 'content-type: application/json' \
  --data "$login_payload" \
  "$BASE_URL/api/operator/login")"
[[ "$status" == "303" ]] || {
  echo "Operator login failed with HTTP $status." >&2
  exit 1
}

connections="$(curl --fail-with-body --silent --show-error \
  -b "$COOKIE_JAR" \
  "$BASE_URL/api/integrations/github/connections")"

if [[ -z "$CONNECTION_ID" ]]; then
  set +e
  selection="$(CONNECTIONS="$connections" node <<'NODE'
const body = JSON.parse(process.env.CONNECTIONS);
const items = Array.isArray(body.connections) ? body.connections : [];
if (items.length === 1 && typeof items[0]?.id === 'string') {
  process.stdout.write(items[0].id);
  process.exit(0);
}
for (const item of items) {
  console.error(`${item.id ?? '?'}\t${item.repositoryFullName ?? '?'}`);
}
process.exit(items.length === 0 ? 3 : 2);
NODE
)"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    CONNECTION_ID="$selection"
  elif [[ "$code" -eq 3 ]]; then
    echo "No GitHub ApplicationConnection exists yet. Finish GitHub setup in Redrive first." >&2
    exit 1
  else
    echo "More than one GitHub connection exists. Rerun with REDRIVE_CONNECTION_ID=<id>." >&2
    exit 2
  fi
fi

deliveries="$(curl --fail-with-body --silent --show-error \
  -b "$COOKIE_JAR" \
  "$BASE_URL/api/integrations/github/connections/$(node -p 'encodeURIComponent(process.argv[1])' "$CONNECTION_ID")/deliveries")"

if [[ -z "$DELIVERY_ID" ]]; then
  set +e
  selection="$(DELIVERIES="$deliveries" node <<'NODE'
const body = JSON.parse(process.env.DELIVERIES);
const items = Array.isArray(body.deliveries) ? body.deliveries : [];
if (items.length === 1 && typeof items[0]?.id === 'string') {
  process.stdout.write(items[0].id);
  process.exit(0);
}
for (const item of items) {
  console.error(`${item.id ?? '?'}\t${item.status ?? 'FAILED'}\t${item.deliveredAt ?? item.delivered_at ?? ''}`);
}
process.exit(items.length === 0 ? 3 : 2);
NODE
)"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    DELIVERY_ID="$selection"
  elif [[ "$code" -eq 3 ]]; then
    echo "No failed GitHub deliveries were found for this connection." >&2
    exit 1
  else
    echo "More than one failed delivery exists. Rerun with REDRIVE_DELIVERY_ID=<id>." >&2
    exit 2
  fi
fi

incident_payload="$(DELIVERY_ID="$DELIVERY_ID" node <<'NODE'
process.stdout.write(JSON.stringify({ deliveryId: process.env.DELIVERY_ID }));
NODE
)"

result="$(curl --fail-with-body --silent --show-error \
  -b "$COOKIE_JAR" \
  -H 'content-type: application/json' \
  --data "$incident_payload" \
  "$BASE_URL/api/integrations/github/connections/$(node -p 'encodeURIComponent(process.argv[1])' "$CONNECTION_ID")/incidents")"

INCIDENT_ID="$(RESULT="$result" node <<'NODE'
const body = JSON.parse(process.env.RESULT);
const incident = body.incident ?? body;
if (typeof incident?.id !== 'string' || incident.id.length === 0) process.exit(2);
process.stdout.write(incident.id);
NODE
)"

echo "Captured failed delivery as a Redrive incident:"
echo "$result" | node -e '
let input="";
process.stdin.on("data", (c) => input += c);
process.stdin.on("end", () => {
  const body = JSON.parse(input);
  const incident = body.incident ?? body;
  console.log(JSON.stringify({
    incidentId: incident.id,
    repository: incident.repositoryId,
    deliveryId: incident.externalDeliveryId,
    status: incident.status,
  }, null, 2));
});
'

if [[ "$INVESTIGATE" -eq 1 ]]; then
  echo
  echo "Running read-only Provider + Receiver investigation through TrueForge ..."
  investigation="$(curl --fail-with-body --silent --show-error \
    -b "$COOKIE_JAR" \
    -X POST \
    "$BASE_URL/api/incidents/$(node -p 'encodeURIComponent(process.argv[1])' "$INCIDENT_ID")/provider-investigation")"
  INVESTIGATION="$investigation" node <<'NODE'
const body = JSON.parse(process.env.INVESTIGATION);
console.log(JSON.stringify({
  providerStatusCode: body.evidence?.outcome?.statusCode ?? body.evidence?.outcome?.status_code ?? null,
  receiverMutationCount: body.receiverObservation?.mutationCount ?? null,
  receiverBusinessState: body.receiverObservation?.businessState ?? null,
  contradiction: body.contradiction ?? null,
  recoveryState: body.recoveryState ?? null,
  trueForgeSessionId: body.trueForgeSessionId ?? null,
}, null, 2));
NODE
fi

# Redrive

> Repair the consumer before replaying the event.

## The problem

Webhook systems can tell you that a delivery failed.

They cannot necessarily tell you whether the business operation failed.

Consider:

```text
webhook arrives
      ↓
receiver changes business state
      ↓
later operation fails
      ↓
receiver returns HTTP 500
```

The provider records a failed delivery, but the business mutation has already
occurred.

Blind replay can perform it again.

## What Redrive does

Redrive treats a failed webhook as a recovery incident rather than immediately
retrying it.

```text
failed delivery
      ↓
provider + receiver investigation
      ↓
sandbox reproduction
      ↓
generated receiver repair
      ↓
adversarial replay verification
      ↓
human approval
      ↓
deploy
      ↓
human approval
      ↓
redrive original event
      ↓
independent business verification
```

The goal is not merely a successful HTTP response.

The goal is a successful provider delivery with the intended business effect
occurring exactly once.

## Core ideas

### Evidence before action

Consequential recovery actions become available only after machine-checkable
evidence has been established.

### Repair before replay

If the consumer is unsafe, retrying transport does not solve the incident.

### Reproduction fidelity

Redrive records how each relevant dependency was represented during sandbox
verification and refuses consequential recovery when a required causal
dependency remains unresolved.

### Human control

Deployment and provider redelivery are separate consequential actions and are
independently approval-gated.

## Hackathon implementation

The initial system uses:

- GitHub Webhooks;
- TrueForge;
- Daytona;
- Docker Compose;
- PostgreSQL;
- a custom GitHub MCP integration;
- an independent receiver repository.

See:

- `docs/ARCHITECTURE.md`
- `docs/INVARIANTS.md`

## Status

Active hackathon development.

## Operator access

Redrive is currently a single-operator, self-hosted control plane. Configure a
high-entropy `REDRIVE_OPERATOR_TOKEN` of at least 32 characters. The operator
UI and control APIs require login at `/login`. GitHub callbacks retain their
state-token authentication, and `/api/mcp/github` retains separate bearer
authentication. The read-only `/api/mcp/receiver` surface uses its own
`REDRIVE_RECEIVER_MCP_TOKEN` bearer secret; it is independent from operator,
GitHub MCP, and connector authentication.

## Run the control plane locally

Requirements: Node.js 22 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The development capture
form records minimal incident metadata in `.local/redrive.sqlite`. Each incident
can use the control-plane action to investigate one GitHub delivery through the
connection-backed read-only MCP endpoint. The normalized evidence is stored in the same
SQLite database. The database directory and schema are created automatically on
first use.

To use another local SQLite path, copy `.env.example` to `.env.local` and set
`REDRIVE_DATABASE_PATH`. GitHub App private keys are stored outside the
repository at `$HOME/.redrive/secrets` by default. Redrive creates the
`.redrive` and `secrets` directories with mode `0700` and private-key files
with mode `0600` on POSIX systems. Set `REDRIVE_SECRET_DIR` to an explicit
absolute directory when required; its ownership, ancestor, symlink, and
permission checks remain enforced. Set the required server-side
`REDRIVE_TRUEFORGE_MODEL` to the configured TrueForge model/resource name.
Connection-backed M2.6B incidents use
`REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME`, whose configured server must
point at Redrive's strict `/api/mcp/github` endpoint. Set
`REDRIVE_GITHUB_CONNECTION_MCP_TOKEN` to its server-side bearer secret.
TrueForge Settings owns the MCP server URL and credentials. Redrive does not
select or interpret a provider, and TrueForge credentials stay server-side.

`externalDeliveryId` and normalized `providerDeliveryId` identify the exact
GitHub delivery attempt (`id`). `deliveryGuid` is the separate logical webhook
identity (`guid`) carried by `X-GitHub-Delivery`, which receivers should use for
idempotency. Capture fails closed if those identities, the request header, or
the configured repository evidence contradict each other.

`GET /api/incidents/:incidentId/provider-evidence` reads only the persisted
snapshot and returns `{ "evidence": null }` before capture. Provider evidence
is captured by the connection-backed TrueForge investigation. The first
normalized snapshot is immutable. MCP reads time out after 12 seconds and
reject transport responses larger than 64 MiB.

`POST /api/incidents/:incidentId/provider-investigation` runs the recovery path
through the incident's existing TrueForge session. Connection-backed incidents
use `m2.6b-v1` and the strict connection MCP server. The route then requires a
dynamic `provider-investigator` thread and correlates its read-only
`get_webhook_delivery` model tool call and `tool.response`. Only that response
is normalized as provider evidence. The route returns product state, not a
TrueForge transcript.
GitHub caps webhook payloads at 25 MB; the higher transport limit allows for
the escaped JSON-RPC text envelope while remaining bounded.


The stored `canonicalPayloadSha256` is SHA-256 of Redrive's canonical JSON
representation of the provider-returned payload. It is not a hash of the
original webhook request-body bytes, which Redrive does not possess here.

For remote or Tailscale development, optionally set the comma-separated
`NEXT_ALLOWED_DEV_ORIGINS` hostnames in `.env.local`.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

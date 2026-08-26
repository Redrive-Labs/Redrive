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

## Run the control plane locally

Requirements: Node.js 20.9 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The development capture
form records minimal incident metadata in `.local/redrive.sqlite`. Each incident
can use the control-plane action to inspect one GitHub delivery through the
configured read-only MCP bridge. The normalized evidence is stored in the same
SQLite database. The database directory and schema are created automatically on
first use.

To use another local SQLite path, copy `.env.example` to `.env.local` and set
`REDRIVE_DATABASE_PATH`.

Provider inspection requires a bridge exposing the proven
`get_webhook_delivery` MCP tool. Set `REDRIVE_GITHUB_MCP_URL`, then configure an
explicit repository-to-hook mapping with `REDRIVE_GITHUB_HOOK_IDS` (or set the
single-receiver `REDRIVE_GITHUB_HOOK_ID`). Redrive sends `hook_id` and the
incident's exact `externalDeliveryId` as `delivery_id`; it never derives a hook
ID from `repositoryId` and never calls GitHub REST directly.

For remote or Tailscale development, optionally set the comma-separated
`NEXT_ALLOWED_DEV_ORIGINS` hostnames in `.env.local`.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

# Redrive

> Failed doesn’t mean safe to retry.

Redrive is a proof-gated webhook recovery control plane that investigates both sides of a failed delivery, repairs the receiver in an isolated sandbox, and only allows replay after machine-verifiable evidence and explicit human approval.

![Redrive recovery cockpit](.visual-review/ship-desktop-polished.png)

## The problem

GitHub can report HTTP 500 even after the receiver already changed business state.

```text
GitHub: HTTP 500
Receiver: mutationCount = 1 / EXACTLY_ONE
```

Blind retry can duplicate the business mutation.

Redrive’s rule:

**No proof, no retry.**

## What Redrive does

1. Provider Investigator checks the exact GitHub delivery.
2. Receiver Investigator independently checks business state.
3. Redrive deterministically compares both observations.
4. Contradiction ⇒ `RETRY UNSAFE / BLOCKED`.
5. Recovery Agent reproduces the failure at the exact revision in an isolated sandbox.
6. It generates and verifies a repair.
7. A human approves deployment.
8. Redrive verifies the deployed receiver.
9. A second human approval unlocks exactly one GitHub redelivery.
10. Final independent receiver observation proves the business mutation still occurred exactly once.

## Why TrueForge is load-bearing

TrueForge is the runtime spine for one persistent, incident-bound recovery session. Redrive uses it for:

- persistent incident-bound Coordinator sessions
- dynamic Provider Investigator and Receiver Investigator subagents
- MCP tool execution for GitHub and receiver evidence
- persisted tool and event provenance
- a separate sandbox-enabled Recovery Session
- isolated repair and reproduction workflow
- human-controlled consequential stages

Provider and receiver evidence use separate read-only MCP evidence boundaries with deterministic attribution. Redrive does not claim hard per-child credential isolation.

**AI reasons, integrations observe, deterministic code proves, humans authorize.**

## Architecture

```text
GitHub ----> Provider Investigator --\
                                      \
                                       deterministic contradiction
                                      /
Receiver --> Receiver Investigator --/

                 |
              BLOCKED
                 |
       TrueForge Recovery Session
                 |
              Daytona
      reproduce -> repair -> verify
                 |
          Human DeployPermit
                 |
         deploy + verify
                 |
         Human RedrivePermit
                 |
          GitHub redelivery
                 |
         final EXACTLY_ONE proof
```

## Real proof from the build

The build produced these observed recovery facts:

**Provider**

- GitHub HTTP 500

**Receiver**

- `EXACTLY_ONE`
- `mutationCount = 1`

**Deterministic contradiction**

- `PROVIDER_FAILED_RECEIVER_MUTATED`
- recovery `BLOCKED`

**TrueForge / Daytona recovery proof**

- exact failing revision: `5bfadf93d5233e4e6cfe0fdb19ad1b78328a5d79`
- reproduction: `0 → HTTP 500 → 1`
- repair verification: `1 → HTTP 201 → 1`
- patch SHA: `6496e9635406f56d19f08bab431ceda87005ea32d543375aade59d84ee960a39`
- recovery session: `01m19pb0gxpgpwenhn37tnfkb1`

The same delivery succeeds after repair without increasing the business mutation count.

## Safety over pretending success

During final live redelivery validation, the external route produced an HTTP 504 after the single permitted redelivery. Redrive preserved that ambiguous result and refused to issue another blind redelivery.

That is the safety property working. It is not `RECOVERY_COMPLETE`.

## Human gates

The two approvals authorize different consequential actions:

- **DeployPermit**: authorizes deploying exactly the verified repair artifact
- **RedrivePermit**: authorizes exactly one provider redelivery only after deployment verification

## Qodo

Qodo was used throughout development and caught substantive correctness bugs, including:

- migration initialization race
- unsafe provider-evidence parsing and numeric handling
- sandbox artifact provenance
- stale candidate state during redelivery continuation
- deployment HEAD/worktree time-of-check to time-of-use (TOCTOU)

These were safety and correctness findings, not style-only review. See [PR #7](https://github.com/Redrive-Labs/Redrive/pull/7).

## Demo

Demo video: <PLACEHOLDER_FOR_CURRENT_YOUTUBE_URL>

Source: [Redrive on GitHub](https://github.com/Redrive-Labs/Redrive)

## Tech

- Next.js / TypeScript
- SQLite
- TrueForge
- MCP
- Daytona
- GitHub App / Webhooks
- PostgreSQL demo receiver
- Docker Compose

## Run locally

Requirements: Node.js 22 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The development capture form records minimal incident metadata in `.local/redrive.sqlite`. Each incident can use the control-plane action to investigate one GitHub delivery through the connection-backed read-only MCP endpoint. Normalized evidence is stored in the same SQLite database. Redrive creates the database directory and schema on first use.

To use another local SQLite path, copy `.env.example` to `.env.local` and set `REDRIVE_DATABASE_PATH`. GitHub App private keys are stored outside the repository at `$HOME/.redrive/secrets` by default. Redrive creates the `.redrive` and `secrets` directories with mode `0700` and private-key files with mode `0600` on POSIX systems. Set `REDRIVE_SECRET_DIR` to an explicit absolute directory when required; ownership, ancestor, symlink, and permission checks remain enforced.

Set the required server-side `REDRIVE_TRUEFORGE_MODEL` to the configured TrueForge model or resource name. Connection-backed incidents use `REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME`, whose configured server must point at Redrive’s strict `/api/mcp/github` endpoint. Set `REDRIVE_GITHUB_CONNECTION_MCP_TOKEN` to its server-side bearer secret.

Receiver investigation uses the distinct `REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME` and `REDRIVE_RECEIVER_MCP_TOKEN` values for the strict `/api/mcp/receiver` endpoint. TrueForge Settings owns the MCP server URL and credentials. Redrive does not select or interpret a provider, and TrueForge credentials stay server-side. Provider and receiver turns are role-separated, independently authenticated evidence boundaries with deterministic fail-closed tool correlation. Per-child MCP resource visibility remains live validation required for the current TrueForge SDK/API.

`externalDeliveryId` and normalized `providerDeliveryId` identify the exact GitHub delivery attempt (`id`). `deliveryGuid` is the separate logical webhook identity (`guid`) carried by `X-GitHub-Delivery`, which receivers should use for idempotency. Capture fails closed if those identities, the request header, or configured repository evidence contradict each other.

`GET /api/incidents/:incidentId/provider-evidence` reads only the persisted snapshot and returns `{ "evidence": null }` before capture. Provider evidence is captured by the connection-backed TrueForge investigation. The first normalized snapshot is immutable. MCP reads time out after 12 seconds and reject transport responses larger than 64 MiB.

`POST /api/incidents/:incidentId/provider-investigation` runs the recovery path through the incident’s existing TrueForge session. Connection-backed incidents use `m2.7-v1` and the strict connection MCP server. The route then requires a dynamic `provider-investigator` thread and correlates its read-only `get_webhook_delivery` model tool call and `tool.response`. Only that response is normalized as provider evidence. The route returns product state, not a TrueForge transcript.

GitHub caps webhook payloads at 25 MB. The higher transport limit allows for the escaped JSON-RPC text envelope while remaining bounded.

The stored `canonicalPayloadSha256` is SHA-256 of Redrive’s canonical JSON representation of the provider-returned payload. It is not a hash of the original webhook request-body bytes, which Redrive does not possess here.

For remote or Tailscale development, optionally set comma-separated `NEXT_ALLOWED_DEV_ORIGINS` hostnames in `.env.local`.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

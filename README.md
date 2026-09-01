# Redrive

> **Failed doesn't mean safe to retry.**

Redrive is a proof-gated recovery control plane for ambiguous webhook failures.

When GitHub reports a failed delivery, Redrive first asks two separate questions: what did GitHub observe, and what did the receiver actually do? TrueForge investigators collect those observations through narrow MCP boundaries. Redrive compares them with deterministic code. If the receiver already mutated business state, replay stays blocked.

If repair is needed, Redrive reproduces the failure at the exact failing revision in a Daytona sandbox, verifies the repair against the business invariant, and keeps deployment and redelivery behind separate human permits.

**[Watch the demo](https://youtu.be/DMn5PX3MuEs)** · **[Demo receiver](https://github.com/Redrive-Labs/redrive-demo-receiver)** · **[Architecture notes](docs/ARCHITECTURE.md)**

![Redrive recovery cockpit](.visual-review/ship-desktop-polished.png)

---

## The failure Redrive is built for

A webhook returning `500` does not prove that nothing happened.

A receiver can persist a business mutation, fail during a later downstream call, and still return an error to GitHub:

```text
GitHub sees:     HTTP 500
Receiver state: mutationCount = 1 / EXACTLY_ONE
```

Blindly retrying that delivery can duplicate the mutation.

> **No proof, no retry.**

For the canonical incident, the evidence chain is:

```text
GitHub
HTTP 500
    │
    ├──────────────────┐
    │                  │
    ▼                  ▼
Provider            Receiver
Investigator        Investigator
    │                  │
HTTP 500           EXACTLY_ONE
    │                  │
    └────────┬─────────┘
             ▼
      deterministic
        comparison
             │
             ▼
PROVIDER_FAILED_RECEIVER_MUTATED
             │
             ▼
         RETRY UNSAFE
             │
             ▼
           BLOCKED
```

The investigators collect observations. The contradiction itself is not an LLM judgement.

---

## The product flow

Once setup is complete, the whole incident path runs through the Redrive UI:

```text
GitHub READY
Receiver READY
Application RECOVERY READY
        ↓
failed GitHub delivery appears
        ↓
Investigate delivery
        ↓
persisted incident cockpit
        ↓
Investigate failure
        ↓
TrueForge Coordinator
  ├─ Provider Investigator → GitHub MCP
  └─ Receiver Investigator → Receiver MCP
        ↓
HTTP 500 + EXACTLY_ONE
        ↓
PROVIDER_FAILED_RECEIVER_MUTATED
RETRY UNSAFE / BLOCKED
        ↓
Start sandbox recovery
        ↓
Daytona reproduce → repair → verify
        ↓
REPAIR_VERIFIED
        ↓
DeployPermit + human approval
        ↓
Execute approved deployment
        ↓
independent deployment verification
        ↓
RedrivePermit + human approval
        ↓
Execute one GitHub redelivery
        ↓
independent final observation
```

The shell helpers under `scripts/` are development conveniences. They are not required to run the product flow above.

---

## What Redrive does differently

| Question | Redrive's answer |
|---|---|
| GitHub returned `500`. Retry? | Not until receiver state is known. |
| Who decides whether the evidence conflicts? | Deterministic Redrive code. |
| Can the agent query production however it wants? | No. It gets fixed, typed, read-only evidence capabilities. |
| Is a generated patch a verified repair? | No. Redrive must reproduce the failure and prove replay safety. |
| Is HTTP `2xx` enough after replay? | No. The business mutation must still exist exactly once. |
| Can the repair agent deploy its own patch? | No. Deployment needs a separate permit and human approval. |
| Does deployment approval authorize redelivery? | No. Redelivery has its own permit. |
| What if an external action has an ambiguous result? | Redrive fences it instead of blindly repeating it. |

> **AI reasons. Integrations observe. Deterministic code proves. Humans authorize.**

---

## TrueForge is the runtime

TrueForge runs the agent side of Redrive. It owns the persistent incident session, dynamic investigators, MCP execution, Skills, persisted tool events, and the separate recovery session.

| TrueForge capability | How Redrive uses it |
|---|---|
| Persistent sessions | One incident-bound Coordinator session survives investigation turns and Redrive restarts. |
| Dynamic subagents | The Coordinator creates Provider and Receiver Investigators. |
| MCP tools | Investigators read real GitHub and receiver evidence through separate boundaries. |
| Skills | Investigation procedures are versioned as git-backed TrueForge Skills. |
| Persisted events | Redrive correlates the child thread, tool call, `tool.response`, turn, and session that produced evidence. |
| Sandbox | Recovery runs in Daytona without provider, receiver, deployment, redelivery, or approval tools. |
| Separate recovery session | Repair work is isolated from the persistent investigation session. |

Agent prose is never accepted as evidence:

```text
dynamic investigator
        ↓
specific MCP tool call
        ↓
correlated TrueForge tool.response
        ↓
strict deterministic parser
        ↓
durable evidence
```

If the expected thread, MCP server, tool, arguments, or response cannot be correlated, the investigation fails closed.

### Durable investigation retries

The UI action `Investigate failure` is protected by a durable SQLite investigation record. Provider and Receiver stages use persisted operation markers and TrueForge turn attribution.

That means a refresh, concurrent request, lost HTTP response, or Redrive restart does not blindly create a second investigation chain. Redrive reuses completed evidence, reports in-progress work, reconciles ambiguous turn creation, and can resume the Receiver stage after a completed Provider stage.

### MCP evidence boundaries

TrueForge sees two separately authenticated Redrive MCP resources:

```text
redrive-github
  get_webhook_delivery

redrive-receiver
  get_business_state
  get_receiver_health
```

The Provider Investigator reads one delivery through the persisted GitHub ApplicationConnection. The Receiver Investigator independently reads business state for the same delivery GUID.

The model does not choose arbitrary repositories, webhook IDs, SQL queries, shell commands, or production credentials.

---

## Architecture

```mermaid
flowchart TD
    GH["GitHub"] -->|read-only delivery evidence| PI["Provider Investigator"]

    RX["Customer Receiver"] --> RC["Outbound Receiver Connector"]
    RC -->|typed read jobs| RMCP["Receiver MCP"]
    RMCP --> RI["Receiver Investigator"]

    subgraph TF["TrueForge: persistent incident session"]
        CO["Recovery Coordinator"]
        PI
        RI
    end

    PI --> CO
    RI --> CO
    CO --> DA["Deterministic Assessor"]

    DA -->|"HTTP 500 + EXACTLY_ONE"| BLOCK["RETRY UNSAFE / BLOCKED"]

    BLOCK --> RS["Separate TrueForge recovery session"]
    RS --> DAY["Daytona sandbox"]
    DAY --> REP["Reproduce exact failing revision"]
    REP --> FIX["Generate repair"]
    FIX --> VERIFY["Verify replay safety"]

    VERIFY --> DP["DeployPermit"]
    DP --> HA1["Human approval"]
    HA1 --> DEPLOY["Deploy verified candidate"]
    DEPLOY --> DV["Verify deployed identity"]

    DV --> RP["RedrivePermit"]
    RP --> HA2["Second human approval"]
    HA2 --> REDRIVE["Exactly one GitHub redelivery"]
    REDRIVE --> FINAL["Independent final observation"]
```

The useful boundary is where trust changes hands. Agents collect and reason. Redrive decides from persisted evidence. Humans authorize production-changing actions.

---

## Receiver evidence stays narrow

Receiver truth comes through a separately deployed outbound connector:

```text
Redrive
   │
   │ durable typed read job
   ▼
Receiver Connector
   │
   │ fixed local adapter
   ▼
Customer system
```

The connector exposes only:

```text
get_business_state(connection_id, delivery_guid)
get_receiver_health(connection_id)
```

It does not expose generic SQL, shell, SSH, or arbitrary URL execution. The receiver database credentials stay in the receiver environment.

For the canonical live observation:

```text
mutationCount = 1
businessState = EXACTLY_ONE
```

The underlying row count stayed unchanged while Redrive observed it:

```text
PRE   = 1
POST  = 1
FINAL = 1
```

---

## Recovery proves the repair

Recovery runs in a separate TrueForge session backed by Daytona. The recovery agent starts at the exact failing revision and first reproduces the incident:

```text
0 → HTTP 500 → 1
```

The demo receiver persists the event and then calls a downstream service with the wrong delivery field. The downstream contract expects `deliveryId`. The bad request fails after the database write, so GitHub sees `500` even though the mutation exists.

A patch is not accepted just because it compiles. Redrive verifies the same logical delivery against the already-mutated sandbox state:

```text
1 → HTTP 201 → 1
```

The accepted recovery artifact from our validated run recorded:

```text
State:        REPAIR_VERIFIED
Reproduction: 0 → HTTP 500 → 1
Verification: 1 → HTTP 201 → 1

Patch SHA-256:
6496e9635406f56d19f08bab431ceda87005ea32d543375aade59d84ee960a39
```

Calling the recovery path again returned the same accepted TrueForge turn and patch artifact instead of silently generating a second candidate.

---

## Deployment and redelivery need separate permits

A verified repair is not permission to mutate the receiver.

A DeployPermit binds approval to one exact recovery candidate and fingerprint. After deployment, Redrive independently verifies receiver state and health before a RedrivePermit can become eligible.

A RedrivePermit authorizes exactly one GitHub redelivery of the original delivery.

```text
repair verified
    ↓
DeployPermit
    ↓
human approval
    ↓
deploy + verify
    ↓
RedrivePermit
    ↓
human approval
    ↓
one GitHub redelivery
```

If the outcome of deployment or redelivery becomes ambiguous, Redrive does not issue an automatic retry.

Our final external redelivery validation returned `HTTP 504`. Redrive preserved the ambiguity and stopped, so we do not claim that incident reached `RECOVERY_COMPLETE`.

---

## Fidelity is explicit

GitHub's delivery API does not guarantee the original raw webhook request bytes, while webhook signatures authenticate those bytes. Redrive does not describe a reconstructed sandbox request as an exact raw-wire replay.

The recovery path records the fidelity of each input:

```text
EXACT
REAL_LOCAL
REPOSITORY_FIXTURE
RECORDED
RECONSTRUCTED
DERIVED
UNRESOLVED
```

For example:

```text
Application revision       EXACT
Webhook semantic payload   EXACT
Original signature         RECORDED
Original raw body          unavailable
Sandbox request body       RECONSTRUCTED
Sandbox signature          DERIVED
PostgreSQL                 REAL_LOCAL
```

If a causally required dependency remains `UNRESOLVED`, recovery stays blocked.

---

## Qodo review changed the implementation

Qodo was used as a code review loop throughout the build. Its findings led to fixes around TrueForge session recovery, provenance consistency, GitHub control-plane authorization, sandbox artifact binding, stale recovery state, deployment TOCTOU, and the final UI investigation path.

PR #10 is a good example. Qodo found that the new `Investigate failure` action could create duplicate TrueForge turns after a lost response or concurrent retry. The fix added durable investigation serialization, stage markers, turn reconciliation, restart recovery, and regression coverage before the PR was merged.

Useful review trails:

- [PR #3: persistent TrueForge provider investigation spine](https://github.com/Redrive-Labs/Redrive/pull/3)
- [PR #4: production GitHub App and provider investigation](https://github.com/Redrive-Labs/Redrive/pull/4)
- [PR #7: proof-gated recovery loop](https://github.com/Redrive-Labs/Redrive/pull/7)
- [PR #10: product-native incident investigation flow](https://github.com/Redrive-Labs/Redrive/pull/10)

---

# Run the complete flow

This path exercises setup, real GitHub delivery evidence, Receiver evidence, TrueForge investigation, Daytona recovery, deployment approval, deployment, redelivery approval, and one GitHub redelivery.

Use a fork of the demo receiver. Do not point this walkthrough at a production application.

The examples use:

```text
Redrive control plane   http://127.0.0.1:3001
TrueForge               http://127.0.0.1:8790
Demo receiver           http://127.0.0.1:3000
Demo PostgreSQL         127.0.0.1:5434
```

## Prerequisites

- Node.js 22+
- npm
- git, curl, and OpenSSL
- Docker Engine and Docker Compose
- TrueForge
- a configured TrueForge model provider
- a configured Daytona sandbox provider in TrueForge
- a GitHub account that can create and install a GitHub App on the demo receiver fork
- public HTTPS endpoints for Redrive and the demo receiver

TrueForge currently uses Daytona as its sandbox provider. Configure the model and Daytona in TrueForge before starting the recovery flow.

---

## 1. Start TrueForge

```bash
npx @truefoundry/trueforge@latest --port 8790
```

Open TrueForge. Configure the model resource Redrive should use and configure the Daytona sandbox provider. Keep TrueForge running and note the exact model resource name.

---

## 2. Fork and clone the demo receiver

Fork:

https://github.com/Redrive-Labs/redrive-demo-receiver

Then clone your fork:

```bash
cd ~
git clone https://github.com/<your-user>/redrive-demo-receiver.git
cd redrive-demo-receiver
```

The walkthrough uses this local clone as both the intentionally broken receiver and the deployment target after Redrive verifies a repair.

---

## 3. Start the broken receiver

Choose a webhook secret and keep it for the GitHub webhook configuration:

```bash
export WEBHOOK_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

The stack starts the receiver on `127.0.0.1:3000` and PostgreSQL on `127.0.0.1:5434`.

Expose port `3000` over public HTTPS. With Tailscale Funnel, for example:

```bash
sudo tailscale funnel --https=8443 --bg 3000
sudo tailscale funnel status
```

GitHub must be able to reach:

```text
https://<receiver-public-host>/webhooks/github
```

---

## 4. Clone and configure Redrive

In another terminal:

```bash
cd ~
git clone https://github.com/Redrive-Labs/Redrive.git
cd Redrive
npm ci
cp .env.example .env.local
```

Create an operator token:

```bash
openssl rand -hex 32
```

Put the base configuration in `.env.local`:

```env
REDRIVE_DATABASE_PATH=.local/redrive.sqlite
REDRIVE_OPERATOR_TOKEN=<64-hex-character-token>
REDRIVE_PUBLIC_URL=https://<your-public-redrive-host>
REDRIVE_TRUEFORGE_URL=http://127.0.0.1:8790
REDRIVE_TRUEFORGE_MODEL=<your-trueforge-model-resource>
REDRIVE_DEMO_RECEIVER_REPO_PATH=/absolute/path/to/your/redrive-demo-receiver
```

`REDRIVE_DEMO_RECEIVER_REPO_PATH` must be the absolute path to the local demo receiver fork from step 2. Redrive checks that this path is the Git repository root, that its `HEAD` matches the failing revision, and that the worktree is clean before applying a verified patch.

Expose Redrive on public HTTPS as well. With Tailscale Funnel:

```bash
sudo tailscale funnel --bg 3001
sudo tailscale funnel status
```

Use the reported HTTPS origin as `REDRIVE_PUBLIC_URL`.

---

## 5. Bootstrap Redrive's TrueForge resources

From the Redrive repository:

```bash
export REDRIVE_TRUEFORGE_MODEL=<your-trueforge-model-resource>
export REDRIVE_MCP_BASE_URL=http://127.0.0.1:3001
bash scripts/setup-trueforge.sh
```

The helper registers:

```text
MCP:   redrive-github
MCP:   redrive-receiver
Skill: redrive-connection-provider-investigation
Skill: redrive-connection-receiver-investigation
```

It also writes distinct MCP credentials into `.env.local` without printing them.

Start Redrive after the helper has written those credentials:

```bash
npm run dev -- --port 3001
```

In another terminal, verify the MCP resources:

```bash
bash scripts/setup-trueforge.sh --verify
```

Expected tools:

```text
redrive-github
  get_webhook_delivery

redrive-receiver
  get_business_state
  get_receiver_health
```

---

## 6. Add the GitHub webhook to your receiver fork

In the fork, open:

```text
Settings → Webhooks → Add webhook
```

Use:

```text
Payload URL:  https://<receiver-public-host>/webhooks/github
Content type: application/json
Secret:       the same WEBHOOK_SECRET from step 3
Events:       Push events
Active:       enabled
```

Redrive protects an existing repository webhook. It does not create the receiver webhook itself.

---

## 7. Create the GitHub App from Redrive

Open Redrive at `REDRIVE_PUBLIC_URL` and log in with `REDRIVE_OPERATOR_TOKEN`.

In the setup section:

1. Click `Create GitHub App`.
2. Continue through the GitHub handoff.
3. Create the app on your account or organization.
4. Install it only on the demo receiver fork.
5. Back in Redrive, choose the fork and the webhook from step 6.
6. Click `Save connection`.

Redrive now has a durable ApplicationConnection bound to the GitHub App installation, repository, and existing webhook.

---

## 8. Enroll the Receiver Connector

After the connection is saved, Redrive shows a one-time enrollment token and the connector command directly in the UI.

From the Redrive repository, run the same command shown there:

```bash
cd receiver-connector
npm ci

export REDRIVE_URL=http://127.0.0.1:3001
export REDRIVE_ENROLLMENT_TOKEN=<one-time-token-from-redrive>
export REDRIVE_OBSERVER_DATABASE_URL=postgresql://receiver:receiver_dev_password@127.0.0.1:5434/receiver
export REDRIVE_RECEIVER_HEALTH_URL=http://127.0.0.1:3000/health
export REDRIVE_CONNECTOR_STATE_DIR="$PWD/.local/state"

npm run receiver-connector
```

Keep the connector running. Redrive should reach:

```text
GitHub      READY
Receiver    READY
Application RECOVERY READY
```

The enrollment token is one-time. The connector persists its identity under `REDRIVE_CONNECTOR_STATE_DIR`, so later restarts do not need the original token.

---

## 9. Trigger the ambiguous failure

In the demo receiver fork:

```bash
git commit --allow-empty -m "test: trigger webhook"
git push
```

GitHub sends the push webhook to the broken receiver. The receiver persists one business row and then returns `500` after the downstream failure.

Leave the local receiver repository at this exact pushed `HEAD` and keep its worktree clean. Redrive later verifies that identity before deployment.

---

## 10. Investigate the failed delivery in Redrive

Return to the Redrive UI.

When the ApplicationConnection is `RECOVERY READY`, the `Failed deliveries` section loads GitHub's failed deliveries for that bound webhook.

1. Find the `HTTP 500` delivery you just triggered.
2. Click `Investigate delivery`.
3. Redrive creates or reopens the connection-bound incident and opens its cockpit.
4. Click `Investigate failure`.
5. Wait for the TrueForge Provider and Receiver investigation to finish.

The cockpit should then show the persisted evidence and deterministic assessment:

```text
Provider                 HTTP 500
Receiver mutation count  1
Receiver business state  EXACTLY_ONE
Contradiction             PROVIDER_FAILED_RECEIVER_MUTATED
Retry                     UNSAFE / BLOCKED
```

The investigation action is durable. Retrying or refreshing does not intentionally create a second Provider and Receiver turn chain for the same completed investigation.

---

## 11. Run sandbox recovery

In the same incident cockpit, click:

```text
Start sandbox recovery
```

Redrive creates the separate TrueForge recovery session with Daytona enabled. The recovery agent checks out the exact failing repository revision, reproduces the failure, diagnoses the bug, produces a candidate patch, and verifies the same logical delivery against the already-mutated sandbox state.

The expected proof shape is:

```text
reproduction: 0 → HTTP 500 → 1
verification: 1 → HTTP 2xx → 1
state:        REPAIR_VERIFIED
```

Do not move to deployment unless the cockpit reaches `REPAIR_VERIFIED` and shows the patch provenance.

---

## 12. Approve and execute deployment

Once the repair is verified, the Deploy Permit panel becomes eligible.

1. Review the candidate fingerprint and patch digest.
2. Click `Review & approve deployment`.
3. Click `Execute approved deployment`.

Redrive checks that `REDRIVE_DEMO_RECEIVER_REPO_PATH` points to the clean local repository at the exact failing revision before it applies the verified patch. It then verifies the receiver after deployment.

Continue only when the cockpit reports the deployment as verified.

---

## 13. Approve one GitHub redelivery

After deployment verification, the Redrive Permit panel becomes eligible.

1. Review the original delivery identity, verified deployment, receiver count, and fingerprint.
2. Click `Approve exactly one GitHub redelivery`.
3. Click `Execute one GitHub redelivery`.

Redrive consumes the permit for one delivery attempt and performs an independent final observation afterward.

If the result is ambiguous, the cockpit moves to `OUTCOME UNKNOWN` and automatic retry stays disabled. Do not manually repeat the action just to force a green result.

---

## Validation

Repository checks:

```bash
npm run lint
npm test
npm run typecheck
npm run build
```

The final incident-investigation integration passed 592 tests, lint, typecheck, and `git diff --check` before merge. In the development VPS used for the project, the Next.js Turbopack production build remained blocked by an environment-specific helper-process port `EPERM` error.

The recovery path has also been exercised with live GitHub delivery evidence, the outbound Receiver Connector, persisted TrueForge sessions and turns, deterministic contradiction proof, Daytona repair verification, human permits, deployment verification, and a single permitted GitHub redelivery.

---

## Tech stack

| Layer | Technology |
|---|---|
| Control plane | Next.js 16 / TypeScript |
| Durable state | SQLite |
| Agent runtime | TrueForge |
| Agent integration | MCP |
| Recovery sandbox | Daytona |
| Provider | GitHub App + GitHub Webhooks |
| Receiver evidence | Outbound Receiver Connector |
| Demo receiver | Node.js / Express |
| Demo receiver database | PostgreSQL |
| Local runtime | Docker Compose |
| Code review | Qodo |

---

## Invariants

```text
A provider failure does not prove receiver absence.

Model prose is not evidence.

Provider and receiver observations are independent.

Unknown is not false.

A generated patch is not a verified repair.

A verified repair is not permission to deploy.

Permission to deploy is not permission to redeliver.

An ambiguous external action must not be blindly repeated.
```

The final recovery condition is stricter than transport success:

```text
provider redelivery succeeds
AND
business mutation count is exactly one
AND
required downstream operation succeeds
```

Until those facts can be established for the same logical delivery, Redrive does not claim recovery is complete.

---

## Prove what happened. Repair it. Then recover.

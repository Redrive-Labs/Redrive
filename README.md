# Redrive

> **Failed doesn't mean safe to retry.**

Redrive is a proof-gated recovery control plane for ambiguous webhook failures.

When GitHub reports a failed delivery, Redrive does not jump straight to replay. It asks two independent questions first: what did GitHub observe, and what did the receiver actually do? TrueForge investigators collect those facts through narrow MCP boundaries. Redrive then compares them with deterministic code. If the receiver already mutated business state, replay stays blocked.

If repair is needed, Redrive reproduces the failure at the exact failing revision in an isolated Daytona sandbox, verifies the candidate against the business invariant, and keeps deployment and redelivery behind separate human permits.

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

Retrying that delivery blindly can duplicate the mutation.

Redrive's rule is simple:

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

## What stands apart

Redrive is deliberately not a generic incident chatbot.

| Question | Redrive's answer |
|---|---|
| GitHub returned `500`. Retry? | Not until receiver state is known. |
| Who decides whether the evidence conflicts? | Deterministic Redrive code. |
| Can the agent query production however it wants? | No. It gets fixed, typed, read-only evidence capabilities. |
| Is a generated patch a verified repair? | No. Redrive must reproduce the failure and prove replay safety. |
| Is HTTP `2xx` enough after replay? | No. The business mutation must still exist exactly once. |
| Can the repair agent deploy its own patch? | No. Deployment needs a separate permit and human approval. |
| Does deployment approval authorize redelivery? | No. Redelivery has its own permit. |
| What if a consequential action has an ambiguous result? | Redrive fences it instead of blindly repeating it. |

The split is intentional:

> **AI reasons. Integrations observe. Deterministic code proves. Humans authorize.**

---

## TrueForge is the runtime spine

TrueForge is not a decorative chat layer around Redrive. It runs the agent side of the system.

| TrueForge capability | How Redrive uses it |
|---|---|
| **Persistent sessions** | One incident-bound Coordinator session survives investigation turns and Redrive restarts. |
| **Dynamic subagents** | The Coordinator creates specialized Provider and Receiver Investigators. |
| **MCP tools** | Investigators obtain real GitHub and receiver measurements through separate read-only boundaries. |
| **Skills** | Investigation procedures are versioned as git-backed TrueForge Skills. |
| **Persisted events** | Redrive correlates the exact child thread, tool call, `tool.response`, turn and session that produced evidence. |
| **Sandbox support** | Agent work runs without handing production credentials to generated code. |
| **Separate recovery session** | Repair work is isolated from the persistent incident-investigation session. |
| **Execution provenance** | Session and turn identities are stored and surfaced in the cockpit. |

A key rule is that **agent prose is never evidence**.

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

If the intended thread, MCP server, tool, arguments or response cannot be correlated, the investigation fails closed.

### The two MCP evidence boundaries

TrueForge sees two separately authenticated Redrive MCP resources:

```text
redrive-github
  get_webhook_delivery

redrive-receiver
  get_business_state
  get_receiver_health
```

The Provider Investigator is expected to call only `get_webhook_delivery` for the supplied connection and delivery identity. The Receiver Investigator independently calls `get_business_state` for the supplied connection and delivery GUID.

This is role-separated evidence collection with deterministic attribution. Redrive does not rely on the model to remember which facts came from which side.

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

The important part is where trust changes hands, not how many agents appear in the diagram.

---

## Provider evidence

The GitHub side exposes one narrow read operation:

```text
get_webhook_delivery(connection_id, delivery_id)
```

`connection_id` resolves the persisted GitHub App installation, repository and webhook inside Redrive. The model does not choose arbitrary repositories, hook IDs, API URLs or credentials.

For the real contradiction run, GitHub reported:

```text
HTTP 500
```

---

## Receiver evidence

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

The initial capability surface is intentionally small:

```text
get_business_state(connection_id, delivery_guid)
get_receiver_health(connection_id)
```

The connector does not expose generic SQL, shell, SSH or arbitrary URL execution. Database credentials remain in the receiver environment.

For the canonical live observation:

```text
mutationCount = 1
businessState = EXACTLY_ONE
```

The underlying business-row count stayed unchanged while Redrive observed it:

```text
PRE   = 1
POST  = 1
FINAL = 1
```

Observation itself did not create another mutation.

---

## The contradiction is deterministic

The assessor combines the two accepted observations:

```text
provider failed
+
receiver mutationCount >= 1
=
PROVIDER_FAILED_RECEIVER_MUTATED
```

For our incident:

```text
Provider:  HTTP 500
Receiver:  mutationCount = 1 / EXACTLY_ONE
Result:    PROVIDER_FAILED_RECEIVER_MUTATED
Recovery:  BLOCKED
```

At this point Redrive has repaired nothing. It has simply established enough reality to know that blind replay is unsafe.

---

## Recovery starts from the exact failure

Recovery runs in a separate TrueForge session backed by a Daytona sandbox.

The recovery agent starts at the exact failing revision:

```text
5bfadf93d5233e4e6cfe0fdb19ad1b78328a5d79
```

Before changing code, it reproduces the incident:

```text
0 → HTTP 500 → 1
```

That means the sandbox began with zero matching business rows, the request failed, and one mutation nevertheless appeared.

The real bug was simple but dangerous: the receiver persisted the event and then called a downstream service with the wrong delivery field. The downstream contract expected `deliveryId`; the receiver sent the wrong key. The downstream call failed after the database write, so GitHub saw `500` even though the mutation already existed.

The recovery agent diagnosed that path in the sandbox. It was not handed a canned patch.

### Verification

A candidate is not accepted because it compiles. Redrive sends the same logical delivery against the already-mutated sandbox state and checks the invariant again:

```text
1 → HTTP 201 → 1
```

The request now succeeds without increasing the mutation count.

The accepted artifact recorded:

```text
State:        REPAIR_VERIFIED
Reproduction: 0 → HTTP 500 → 1
Verification: 1 → HTTP 201 → 1

Patch SHA-256:
6496e9635406f56d19f08bab431ceda87005ea32d543375aade59d84ee960a39
```

Calling the recovery path again returned the same accepted TrueForge turn and patch artifact instead of silently generating a second candidate.

---

## Human gates are separate on purpose

A verified repair is still not permission to mutate production.

### DeployPermit

A DeployPermit authorizes one exact verified repair against one exact recovery state. Relevant state drift invalidates eligibility.

### RedrivePermit

Deployment approval does not authorize replay. Redrive first verifies the deployed receiver, then creates a separate RedrivePermit for the original delivery.

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
second human approval
    ↓
one redelivery
```

The two permits exist because the two actions carry different risks.

---

## When the result is ambiguous, Redrive stops

Our final external redelivery test did not end in a neat success screen. The single permitted GitHub redelivery returned:

```text
HTTP 504
```

That is ambiguous. Redrive did not reinterpret it as success, and it did not issue another blind redelivery.

We therefore do **not** claim that incident reached `RECOVERY_COMPLETE`.

That is an important part of the product: when reality gets less certain, the automation becomes more conservative.

---

## Fidelity is explicit

GitHub's delivery API does not guarantee the original raw request bytes, yet webhook signatures authenticate those bytes. Redrive does not pretend that a reconstructed sandbox request is an exact raw-wire replay.

The recovery path records what kind of evidence it actually has:

```text
EXACT
REAL_LOCAL
REPOSITORY_FIXTURE
RECORDED
RECONSTRUCTED
DERIVED
UNRESOLVED
```

Example:

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

## The cockpit is a proof surface

Redrive's primary UI is an incident cockpit, not a chat transcript. It projects durable backend state:

- provider observation;
- receiver cardinality;
- deterministic contradiction;
- retry-safety state;
- TrueForge provenance;
- recovery stages;
- repair verification;
- deployment state;
- DeployPermit and RedrivePermit;
- redelivery and final verification state.

The frontend does not invent a parallel workflow. It renders the state Redrive has actually persisted.

---

## What we live-validated

### Persistent TrueForge investigation

A Redrive incident created a TrueForge session, persisted the binding, and reused the same remote session after a Redrive restart.

### Dynamic investigators

Persisted TrueForge events showed the real provider chain:

```text
Coordinator
    ↓
create_sub_agent
    ↓
provider-investigator
    ↓
redrive-github MCP
    ↓
get_webhook_delivery
    ↓
tool.response
```

The receiver side followed the same pattern through its independent MCP boundary.

### Outbound receiver connector

The connector was exercised through enrollment, durable connector identity, health, typed business-state jobs and restart. Restarting without the one-time enrollment token reused the same enrolled identity.

### Contradiction

```text
GitHub HTTP 500
+
Receiver mutationCount = 1 / EXACTLY_ONE
=
PROVIDER_FAILED_RECEIVER_MUTATED
→ BLOCKED
```

### Recovery

```text
exact failing revision
→ 0 → HTTP 500 → 1
→ generate repair
→ 1 → HTTP 201 → 1
→ REPAIR_VERIFIED
```

---

## Qodo changed the implementation

Qodo was used as a real review loop rather than a submission checkbox. It surfaced correctness and safety issues around persistent TrueForge session recovery, evidence/provenance consistency, GitHub control-plane authorization, sandbox artifact provenance, stale recovery state and deployment time-of-check/time-of-use behavior.

The loop was straightforward:

```text
implementation
    ↓
Qodo review
    ↓
accepted finding
    ↓
targeted fix
    ↓
regression test
    ↓
follow-up review
```

Useful review trails:

- [PR #3: persistent TrueForge provider investigation spine](https://github.com/Redrive-Labs/Redrive/pull/3)
- [PR #4: production GitHub App and provider investigation](https://github.com/Redrive-Labs/Redrive/pull/4)
- [PR #7: proof-gated recovery loop](https://github.com/Redrive-Labs/Redrive/pull/7)

PR #7 was especially useful: review findings materially hardened sandbox artifact provenance, stale candidate binding and deployment TOCTOU behavior.

---

## Deliberately narrow

For this build we chose one provider, one failure class and one hard invariant:

```text
Provider:      GitHub
Failure class: ambiguous webhook failure
Invariant:     do not duplicate the business mutation
Loop:          investigate → reproduce → repair → verify → authorize → recover
```

A broader agent could demo more categories. Redrive goes deeper on one consequential workflow where "probably safe" is not enough.

---

# Run it

The quickest reproducible path uses separate local ports for the two applications:

```text
Redrive control plane   http://127.0.0.1:3001
TrueForge               http://127.0.0.1:8790
Demo receiver           http://127.0.0.1:3000
Demo PostgreSQL         127.0.0.1:5434
```

## Prerequisites

- Node.js 22+
- npm
- git, curl and OpenSSL
- Docker Engine + Docker Compose for the demo receiver
- TrueForge with one configured model provider
- a public HTTPS URL for Redrive when creating the GitHub App
- a public HTTPS URL for the demo receiver so GitHub can deliver the webhook

Daytona is only required for the sandbox repair stage. The full provider + receiver contradiction can be reproduced without starting recovery.

---

## 1. Start TrueForge

```bash
npx @truefoundry/trueforge@latest --port 8790
```

Open TrueForge and configure one model provider. Note the exact model resource name you want Redrive to use.

---

## 2. Clone Redrive

```bash
git clone https://github.com/Redrive-Labs/Redrive.git
cd Redrive
npm ci
cp .env.example .env.local
```

Create an operator token:

```bash
openssl rand -hex 32
```

Put the token, your public Redrive URL and your TrueForge model in `.env.local`:

```env
REDRIVE_DATABASE_PATH=.local/redrive.sqlite
REDRIVE_OPERATOR_TOKEN=<64-hex-character-token>
REDRIVE_PUBLIC_URL=https://<your-public-redrive-host>
REDRIVE_TRUEFORGE_URL=http://127.0.0.1:8790
REDRIVE_TRUEFORGE_MODEL=<your-trueforge-model-resource>
```

`REDRIVE_PUBLIC_URL` and the MCP URL solve different problems:

- `REDRIVE_PUBLIC_URL` must be public HTTPS for the GitHub App flow.
- TrueForge can talk to Redrive locally through `http://127.0.0.1:3001` when both run on the same machine.

Any public HTTPS tunnel works. For example, with Tailscale Funnel:

```bash
sudo tailscale funnel --bg 3001
sudo tailscale funnel status
```

Use the HTTPS hostname reported by Funnel as `REDRIVE_PUBLIC_URL`. Tailscale documents Funnel as a public HTTPS reverse proxy for a local port.

---

## 3. Bootstrap the TrueForge resources

Redrive includes a helper that registers the two MCP resources, registers the two git-backed investigation Skills, pins the Skills to the current Redrive commit, generates distinct MCP credentials when needed, and updates `.env.local` without printing the secrets.

```bash
export REDRIVE_TRUEFORGE_MODEL=<your-trueforge-model-resource>
export REDRIVE_MCP_BASE_URL=http://127.0.0.1:3001
bash scripts/setup-trueforge.sh
```

It creates or updates:

```text
MCP:   redrive-github
MCP:   redrive-receiver
Skill: redrive-connection-provider-investigation
Skill: redrive-connection-receiver-investigation
```

Now start Redrive with the env that contains those generated credentials:

```bash
npm run dev -- --port 3001
```

In another terminal, verify that TrueForge can actually enumerate the expected MCP tools:

```bash
bash scripts/setup-trueforge.sh --verify
```

Expected result:

```text
redrive-github
  get_webhook_delivery

redrive-receiver
  get_business_state
  get_receiver_health
```

If Redrive was already running before the bootstrap wrote `.env.local`, restart it before running `--verify`.

---

# Reproduce the real ambiguous failure

Use the intentionally broken demo receiver so you do not need to touch an existing application.

## 4. Fork the demo receiver

Fork:

**https://github.com/Redrive-Labs/redrive-demo-receiver**

Then clone **your fork**:

```bash
git clone https://github.com/<your-user>/redrive-demo-receiver.git
cd redrive-demo-receiver
```

A fork matters here because you need permission to install a GitHub App and create a repository webhook.

---

## 5. Start the broken receiver

Choose a webhook secret and keep it for the GitHub webhook configuration:

```bash
export WEBHOOK_SECRET="$(openssl rand -hex 32)"
docker compose up --build
```

The stack starts:

```text
receiver      http://127.0.0.1:3000
PostgreSQL    127.0.0.1:5434
```

The receiver intentionally persists the business event and then fails its downstream operation, producing the ambiguous `500 after mutation` shape.

Expose port `3000` over public HTTPS. If Redrive and the receiver are on the same Tailscale node, one simple option is to expose the receiver on Funnel's alternate HTTPS port:

```bash
sudo tailscale funnel --https=8443 --bg 3000
sudo tailscale funnel status
```

That gives the receiver a URL similar to:

```text
https://<your-funnel-host>:8443
```

You can use another tunnel provider instead; the only requirement is that GitHub can reach `/webhooks/github` over HTTPS.

---

## 6. Add the repository webhook

In **your fork** open:

```text
Settings → Webhooks → Add webhook
```

Use:

```text
Payload URL:  https://<receiver-public-host>/webhooks/github
Content type: application/json
Secret:       the same WEBHOOK_SECRET from step 5
Events:       Push events
Active:       enabled
```

Redrive protects an **existing** repository webhook. It does not create this receiver webhook for you.

---

## 7. Create the Redrive GitHub App

Open Redrive at your public URL, log in with `REDRIVE_OPERATOR_TOKEN`, then open the setup section.

1. Click **Create GitHub App**.
2. Continue through the branded GitHub handoff.
3. Create the app on your account or organization.
4. Install it only on your demo-receiver fork.
5. Back in Redrive, choose the fork and the webhook you created above.
6. Save the connection.

Redrive now has a durable GitHub `ApplicationConnection` bound to the installation, repository and webhook.

---

## 8. Enroll the outbound Receiver Connector

When the GitHub connection is saved, Redrive issues a one-time receiver enrollment token. Copy it while it is visible.

From the **Redrive repository**:

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

Keep the connector running. Redrive should move through receiver verification to:

```text
GitHub      READY
Receiver    READY
Application RECOVERY READY
```

The enrollment token is one-time. The connector persists its durable identity in `REDRIVE_CONNECTOR_STATE_DIR`, so later restarts do not need the original token.

---

## 9. Trigger the failed delivery

Push any small commit to your receiver fork:

```bash
git commit --allow-empty -m "test: trigger webhook"
git push
```

GitHub sends the push webhook to the intentionally broken receiver. The receiver writes one business row and then returns `500` after the downstream failure.

---

## 10. Capture and investigate it

Back in the Redrive repository:

```bash
bash scripts/capture-failed-delivery.sh --investigate
```

If there is exactly one configured GitHub connection and one failed delivery, the helper selects them automatically. If there are several, it prints the available IDs and asks you to rerun with `REDRIVE_CONNECTION_ID` or `REDRIVE_DELIVERY_ID`.

The script logs in to Redrive without printing the operator token, creates the connection-bound incident, and then runs the **read-only** Provider + Receiver investigation through TrueForge.

It never starts sandbox recovery, deploys, approves, or redelivers anything.

The result should resolve to the same contradiction used in the demo:

```text
providerStatusCode:    500
receiverMutationCount: 1
receiverBusinessState: EXACTLY_ONE
contradiction:          PROVIDER_FAILED_RECEIVER_MUTATED
recoveryState:          BLOCKED
```

Open the incident in the Redrive cockpit to inspect the provider evidence, receiver cardinality, TrueForge provenance and recovery spine.

---

## Optional: run sandbox repair

The investigation path above is enough to prove Redrive's core safety decision.

To reproduce the repair stage as well, configure TrueForge with a working Daytona sandbox and use the cockpit's sandbox recovery action for the blocked incident. The recovery agent is constrained to the exact repository, revision and delivery identity and has no provider, receiver, deployment, redelivery or approval tools.

The expected verified shape is:

```text
reproduction: 0 → HTTP 500 → 1
verification: 1 → HTTP 2xx → 1
state:        REPAIR_VERIFIED
```

Deployment and GitHub redelivery remain separate, human-gated actions after that point.

---

## Validation

Core repository checks:

```bash
npm run lint
npm test
npm run typecheck
npm run build
```

The recovery work has also been exercised with live GitHub delivery evidence, a real outbound receiver connector, persisted TrueForge sessions and turns, deterministic contradiction proof, and the Daytona repair flow described above.

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

These rules matter more than any individual prompt:

```text
A provider failure does not prove receiver absence.

Model prose is not evidence.

Provider and receiver observations are independent.

Unknown is not false.

A generated patch is not a verified repair.

A verified repair is not permission to deploy.

Permission to deploy is not permission to redeliver.

An ambiguous consequential action must not be blindly repeated.
```

The final recovery condition is stricter than transport success:

```text
provider redelivery succeeds
AND
business mutation count is exactly one
AND
required downstream operation succeeds
```

Until those facts can be established for the same logical delivery, Redrive should not claim recovery is complete.

---

## Prove what happened. Repair it. Then recover.

# Architecture

## System overview

```text
                         GitHub
                           │
                           │ MCP
                           ▼
                  Provider Investigator
                           │
                           │ provider evidence
                           ▼
                    Recovery Coordinator
                           ▲
                           │ receiver evidence
                           │
                  Receiver Investigator
                           │
                           │ Receiver Ops MCP
                           ▼
                  Receiver Connector
                           │
                    customer-approved
                    operational evidence
                           │
                           ▼
                    customer environment

                    Recovery Coordinator
                           │
                           ▼
                Reproduction Laboratory
                           │
                    TrueForge session
                           │
                        Daytona
                           │
                  receiver @ exact SHA
                           │
                  controlled dependencies
                           │
                           ▼
                       Repair Agent
                           │
                           ▼
                     Replay Verifier
                           │
                           ▼
                     Fidelity Ledger
                           │
                           ▼
                    Eligibility Policy
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
          Deploy approval      Recovery blocked
                 │
                 ▼
              Deploy
                 │
          verify deployment
                 │
                 ▼
         Redelivery approval
                 │
                 ▼
         GitHub redelivery
                 │
                 ▼
        independent verification
```

## Trust boundaries

```text
External provider
      │
      │ controlled MCP
      ▼
TrueForge / Redrive control plane
      │
      │ narrow authenticated MCP
      ▼
Receiver Connector
      │
      │ customer-approved credentials/capabilities
      ▼
Customer environment
```

The Receiver Connector may observe approved production evidence, but Redrive
agents and Daytona do not receive its underlying database, log, deployment, or
infrastructure credentials.

```text
TrueForge / Redrive control plane
      │
      │ sandbox tool
      ▼
Daytona
      │
      │ untrusted experimentation
      ▼
generated candidate

--------------------------------

verified candidate
      │
      │ DeployPermit + TrueForge approval
      ▼
production deployment

--------------------------------

verified deployment
      │
      │ RedrivePermit + second TrueForge approval
      ▼
provider redelivery
```

Sandbox execution produces evidence.

It does not itself authorize production mutation.

## Incident model

One recovery incident should correspond to one persistent TrueForge session.

An incident contains references to:

- provider delivery identity;
- captured provider request evidence;
- provider response;
- receiver repository;
- failing revision;
- receiver-side evidence;
- reproduction environment;
- repair candidates;
- verification results;
- Fidelity Ledger;
- approval/permit state;
- deployment state;
- final verification.

The UI projects these real states rather than manufacturing its own workflow.

## GitHub MCP

The initial provider boundary is a custom GitHub webhook MCP.

Required capabilities include:

```text
get_webhook_delivery(...)
redeliver_webhook_delivery(...)
```

Provider identifiers are opaque strings.

The redelivery operation is consequential and must be permit- and
approval-gated through TrueForge.

## Receiver Connector / Receiver Ops MCP

Receiver-side production truth is obtained through a separately deployed,
least-privilege Receiver Connector.

The connector belongs to the Redrive integration surface. It is not embedded
into the target application repository.

Initial read-only capabilities are:

```text
get_receiver_health()
get_deployed_revision()
get_business_state(delivery_guid)
get_receiver_logs(delivery_guid)
```

The implementation behind those capabilities is customer-defined and
source-enforced. For example, `get_business_state` may query a narrowly scoped
database view/function, an internal API, or an audit ledger.

The connector must not expose generic capabilities such as:

```text
sql_query(...)
shell(...)
ssh_exec(...)
search_all_logs(...)
```

Its underlying credentials remain inside the customer environment and are not
passed to Redrive agents, model context, generated sandbox code, or Daytona.

If the customer has not exposed enough evidence to establish a causally
required fact, Redrive records that fact as `UNRESOLVED` and blocks
consequential recovery rather than escalating privileges or guessing.

A later write capability may be added:

```text
deploy_candidate(...)
```

but it is consequential and must require a runtime-valid `DeployPermit` plus
native TrueForge approval.

## Repository understanding

Redrive first extracts deterministic repository facts.

Examples:

- Compose files and services;
- package manager;
- package scripts;
- lockfiles;
- Dockerfiles;
- CI files;
- ports;
- health checks.

These facts become `RepoFacts`.

The model may then reason about semantic questions such as which service owns
the webhook path.

Its result becomes a structured `EnvironmentPlan`.

The plan must be deterministically validated before execution.

```text
repository
    ↓
RepoFacts
    ↓
agent reasoning
    ↓
EnvironmentPlan
    ↓
PlanValidator
    ↓
execute OR NEEDS_CONFIGURATION
```

## Reproduction laboratory

The current proven sandbox path is:

```text
TrueForge
    ↓
Daytona
    ↓
ensure Docker/dockerd
    ↓
clone target repository
    ↓
checkout exact failing SHA
    ↓
execute validated environment plan
    ↓
start receiver + dependencies
    ↓
construct fidelity-accounted authenticated replay
```

The target repository should not require Redrive-specific configuration for the
hero scenario.

## Dependency representation

Redrive does not need a physically identical copy of all production
infrastructure.

It needs a sufficiently faithful reproduction of the causal execution path.

Important representation modes include:

```text
EXACT
REAL_LOCAL
REPOSITORY_FIXTURE
RECORDED
RECONSTRUCTED
DERIVED
UNRESOLVED
```

The hero environment is expected to resemble:

```text
Application revision          EXACT
Webhook semantic payload      EXACT
Original signature header     RECORDED
Original raw request body     unavailable
Sandbox request body          RECONSTRUCTED
Sandbox signature             DERIVED
PostgreSQL                     REAL_LOCAL
Initial DB state               REPOSITORY_FIXTURE
Controlled downstream HTTP     REAL_LOCAL
```

The original GitHub signature is evidence about the original request. It must
not be assumed to authenticate a reserialized sandbox request body.

A required causal dependency that remains `UNRESOLVED` blocks consequential
recovery.

## Investigation roles

### Provider Investigator

Responsible for:

- delivery identity;
- provider request evidence;
- provider response;
- provider failure state;
- redelivery semantics.

### Receiver Investigator

Responsible for:

- failing revision;
- relevant source;
- receiver-scoped logs;
- approved business-state evidence;
- side effects;
- idempotency behavior.

Receiver production evidence is obtained through the Receiver Connector. The
investigator does not receive arbitrary database, shell, or infrastructure
access.

### Recovery Coordinator

Reconciles the independent evidence.

A central incident class is:

```text
provider says FAILED
AND
receiver says BUSINESS MUTATION EXISTS
```

which means blind replay may be unsafe.

## Repair

Repair begins only inside the Daytona working tree.

```text
failing revision
      ↓
inspect evidence + source
      ↓
generate candidate
      ↓
build/test
      ↓
adversarial replay verification
      ↓
revise if necessary
```

The repair agent is not given a known fixed implementation.

## Verification

The minimum replay verification suite includes:

```text
fidelity-accounted authenticated replay
sequential duplicate replay
concurrent duplicate replay
invalid signature
business invariant
required downstream causal-completion assertion
```

The verifier should try to falsify safety.

A candidate failing any required check is not approval-eligible.

## Fidelity Ledger

The Fidelity Ledger records what the sandbox actually represented.

It is part of authorization, not only UI metadata.

Example:

```text
Application revision          EXACT
Webhook semantic payload      EXACT
Original signature header     RECORDED
Sandbox body                   RECONSTRUCTED
Sandbox signature              DERIVED
PostgreSQL                     REAL_LOCAL
DB state                       REPOSITORY_FIXTURE
Downstream HTTP                REAL_LOCAL
```

If a required causal dependency is:

```text
UNRESOLVED
```

the recovery is blocked.

## Consequential actions

There are two distinct action boundaries:

1. deploy the verified candidate;
2. redrive the original external delivery.

Deployment requires a deterministic, state-bound `DeployPermit` plus its own
TrueForge approval.

Redelivery requires a separate deterministic, state-bound `RedrivePermit` plus
a second TrueForge approval.

Relevant state drift invalidates the permit/approval and requires revalidation.

## Final verification

Redrive does not declare recovery based only on provider transport success.

Final success requires:

```text
provider redelivery succeeds
AND
business mutation count = exactly one
AND
required downstream operation succeeds
```

All final facts must refer to the same logical delivery identity.

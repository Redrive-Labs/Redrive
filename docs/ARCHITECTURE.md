# Architecture

## System overview

```text
                         GitHub
                           │
                           │ MCP
                           ▼
                  Provider Investigator
                           │
                           │ evidence
                           ▼
                    Recovery Coordinator
                           ▲
                           │ evidence
                           │
                  Receiver Investigator
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
      │ TrueForge approval
      ▼
production deployment

--------------------------------

verified deployment
      │
      │ second TrueForge approval
      ▼
provider redelivery
```

Sandbox execution produces evidence.

It does not itself authorize production mutation.

## Incident model

One recovery incident should correspond to one persistent TrueForge session.

An incident contains references to:

- provider delivery identity;
- captured request;
- provider response;
- receiver repository;
- failing revision;
- receiver-side evidence;
- reproduction environment;
- repair candidates;
- verification results;
- Fidelity Ledger;
- approval state;
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

The redelivery operation is consequential and must be approval-gated through
TrueForge.

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
replay captured request
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
UNRESOLVED
```

The initial hero environment is expected to resemble:

```text
Application        EXACT
Webhook request    EXACT
PostgreSQL         REAL_LOCAL
Initial DB state   REPOSITORY_FIXTURE
External HTTP      RECORDED
```

A required causal dependency that remains `UNRESOLVED` blocks consequential
recovery.

## Investigation roles

### Provider Investigator

Responsible for:

- delivery identity;
- provider request;
- provider response;
- provider failure state;
- redelivery semantics.

### Receiver Investigator

Responsible for:

- failing revision;
- relevant source;
- logs;
- database/business state;
- side effects;
- idempotency behavior.

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
exact captured request
sequential duplicate replay
concurrent duplicate replay
invalid signature
business invariant
```

The verifier should try to falsify safety.

A candidate failing any required check is not approval-eligible.

## Fidelity Ledger

The Fidelity Ledger records what the sandbox actually represented.

It is part of authorization, not only UI metadata.

Example:

```text
Application       EXACT
Webhook body      EXACT
Webhook headers   EXACT
PostgreSQL        REAL_LOCAL
DB state          REPOSITORY_FIXTURE
Notifier          RECORDED
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

Each requires its own TrueForge approval.

Approvals should be tied to the exact recovery state rather than a vague
incident intention.

## Final verification

Redrive does not declare recovery based only on provider transport success.

Final success requires:

```text
provider redelivery succeeds
AND
business invariant succeeds
```

For the hero incident:

```text
business mutation count for the provider delivery == 1
```

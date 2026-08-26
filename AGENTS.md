# AGENTS.md

## Product contract

Redrive is a human-in-the-loop recovery system for ambiguous webhook failures.

A failed webhook does not necessarily mean the intended business operation
failed.

The critical failure class is:

```text
provider sends event
        ↓
receiver performs business mutation
        ↓
something fails afterward
        ↓
receiver returns HTTP 500
```

The provider sees a failed delivery while business state may already have
changed.

Blind replay can therefore duplicate the business effect.

Redrive must:

1. retrieve the real failed provider delivery;
2. investigate provider and receiver evidence independently;
3. reproduce the incident in an isolated sandbox;
4. generate a receiver repair;
5. adversarially verify replay safety;
6. account for the fidelity of the reproduced execution path;
7. require human approval before consequential actions;
8. deploy the verified repair;
9. redrive the original provider delivery;
10. independently verify the business effect occurred exactly once.

Redrive is not a generic webhook retry service.

## Hackathon scope

The supported submission path is intentionally narrow:

- GitHub Webhooks;
- one external receiver repository;
- PostgreSQL;
- Docker Compose;
- one controlled external HTTP dependency;
- TrueForge as the agent harness;
- Daytona as the sandbox;
- custom GitHub MCP tools;
- autonomous repair;
- adversarial replay verification;
- human-approved deployment;
- human-approved redelivery;
- independent final verification.

Depth is more important than compatibility breadth.

## Explicit non-goals

Do not implement unless a demonstrated blocker forces reconsideration:

- multiple webhook providers;
- Stripe/Shopify/Svix adapters;
- organization onboarding;
- service catalog or knowledge graph;
- universal monorepo support;
- Nx/Turbo/Bazel-specific engines;
- Kubernetes;
- generic deployment adapters;
- production database cloning;
- production cache extraction;
- generic SRE remediation;
- Redis/Kafka/RabbitMQ merely for complexity;
- a mandatory `.redrive.yaml`;
- chat-first UI;
- fully autonomous production mutation.

Do not create speculative abstractions for these future possibilities.

## Repository integration philosophy

Redrive is convention-first and configuration-light.

Prefer information already present in a repository:

- `compose.yaml`;
- `docker-compose.yml`;
- `Dockerfile`;
- `package.json`;
- lockfiles;
- CI workflows;
- normal development documentation.

Environment reconstruction follows:

```text
deterministic repository facts
        ↓
agent reasoning where semantics are required
        ↓
structured EnvironmentPlan
        ↓
deterministic validation
        ↓
execution
```

If required information cannot be established reliably, return an explicit
state such as:

- `UNKNOWN`;
- `AMBIGUOUS`;
- `NEEDS_CONFIGURATION`;
- `UNRESOLVED`;
- `BLOCKED`.

Do not guess merely to continue execution.

## Demo integrity

The demo receiver lives in a separate repository.

Redrive must not rely on:

- Redrive-specific files inside the receiver;
- hidden setup instructions;
- hardcoded paths unique to the demo receiver;
- a known fixed implementation;
- a canned patch;
- fake provider results;
- fake sandbox execution;
- fake approval;
- timer-driven UI pretending work occurred.

The repair must be generated from the failing revision and incident evidence.

Prewarming infrastructure for demo latency is allowed.

Precomputing the repair is not.

## Truth and evidence

Prefer truth in this order:

1. observed runtime or tool output;
2. explicit machine-readable configuration;
3. current source code;
4. documented project contracts;
5. agent inference.

Agent inference never overrides contradictory machine evidence.

Important claims should retain evidence/provenance.

Examples:

- provider failure → MCP/provider result;
- checked-out revision → `git rev-parse HEAD`;
- business mutation count → database query;
- deployment identity → deployment evidence;
- replay result → actual HTTP response.

LLM prose alone is not proof.

## Safety

Read `docs/INVARIANTS.md` before changing:

- webhook authentication;
- idempotency;
- concurrency handling;
- Fidelity Ledger logic;
- eligibility rules;
- approvals;
- deployment;
- provider redelivery;
- final verification.

Invariant violations are blockers, not warnings.

## TrueForge

TrueForge capabilities must be real and load-bearing.

Use it for:

- agent execution;
- subagents;
- MCP tool calls;
- Daytona sandbox operations;
- session persistence;
- approval pauses.

Do not recreate a fake local equivalent and present it as TrueForge behavior.

One recovery incident should map to one persistent TrueForge session where
practical.

## Daytona

Daytona is the experimentation boundary.

The proven environment path is:

```text
TrueForge
→ Daytona
→ deterministic Docker bootstrap when necessary
→ Docker Compose
→ receiver and controlled dependencies
```

Docker bootstrap is platform plumbing and should be deterministic rather than
invented by the model on every run.

Candidate code must be tested in the sandbox before any production action.

## Runtime roles

Keep the runtime agent structure small.

### Recovery Coordinator

Owns the incident workflow and reconciles evidence.

### Provider Investigator

Owns provider-side facts.

It must not invent receiver state.

### Receiver Investigator

Owns receiver source, runtime, logs, database state, and side effects.

It must not invent provider state.

### Replay Verifier

Acts adversarially against candidate repairs.

Its purpose is to discover unsafe behavior, not help a candidate pass.

Do not create additional agents without a concrete need.

## Candidate repairs

Candidate repairs begin only inside the sandbox.

Do not provide the repair agent with a known correct patch.

For each candidate:

1. build;
2. run relevant existing tests;
3. replay the captured event;
4. test duplicate delivery;
5. test concurrent duplicate delivery;
6. test invalid authentication;
7. verify the business invariant.

If verification fails, return the concrete failure evidence to the repair loop.

Do not call a candidate safe merely because the primary happy path passes.

## Task discipline

For each assigned task:

1. read this file;
2. read only the additional docs relevant to the task;
3. implement the bounded objective;
4. avoid unrelated refactoring;
5. add or update relevant tests;
6. run machine-checkable validation;
7. stop when acceptance criteria are met.

Do not silently expand a task into adjacent roadmap items.

If a task conflicts with the architecture or invariants, report the conflict
instead of resolving it by changing project scope.

## Which docs to read

Always read:

- `AGENTS.md`

For runtime or system-boundary work, also read:

- `docs/ARCHITECTURE.md`

For correctness or consequential-action work, also read:

- `docs/INVARIANTS.md`

The README is primarily public-facing and should not be treated as a hidden
agent specification.

## Testing expectations

Prioritize behavioral integration tests over superficial coverage.

Critical tests include:

- authenticated captured replay;
- invalid signature → zero mutation;
- sequential duplicate delivery;
- concurrent duplicate delivery;
- business invariant verification;
- unresolved fidelity blocking;
- stale approval invalidation;
- exact provider delivery identity.

Concurrency safety requires clean application responses.

Requests crashing while mutation count happens to remain one is not a pass.

## Qodo

Substantive pull requests should receive Qodo review.

Address meaningful findings.

Do not manufacture unnecessary changes merely to generate review activity.

## Completion report

At the end of a task report:

- task or milestone;
- files changed;
- behavior implemented;
- commands/tests run;
- exact result;
- commit SHA if committed;
- known limitations;
- any discovery that invalidates an architectural assumption.

Never claim an acceptance criterion passed unless it was actually observed.

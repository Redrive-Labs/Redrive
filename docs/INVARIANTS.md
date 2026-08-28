# Invariants

## INV-001 — Provider identifiers are opaque strings

Webhook IDs, delivery IDs, GUIDs, and similar external identifiers must remain
strings end-to-end.

They must never be routed through floating-point numeric representation.

## INV-002 — Invalid authentication mutates nothing

For an invalid webhook signature:

```text
request rejected
AND
business mutation count unchanged
```

Authentication must occur before protected business mutation.

## INV-003 — One delivery causes at most one intended business mutation

For delivery identity `D`:

```text
count(intended_business_mutations where delivery_id = D) <= 1
```

This must hold under:

- normal processing;
- sequential duplicate delivery;
- concurrent duplicate delivery;
- provider redelivery.

## INV-004 — Concurrent duplicates terminate cleanly

Duplicate prevention is not considered correct if requests crash while the
database happens to remain unchanged.

The hero acceptance target is:

```text
10 concurrent identical valid deliveries
→ 10 defined application responses
→ intended business mutation count = 1
```

Unhandled exceptions, connection errors, or database-lock crashes fail this
invariant.

## INV-005 — Production credentials remain outside agents and generated sandbox code

Redrive agents, model context, and generated or agent-edited sandbox code must
not receive unrestricted production credentials.

Production observation and mutation belong behind controlled, narrowly scoped
tools or explicitly approved boundaries.

## INV-006 — Sandbox evidence is not production authority

A successful sandbox candidate does not itself authorize deployment.

Production mutation requires deterministic eligibility plus the configured
TrueForge approval boundary.

## INV-007 — Transport success is insufficient

The following does not prove recovery:

```text
provider received HTTP 2xx
```

Final recovery requires:

```text
provider final response successful
AND
business mutation count = exactly one
AND
required downstream causal operation successful
```

A patch that merely returns 2xx or suppresses the original downstream failure
does not satisfy this invariant.

## INV-008 — Unresolved causal dependencies block recovery

If:

```text
dependency.causal = true
AND
dependency.fidelity = UNRESOLVED
```

then:

```text
approvalEligible = false
```

The model cannot override this rule based on confidence or prose reasoning.

## INV-009 — Approval is state-bound

Approval must authorize a specific recovery state.

Relevant identity should include at least:

- provider delivery attempt identity;
- logical delivery GUID;
- captured payload hash;
- candidate identity;
- deployment target;
- business invariant;
- critical fidelity state.

A relevant state change invalidates previous authorization.

## INV-010 — Deployment and redelivery are independently authorized

Approval to deploy code does not imply approval to redrive an external event.

Deployment requires a runtime-valid `DeployPermit` plus its own TrueForge
approval.

Redelivery requires a separate runtime-valid `RedrivePermit` plus a second
TrueForge approval.

Approval to redrive requires the approved candidate to have been deployed and
verified.

## INV-011 — Post-action verification is mandatory

A successful tool call does not establish successful real-world recovery.

After deployment, verify:

- service health;
- deployed candidate identity.

After redelivery, verify:

- provider outcome;
- receiver business invariant;
- required downstream causal operation.

## INV-012 — Evidence must be attributable and machine-observed

Important recovery claims must have machine-observed provenance.

Examples:

```text
provider status      → MCP/provider response
sandbox revision     → git rev-parse
business state       → Receiver Connector observation
HTTP behavior        → observed response
candidate digest     → deterministic hashing
deployment identity  → deployment evidence
verification status  → deterministic verifier output
```

Agent prose alone is not sufficient evidence.

The model may propose a hypothesis, repair, or test strategy, but it may not
author authoritative proof facts such as hashes, counts, verification results,
fidelity status, permits, or deployment identity.

## INV-013 — Unknown safety-critical facts fail closed

When a required fact cannot be reliably established, Redrive should explicitly
enter an appropriate state such as:

```text
UNKNOWN
AMBIGUOUS
NEEDS_CONFIGURATION
UNRESOLVED
BLOCKED
```

It must not invent a value merely to keep the workflow moving.

## INV-014 — Receiver evidence is customer-scoped and least-privilege

Receiver-side production evidence must be exposed through a customer-approved,
least-privilege Receiver Connector or equivalent trusted integration.

The connector may hold narrowly scoped credentials inside the customer
environment, but those credentials must not be exposed to Redrive agents,
model context, generated sandbox code, or Daytona.

The connector must expose domain-specific capabilities rather than generic
production authority.

For example:

```text
allowed:
get_business_state(delivery_guid)
get_receiver_logs(delivery_guid)
get_deployed_revision()
get_receiver_health()

not allowed:
sql_query(...)
shell(...)
ssh_exec(...)
search_all_logs(...)
```

Where possible, the underlying source credential should itself be restricted
to the approved evidence surface, such as a dedicated database view/function,
receiver-scoped log source, or deployment-read API.

If required evidence is outside the customer's granted scope:

```text
UNRESOLVED
→ consequential recovery blocked
```

Redrive must not broaden permissions or infer the missing fact.

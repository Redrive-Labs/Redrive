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

## INV-005 — Production credentials remain outside generated sandbox code

Generated or agent-edited sandbox code must not receive unrestricted production
credentials.

Production interaction belongs behind controlled tools or explicitly approved
boundaries.

## INV-006 — Sandbox evidence is not production authority

A successful sandbox candidate does not itself authorize deployment.

Production mutation requires the configured TrueForge approval boundary.

## INV-007 — Transport success is insufficient

The following does not prove recovery:

```text
provider received HTTP 2xx
```

Final recovery additionally requires the incident-specific business invariant.

For the hero scenario:

```text
provider final response successful
AND
business mutation count = exactly one
```

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

- provider delivery identity;
- captured payload hash;
- candidate identity;
- deployment target;
- business invariant;
- critical fidelity state.

A relevant state change invalidates previous approval.

## INV-010 — Deployment and redelivery are independently authorized

Approval to deploy code does not imply approval to redrive an external event.

Approval to redrive requires the approved candidate to have been deployed and
verified.

## INV-011 — Post-action verification is mandatory

A successful tool call does not establish successful real-world recovery.

After deployment, verify:

- service health;
- deployed candidate identity.

After redelivery, verify:

- provider outcome;
- receiver business invariant.

## INV-012 — Evidence must be attributable

Important recovery claims must have machine-observed provenance.

Examples:

```text
provider status      → MCP/provider response
sandbox revision     → git rev-parse
business state       → database query
HTTP behavior        → observed response
deployment identity  → deployment evidence
```

Agent prose alone is not sufficient evidence.

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

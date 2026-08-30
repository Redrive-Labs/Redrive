import { describe, expect, it } from "vitest";
import {
  deriveRecoveryAssessment,
  PROVIDER_FAILED_RECEIVER_MUTATED,
  RecoveryAssessmentCorrelationError,
} from "@/domain/recovery-assessment";
import type { ProviderEvidence } from "@/domain/provider-evidence";
import type { ReceiverObservation } from "@/domain/receiver-observation";

const providerEvidence: ProviderEvidence = {
  schemaVersion: 1,
  provider: "github",
  repositoryId: "octocat/receiver",
  providerDeliveryId: "delivery-1",
  deliveryGuid: "guid-1",
  incidentId: "incident-1",
  applicationConnectionId: "connection-1",
  event: "push",
  deliveredAt: "2026-08-30T00:00:00.000Z",
  outcome: {
    status: "Invalid HTTP Response: 500",
    statusCode: 500,
  },
  request: {
    headers: { "X-GitHub-Delivery": "guid-1" },
    payload: {},
    canonicalPayloadSha256: "hash",
  },
  response: { headers: {}, body: "failed" },
  redelivery: false,
  capturedAt: "2026-08-30T00:00:01.000Z",
};

function receiverObservation(
  mutationCount: number,
  businessState: ReceiverObservation["businessState"],
): ReceiverObservation {
  return {
    id: "observation-1",
    incidentId: "incident-1",
    applicationConnectionId: "connection-1",
    deliveryGuid: "guid-1",
    capability: "business_state:v1",
    tool: "get_business_state",
    mcpServerName: "redrive-receiver",
    mutationCount,
    businessState,
    observedAt: "2026-08-30T00:00:02.000Z",
    trueForgeSessionId: "session-1",
    turnId: "turn-2",
    receiverInvestigatorThreadId: "receiver-thread-1",
    threadCreatedEventId: "thread-event-1",
    toolCallId: "tool-call-1",
    toolCallEventId: "tool-call-event-1",
    toolResponseEventId: "tool-response-event-1",
    toolResponseCreatedAt: "2026-08-30T00:00:02.000Z",
    createdAt: "2026-08-30T00:00:02.000Z",
  };
}

describe("M2.7B recovery assessment", () => {
  it("derives the provider-failed/receiver-mutated contradiction", () => {
    expect(
      deriveRecoveryAssessment(
        providerEvidence,
        receiverObservation(1, "EXACTLY_ONE"),
      ),
    ).toEqual({
      contradiction: PROVIDER_FAILED_RECEIVER_MUTATED,
      recoveryState: "BLOCKED",
    });
  });

  it.each([
    [null, null],
    [receiverObservation(0, "ABSENT"), null],
    [receiverObservation(2, "MULTIPLE"), null],
    [receiverObservation(1, "ABSENT"), null],
  ] as const)("keeps %j blocked without a contradiction", (receiver, contradiction) => {
    expect(deriveRecoveryAssessment(providerEvidence, receiver)).toEqual({
      contradiction,
      recoveryState: "BLOCKED",
    });
  });

  it("does not claim the contradiction for non-500 provider evidence", () => {
    expect(
      deriveRecoveryAssessment(
        {
          ...providerEvidence,
          outcome: { ...providerEvidence.outcome, statusCode: 200 },
        },
        receiverObservation(1, "EXACTLY_ONE"),
      ),
    ).toEqual({ contradiction: null, recoveryState: "BLOCKED" });
  });

  it.each([
    ["incident", { incidentId: "other-incident" }],
    ["application connection", { applicationConnectionId: "other-connection" }],
    ["delivery GUID", { deliveryGuid: "other-guid" }],
  ] as const)(
    "fails closed for cross-%s evidence correlation",
    (_identity, providerOverrides) => {
    // This form keeps each mismatch in the domain boundary rather than in
    // orchestration setup.
    const provider = { ...providerEvidence, ...providerOverrides };
    expect(() =>
      deriveRecoveryAssessment(provider, receiverObservation(1, "EXACTLY_ONE")),
    ).toThrow(RecoveryAssessmentCorrelationError);
    },
  );

  it("fails closed when persisted provider correlation is absent", () => {
    const { incidentId: _incidentId, applicationConnectionId: _connectionId, ...uncorrelated } =
      providerEvidence;

    expect(() =>
      deriveRecoveryAssessment(
        uncorrelated,
        receiverObservation(1, "EXACTLY_ONE"),
      ),
    ).toThrow(RecoveryAssessmentCorrelationError);
  });
});

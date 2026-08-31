import { describe, expect, it, vi } from "vitest";
import {
  IncidentNotFoundError,
  ProviderEvidenceConflictError,
} from "@/server/incidents/provider-evidence-service";
import {
  ProviderInvestigationEvidenceError,
  ProviderInvestigationTurnError,
} from "@/server/incidents/provider-investigation-service";
import { IncidentInvestigationInProgressError, IncidentInvestigationRetryableError, investigateIncidentForRecovery } from "@/server/incidents/incident-investigation-service";
import { TrueForgeSessionUnavailableError } from "@/server/trueforge/trueforge-session-service";
import { POST } from "@/app/api/incidents/[incidentId]/provider-investigation/route";
import { RecoveryCoordinatorConfigurationError } from "@/agents/recovery-coordinator";
import { TrueForgeSessionCreateError } from "@/server/trueforge/trueforge-client";

vi.mock("@/server/incidents/incident-investigation-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/incidents/incident-investigation-service")
  >("@/server/incidents/incident-investigation-service");
  return {
    ...actual,
    investigateIncidentForRecovery: vi.fn(),
  };
});

const investigateMock = vi.mocked(investigateIncidentForRecovery);

function context(incidentId: string) {
  return { params: Promise.resolve({ incidentId }) };
}

describe("provider investigation API", () => {
  it("maps a missing incident to 404", async () => {
    investigateMock.mockRejectedValueOnce(new IncidentNotFoundError("missing"));

    const response = await POST(new Request("http://localhost"), context("missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Incident not found." });
  });

  it("maps unavailable session and configuration failures without transcript data", async () => {
    for (const [error, status] of [
      [new TrueForgeSessionUnavailableError("incident-3"), 503],
      [new RecoveryCoordinatorConfigurationError("missing model"), 503],
    ] as const) {
      investigateMock.mockRejectedValueOnce(error);
      const response = await POST(
        new Request("http://localhost"),
        context("incident-3"),
      );

      expect(response.status).toBe(status);
      expect(await response.json()).not.toHaveProperty("transcript");
    }
  });

  it("reports an existing durable investigation without starting another one", async () => {
    investigateMock.mockRejectedValueOnce(new IncidentInvestigationInProgressError("incident-active"));

    const response = await POST(new Request("http://localhost"), context("incident-active"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Investigation is already running or awaiting TrueForge reconciliation. Refresh shortly to reuse its persisted result.",
    });
  });

  it("reports a conclusively absent remote reservation as retryable", async () => {
    investigateMock.mockRejectedValueOnce(new IncidentInvestigationRetryableError("incident-retry"));

    const response = await POST(new Request("http://localhost"), context("incident-retry"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "TrueForge did not retain the reserved turn. Retry to start a new serialized investigation attempt.",
    });
  });

  it("returns deterministic product state without transcript data", async () => {
    investigateMock.mockResolvedValueOnce({
      incidentId: "incident-1",
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      evidenceDisposition: "REOBSERVED",
      providerStatus: "Invalid HTTP Response: 500",
      providerStatusCode: 500,
      receiverObservation: {
        id: "observation-1",
        turnId: "receiver-turn-1",
        receiverInvestigatorThreadId: "receiver-thread-1",
        deliveryGuid: "logical-guid-1",
        mutationCount: 1,
        businessState: "EXACTLY_ONE",
        observedAt: "2026-08-25T10:00:05.000Z",
      },
      contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
      recoveryState: "BLOCKED",
    });

    const response = await POST(new Request("http://localhost"), context("incident-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      incidentId: "incident-1",
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      evidenceDisposition: "REOBSERVED",
      providerStatus: "Invalid HTTP Response: 500",
      providerStatusCode: 500,
      receiverObservation: {
        id: "observation-1",
        turnId: "receiver-turn-1",
        receiverInvestigatorThreadId: "receiver-thread-1",
        deliveryGuid: "logical-guid-1",
        mutationCount: 1,
        businessState: "EXACTLY_ONE",
        observedAt: "2026-08-25T10:00:05.000Z",
      },
      contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
      recoveryState: "BLOCKED",
    });
  });

  it.each([
    [new (class extends Error {})(), 500],
    [new ProviderInvestigationTurnError("missing tool evidence"), 502],
    [new TrueForgeSessionCreateError("DEFINITIVE", "session rejected"), 502],
    [new ProviderInvestigationEvidenceError("malformed response"), 422],
    [new ProviderEvidenceConflictError(
      {} as never,
      {} as never,
    ), 409],
  ])("maps provider failures to a closed response", async (error, status) => {
    investigateMock.mockRejectedValueOnce(error);

    const response = await POST(new Request("http://localhost"), context("incident-2"));

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).not.toHaveProperty("transcript");
  });
});

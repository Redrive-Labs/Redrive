import { describe, expect, it, vi } from "vitest";
import {
  IncidentNotFoundError,
  ProviderEvidenceConflictError,
} from "@/server/provider-evidence-service";
import {
  investigateProviderForIncident,
  ProviderInvestigationEvidenceError,
  ProviderInvestigationTurnError,
} from "@/server/provider-investigation-service";
import { TrueForgeSessionUnavailableError } from "@/server/trueforge-session-service";
import { POST } from "@/app/api/incidents/[incidentId]/provider-investigation/route";
import { RecoveryCoordinatorConfigurationError } from "@/agents/recovery-coordinator";
import { TrueForgeSessionCreateError } from "@/server/trueforge-client";

vi.mock("@/server/provider-investigation-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/provider-investigation-service")
  >("@/server/provider-investigation-service");
  return {
    ...actual,
    investigateProviderForIncident: vi.fn(),
  };
});

const investigateMock = vi.mocked(investigateProviderForIncident);

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

  it("returns deterministic product state without transcript data", async () => {
    investigateMock.mockResolvedValueOnce({
      incidentId: "incident-1",
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      evidenceDisposition: "REOBSERVED",
      providerStatus: "Invalid HTTP Response: 500",
      providerStatusCode: 500,
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerEvidence: null as unknown,
  getConfiguredDatabase: vi.fn(),
  getServerConfig: vi.fn(),
  getProviderEvidenceByIncidentId: vi.fn(),
  listReceiverObservations: vi.fn(),
  getRecoveryAttemptByIncidentId: vi.fn(),
  getBindingByIncidentId: vi.fn(),
  listWorkflowEvents: vi.fn(),
  getDeploymentStatusForIncident: vi.fn(),
  getRedriveState: vi.fn(),
}));

vi.mock("@/server/infrastructure/config", () => ({
  getServerConfig: mocks.getServerConfig,
}));
vi.mock("@/server/infrastructure/database", () => ({
  getConfiguredDatabase: mocks.getConfiguredDatabase,
}));
vi.mock("@/server/incidents/provider-evidence-service", () => ({
  createProviderEvidenceService: vi.fn(() => ({
    getByIncidentId: mocks.getProviderEvidenceByIncidentId,
  })),
}));
vi.mock("@/server/receiver/receiver-observation-service", () => ({
  createReceiverObservationService: vi.fn(() => ({
    listByIncidentId: mocks.listReceiverObservations,
  })),
}));
vi.mock("@/server/recovery/recovery-attempt-repository", () => ({
  createRecoveryAttemptRepository: vi.fn(() => ({
    getByIncidentId: mocks.getRecoveryAttemptByIncidentId,
  })),
}));
vi.mock("@/server/trueforge/trueforge-session-binding-repository", () => ({
  createTrueForgeSessionBindingRepository: vi.fn(() => ({
    getByIncidentId: mocks.getBindingByIncidentId,
  })),
}));
vi.mock("@/server/incidents/incident-workflow-event-service", () => ({
  createIncidentWorkflowEventService: vi.fn(() => ({
    listByIncidentId: mocks.listWorkflowEvents,
  })),
}));
vi.mock("@/server/recovery/recovery-deployment-service", () => ({
  getDeploymentStatusForIncident: mocks.getDeploymentStatusForIncident,
}));
vi.mock("@/server/recovery/redrive-service", () => ({
  createConfiguredRedriveService: vi.fn(() => ({
    getState: mocks.getRedriveState,
  })),
}));

import { buildRecoveryCockpitViewModel } from "@/server/recovery/recovery-cockpit-view-model";

const incident = {
  id: "incident-partial",
  provider: "github" as const,
  externalDeliveryId: "delivery-partial",
  repositoryId: "example/receiver",
  status: "OPEN" as const,
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
};

function providerEvidence(outcome: unknown = { status: "Failed", statusCode: 500 }): unknown {
  return {
    deliveryGuid: "delivery-guid-partial",
    event: "push",
    capturedAt: "2026-08-30T12:00:01.000Z",
    outcome,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providerEvidence = null;
  mocks.getConfiguredDatabase.mockReturnValue({});
  mocks.getServerConfig.mockReturnValue({ databasePath: "test.sqlite" });
  mocks.getProviderEvidenceByIncidentId.mockImplementation(
    () => mocks.providerEvidence,
  );
  mocks.listReceiverObservations.mockReturnValue([]);
  mocks.getRecoveryAttemptByIncidentId.mockReturnValue(null);
  mocks.getBindingByIncidentId.mockReturnValue(null);
  mocks.listWorkflowEvents.mockReturnValue([]);
  mocks.getDeploymentStatusForIncident.mockReturnValue(null);
  mocks.getRedriveState.mockResolvedValue(null);
});

describe("buildRecoveryCockpitViewModel partial evidence", () => {
  it("omits provider evidence when no ProviderEvidence exists", async () => {
    const viewModel = await buildRecoveryCockpitViewModel(incident);

    expect(viewModel.provider).toBeUndefined();
    expect(viewModel.incident).toMatchObject({
      id: incident.id,
      deliveryId: incident.externalDeliveryId,
      event: "GitHub webhook",
    });
  });

  it("omits a provider projection when the provider outcome is null", async () => {
    mocks.providerEvidence = providerEvidence(null);

    const viewModel = await buildRecoveryCockpitViewModel(incident);

    expect(viewModel.provider).toBeUndefined();
    expect(viewModel.incident.deliveryGuid).toBe("delivery-guid-partial");
  });

  it("maps a normal provider HTTP 500 outcome without changing its canonical projection", async () => {
    mocks.providerEvidence = providerEvidence();

    const viewModel = await buildRecoveryCockpitViewModel(incident);

    expect(viewModel.provider).toEqual({
      statusCode: 500,
      status: "Failed",
      observed: true,
      observedAt: "2026-08-30T12:00:01.000Z",
      provenance: {
        investigator: "Provider Investigator",
        toolName: "get_webhook_delivery",
        deliveryGuid: "delivery-guid-partial",
      },
    });
  });

  it("renders a partial incident with no receiver or recovery state", async () => {
    const viewModel = await buildRecoveryCockpitViewModel(incident);

    expect(viewModel).toMatchObject({
      incident: { id: incident.id },
      sandbox: { state: "NOT_STARTED" },
    });
    expect(viewModel.receiver).toBeUndefined();
    expect(viewModel.deployment).toBeUndefined();
    expect(viewModel.redrive).toBeUndefined();
  });
});

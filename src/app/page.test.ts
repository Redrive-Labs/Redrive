import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderEvidencePanel } from "@/components/provider-evidence-panel";

const mocks = vi.hoisted(() => ({
  listIncidents: vi.fn(),
  getProviderEvidenceCaptureStatus: vi.fn(),
  getProviderEvidenceByIncidentId: vi.fn(),
}));

vi.mock("@/server/incident-service", () => ({
  listIncidents: mocks.listIncidents,
}));
vi.mock("@/server/provider-evidence-service", () => ({
  getProviderEvidenceCaptureStatus: mocks.getProviderEvidenceCaptureStatus,
  getProviderEvidenceByIncidentId: mocks.getProviderEvidenceByIncidentId,
}));

import Home from "./page";

const incidents = [
  {
    id: "incident-1",
    provider: "github" as const,
    externalDeliveryId: "delivery-1",
    repositoryId: "example/receiver",
    status: "OPEN" as const,
    createdAt: "2026-08-25T09:56:40.78Z",
    updatedAt: "2026-08-25T09:56:40.78Z",
  },
  {
    id: "incident-2",
    provider: "github" as const,
    externalDeliveryId: "delivery-2",
    repositoryId: "example/receiver",
    status: "OPEN" as const,
    createdAt: "2026-08-25T09:56:40.78Z",
    updatedAt: "2026-08-25T09:56:40.78Z",
  },
];

function findPanels(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(findPanels);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }

  const element = value as ReactElement<{ children?: unknown }>;
  if (element.type === ProviderEvidencePanel) {
    return [element.props as Record<string, unknown>];
  }

  return findPanels(element.props?.children);
}

describe("homepage evidence loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listIncidents.mockResolvedValue(incidents);
    mocks.getProviderEvidenceCaptureStatus.mockResolvedValue(
      new Set(["incident-1"]),
    );
  });

  it("loads only capture status and does not load full evidence for each incident", async () => {
    const page = await Home();

    expect(mocks.getProviderEvidenceCaptureStatus).toHaveBeenCalledTimes(1);
    expect(mocks.getProviderEvidenceCaptureStatus).toHaveBeenCalledWith([
      "incident-1",
      "incident-2",
    ]);
    expect(mocks.getProviderEvidenceByIncidentId).not.toHaveBeenCalled();
    expect(findPanels(page).map((props) => props.initialCaptured)).toEqual([
      true,
      false,
    ]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  RecoverySandboxAttemptStateError,
  RecoverySandboxPrerequisiteError,
  startSandboxRecovery,
} from "@/server/recovery-sandbox-service";
import { POST } from "@/app/api/incidents/[incidentId]/recovery/sandbox/route";

vi.mock("@/server/recovery-sandbox-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/server/recovery-sandbox-service")
  >("@/server/recovery-sandbox-service");
  return { ...actual, startSandboxRecovery: vi.fn() };
});

const startMock = vi.mocked(startSandboxRecovery);

function context(incidentId: string) {
  return { params: Promise.resolve({ incidentId }) };
}

describe("sandbox recovery API", () => {
  it("returns the durable attempt and verified artifact", async () => {
    startMock.mockResolvedValueOnce({
      attempt: {
        id: "attempt-1",
        incidentId: "incident-1",
        state: "REPAIR_VERIFIED",
      } as never,
      artifact: { result: "REPAIR_VERIFIED" } as never,
    });

    const response = await POST(
      new Request("http://localhost"),
      context("incident-1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      attempt: {
        id: "attempt-1",
        incidentId: "incident-1",
        state: "REPAIR_VERIFIED",
      },
      artifact: { result: "REPAIR_VERIFIED" },
    });
  });

  it("maps prerequisite and durable state failures without exposing internals", async () => {
    startMock.mockRejectedValueOnce(
      new RecoverySandboxPrerequisiteError("missing evidence"),
    );
    let response = await POST(new Request("http://localhost"), context("i-1"));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "The incident is not eligible for sandbox recovery.",
    });

    startMock.mockRejectedValueOnce(
      new RecoverySandboxAttemptStateError("running", {} as never),
    );
    response = await POST(new Request("http://localhost"), context("i-1"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Sandbox recovery is already running or is blocked.",
    });
  });
});

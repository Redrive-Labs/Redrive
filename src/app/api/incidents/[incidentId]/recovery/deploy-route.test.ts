import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperatorSession, OPERATOR_SESSION_COOKIE } from "@/server/auth/operator-auth";
const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  approve: vi.fn(),
  deploy: vi.fn(),
}));

vi.mock("@/server/recovery/recovery-deployment-service", async () => {
  const actual = await vi.importActual<typeof import("@/server/recovery/recovery-deployment-service")>(
    "@/server/recovery/recovery-deployment-service",
  );
  return {
    ...actual,
    getDeploymentStatusForIncident: mocks.getStatus,
    approveDeploymentPermit: mocks.approve,
    deployRecovery: mocks.deploy,
  };
});

import { GET, POST as postDeploy } from "@/app/api/incidents/[incidentId]/recovery/deploy/route";
import { POST as postPermit } from "@/app/api/incidents/[incidentId]/recovery/deploy-permit/route";

const operatorEnvironment = {
  REDRIVE_OPERATOR_TOKEN: "operator-token-that-is-at-least-32-characters",
} as unknown as NodeJS.ProcessEnv;

function context(incidentId = "incident-1") {
  return { params: Promise.resolve({ incidentId }) };
}

function authenticatedRequest(body?: unknown): Request {
  const session = createOperatorSession(operatorEnvironment);
  return new Request("http://redrive.test", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      cookie: `${OPERATOR_SESSION_COOKIE}=${session}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("deployment API routes", () => {
  const originalToken = process.env.REDRIVE_OPERATOR_TOKEN;

  beforeEach(() => {
    process.env.REDRIVE_OPERATOR_TOKEN = operatorEnvironment.REDRIVE_OPERATOR_TOKEN;
    vi.clearAllMocks();
    mocks.getStatus.mockReturnValue({
      incidentId: "incident-1",
      eligible: true,
      reason: null,
      candidate: { kind: "DEPLOY" },
      fingerprint: "a".repeat(64),
      permit: null,
      deployment: null,
    });
    mocks.approve.mockReturnValue({ id: "permit-1", state: "APPROVED" });
    mocks.deploy.mockResolvedValue({ id: "deployment-1", state: "VERIFIED" });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.REDRIVE_OPERATOR_TOKEN;
    else process.env.REDRIVE_OPERATOR_TOKEN = originalToken;
  });

  it("protects the deployment status route with the existing operator boundary", async () => {
    const response = await GET(new Request("http://redrive.test"), context());
    expect(response.status).toBe(401);
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it("returns status and submits only the exact fingerprint for permit approval", async () => {
    const status = await GET(authenticatedRequest(), context());
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ eligible: true });

    const fingerprint = "a".repeat(64);
    const permit = await postPermit(
      authenticatedRequest({ fingerprint }),
      context(),
    );
    expect(permit.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith("incident-1", fingerprint);
  });

  it("rejects caller-supplied patch data and sends only permitId to deployment", async () => {
    const invalid = await postDeploy(
      authenticatedRequest({ permitId: "permit-1", patch: "untrusted" }),
      context(),
    );
    expect(invalid.status).toBe(400);
    expect(mocks.deploy).not.toHaveBeenCalled();

    const response = await postDeploy(
      authenticatedRequest({ permitId: "permit-1" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(mocks.deploy).toHaveBeenCalledWith("incident-1", "permit-1");
  });
});

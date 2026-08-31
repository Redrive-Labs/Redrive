import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperatorSession, OPERATOR_SESSION_COOKIE } from "@/server/auth/operator-auth";

const mocks = vi.hoisted(() => ({
  config: vi.fn(() => ({ databasePath: "/tmp/redrive-receiver-mcp.sqlite" })),
  database: { get: vi.fn() },
  getConfiguredDatabase: vi.fn(),
  connectionService: { getByApplicationConnectionId: vi.fn() },
  createConnectionService: vi.fn(),
  jobService: { createBusinessStateJob: vi.fn(), createHealthJob: vi.fn(), getById: vi.fn() },
  createJobService: vi.fn(),
  getApplicationConnection: vi.fn(),
}));

vi.mock("@/server/infrastructure/config", () => ({ getServerConfig: mocks.config }));
vi.mock("@/server/infrastructure/database", () => ({ getConfiguredDatabase: mocks.getConfiguredDatabase }));
vi.mock("@/server/github/github-connection-service", () => ({
  getApplicationConnection: mocks.getApplicationConnection,
}));
vi.mock("@/server/receiver/receiver-connection-service", () => ({
  createReceiverConnectionService: mocks.createConnectionService,
}));
vi.mock("@/server/receiver/receiver-read-job-service", () => ({
  createReceiverReadJobTransportService: mocks.createJobService,
}));

import { GET, POST } from "@/app/api/mcp/receiver/route";

const token = "receiver-mcp-route-token";
const receiver = {
  id: "receiver-connection-1",
  applicationConnectionId: "application-connection-1",
  state: "READY" as const,
  enrollmentExpiresAt: null,
  enrollmentConsumedAt: "2026-01-01T00:00:01.000Z",
  connectorId: "connector-1",
  protocolVersion: "1" as const,
  capabilities: ["business_state:v1", "health:v1"] as ["business_state:v1", "health:v1"],
  enrolledAt: "2026-01-01T00:00:01.000Z",
  lastSeenAt: "2026-01-01T00:00:02.000Z",
  lastHealthStatus: "HEALTHY" as const,
  lastHealthAt: "2026-01-01T00:00:02.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:02.000Z",
};
const job = {
  id: "job-1",
  receiverConnectionId: receiver.id,
  capability: "health:v1" as const,
  input: {},
  state: "SUCCEEDED" as const,
  leaseGeneration: 1,
  leasedConnectorId: null,
  leaseExpiresAt: null,
  deadlineAt: "2026-01-01T00:01:00.000Z",
  result: {
    schemaVersion: 1 as const,
    healthStatus: "HEALTHY" as const,
    observedAt: "2026-01-01T00:00:03.000Z",
  },
  errorCode: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  completedAt: "2026-01-01T00:00:03.000Z",
};

function request(body: unknown, authorization = `Bearer ${token}`, cookie?: string): Request {
  return new Request("http://redrive.test/api/mcp/receiver", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

describe("production Receiver MCP route", () => {
  const originalToken = process.env.REDRIVE_RECEIVER_MCP_TOKEN;

  beforeEach(() => {
    process.env.REDRIVE_RECEIVER_MCP_TOKEN = token;
    vi.clearAllMocks();
    mocks.getConfiguredDatabase.mockReturnValue(mocks.database);
    mocks.createConnectionService.mockReturnValue(mocks.connectionService);
    mocks.createJobService.mockReturnValue(mocks.jobService);
    mocks.getApplicationConnection.mockReturnValue({
      id: "application-connection-1",
      state: "READY",
    });
    mocks.connectionService.getByApplicationConnectionId.mockReturnValue(receiver);
    mocks.jobService.createHealthJob.mockReturnValue(job);
    mocks.jobService.getById.mockReturnValue(job);
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.REDRIVE_RECEIVER_MCP_TOKEN;
    else process.env.REDRIVE_RECEIVER_MCP_TOKEN = originalToken;
  });

  it("authenticates before configuration and database construction", async () => {
    const response = await POST(
      request(
        { jsonrpc: "2.0", id: "unauthenticated", method: "tools/list" },
        "Bearer wrong-token",
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.getConfiguredDatabase).not.toHaveBeenCalled();
    expect(mocks.createConnectionService).not.toHaveBeenCalled();
    expect(mocks.createJobService).not.toHaveBeenCalled();
  });

  it("does not accept an operator session or another MCP bearer", async () => {
    const operatorSession = createOperatorSession({
      REDRIVE_OPERATOR_TOKEN: "operator-token-that-is-at-least-32-characters",
    } as unknown as NodeJS.ProcessEnv);
    const response = await POST(
      request(
        { jsonrpc: "2.0", id: "operator", method: "tools/list" },
        "Bearer github-mcp-token",
        `${OPERATOR_SESSION_COOKIE}=${operatorSession}`,
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.config).not.toHaveBeenCalled();

    const connectorResponse = await POST(
      request(
        { jsonrpc: "2.0", id: "connector", method: "tools/list" },
        "Bearer connector-secret-1",
      ),
    );
    expect(connectorResponse.status).toBe(401);
    expect(mocks.config).not.toHaveBeenCalled();
  });

  it("constructs central services only for an authenticated tool call", async () => {
    const response = await POST(
      request({
        jsonrpc: "2.0",
        id: "health",
        method: "tools/call",
        params: {
          name: "get_receiver_health",
          arguments: { connection_id: "application-connection-1" },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse((await response.json()).result.content[0].text)).toMatchObject({
      healthStatus: "HEALTHY",
    });
    expect(mocks.config).toHaveBeenCalledTimes(1);
    expect(mocks.getConfiguredDatabase).toHaveBeenCalledWith(
      "/tmp/redrive-receiver-mcp.sqlite",
    );
    expect(mocks.createConnectionService).toHaveBeenCalledWith({ database: mocks.database });
    expect(mocks.createJobService).toHaveBeenCalledWith({ database: mocks.database });
  });

  it("keeps GET out of the MCP surface", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "Receiver MCP accepts POST requests only.",
    });
  });
});

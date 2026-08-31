import { describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "@/server/infrastructure/database";
import {
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  RECEIVER_CONNECTION_READY,
  RECEIVER_CONNECTION_VERIFYING,
  RECEIVER_READ_JOB_QUEUED,
  RECEIVER_READ_JOB_SUCCEEDED,
  type ReceiverConnection,
  type ReceiverReadJob,
} from "@/domain/receiver-connector";
import {
  createReceiverMcpServer,
  RECEIVER_MCP_BUSINESS_STATE_TOOL,
  RECEIVER_MCP_HEALTH_TOOL,
  RECEIVER_MCP_TOOLS,
  type ReceiverMcpServices,
} from "@/server/receiver/receiver-mcp-server";

const TOKEN = "receiver-mcp-test-token";
const APPLICATION_CONNECTION_ID = "application-connection-1";
const RECEIVER_CONNECTION_ID = "receiver-connection-1";

function applicationRow(): Record<string, unknown> {
  return {
    id: APPLICATION_CONNECTION_ID,
    provider: "github",
    github_installation_id: "installation-1",
    repository_id: "repository-1",
    repository_full_name: "octocat/receiver",
    webhook_id: "webhook-1",
    webhook_target_display: "https://receiver.example/hooks",
    state: "READY",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function receiver(state: ReceiverConnection["state"] = RECEIVER_CONNECTION_READY): ReceiverConnection {
  return {
    id: RECEIVER_CONNECTION_ID,
    applicationConnectionId: APPLICATION_CONNECTION_ID,
    state,
    enrollmentExpiresAt: null,
    enrollmentConsumedAt: "2026-01-01T00:00:01.000Z",
    connectorId: "connector-1",
    protocolVersion: "1",
    capabilities: [RECEIVER_CAPABILITY_BUSINESS_STATE, RECEIVER_CAPABILITY_HEALTH],
    enrolledAt: "2026-01-01T00:00:01.000Z",
    lastSeenAt: "2026-01-01T00:00:02.000Z",
    lastHealthStatus: null,
    lastHealthAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
}

function job(overrides: Partial<ReceiverReadJob> = {}): ReceiverReadJob {
  return {
    id: "job-1",
    receiverConnectionId: RECEIVER_CONNECTION_ID,
    capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
    input: { deliveryGuid: "delivery-guid-1" },
    state: RECEIVER_READ_JOB_QUEUED,
    leaseGeneration: 0,
    leasedConnectorId: null,
    leaseExpiresAt: null,
    deadlineAt: "2026-01-01T00:01:00.000Z",
    result: null,
    errorCode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function services(
  currentReceiver = receiver(),
  currentJob = job({
    state: RECEIVER_READ_JOB_SUCCEEDED,
    result: {
      schemaVersion: 1,
      deliveryGuid: "delivery-guid-1",
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      observedAt: "2026-01-01T00:00:03.000Z",
    },
  }),
): ReceiverMcpServices {
  const database = {
    get: vi.fn(() => applicationRow()),
  } as unknown as SqliteDatabase;
  return {
    database,
    connections: {
      getByApplicationConnectionId: vi.fn(() => currentReceiver),
    },
    jobs: {
      createBusinessStateJob: vi.fn(() => currentJob),
      createHealthJob: vi.fn(() => currentJob),
      getById: vi.fn(() => currentJob),
    },
  };
}

function request(body: unknown, token = TOKEN, signal?: AbortSignal): Request {
  return new Request("http://redrive.test/api/mcp/receiver", {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function rpc(body: unknown, receiverServices = services(), options?: Parameters<typeof createReceiverMcpServer>[0]["wait"]): Promise<Record<string, unknown>> {
  const server = createReceiverMcpServer({
    token: TOKEN,
    services: receiverServices,
    wait: options,
  });
  return (await (await server.handleRequest(request(body))).json()) as Record<string, unknown>;
}

describe("Receiver MCP", () => {
  it("authenticates before body or service work and keeps auth independent", async () => {
    const getServices = vi.fn(() => services());
    const server = createReceiverMcpServer({ token: TOKEN, getServices });
    const response = await server.handleRequest(
      request({ jsonrpc: "2.0", id: "unauth", method: "tools/list" }, "wrong-token"),
    );
    expect(response.status).toBe(401);
    expect(getServices).not.toHaveBeenCalled();

    const operatorCookie = await server.handleRequest(
      new Request("http://redrive.test/api/mcp/receiver", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-token",
          cookie: "redrive_operator_session=v1.1.invalid",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "cookie", method: "tools/list" }),
      }),
    );
    expect(operatorCookie.status).toBe(401);
  });

  it("exposes exactly the two read-only tools with exact schemas", async () => {
    const result = await rpc({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    expect(result.result).toEqual({ tools: RECEIVER_MCP_TOOLS });
    const tools = (result.result as { tools: typeof RECEIVER_MCP_TOOLS }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      RECEIVER_MCP_BUSINESS_STATE_TOOL,
      RECEIVER_MCP_HEALTH_TOOL,
    ]);
    expect(tools[0].inputSchema).toMatchObject({
      required: ["connection_id", "delivery_guid"],
      additionalProperties: false,
    });
    expect(tools[1].inputSchema).toMatchObject({
      required: ["connection_id"],
      additionalProperties: false,
    });
    expect(tools.every((tool) => tool.annotations.readOnlyHint && tool.annotations.idempotentHint)).toBe(true);
    expect(tools.every((tool) => tool.annotations.destructiveHint === false)).toBe(true);
  });

  it("resolves the application and receiver server-side for business state", async () => {
    const receiverServices = services();
    const result = await rpc({
      jsonrpc: "2.0",
      id: "business",
      method: "tools/call",
      params: {
        name: RECEIVER_MCP_BUSINESS_STATE_TOOL,
        arguments: {
          connection_id: APPLICATION_CONNECTION_ID,
          delivery_guid: "delivery-guid-1",
        },
      },
    }, receiverServices);
    const text = ((result.result as { content: Array<{ text: string }> }).content[0]).text;
    expect(JSON.parse(text)).toMatchObject({ businessState: "EXACTLY_ONE" });
    expect(receiverServices.connections.getByApplicationConnectionId).toHaveBeenCalledWith(APPLICATION_CONNECTION_ID);
    expect(receiverServices.jobs.createBusinessStateJob).toHaveBeenCalledWith(RECEIVER_CONNECTION_ID, "delivery-guid-1");
  });

  it("rejects extra or connector-selected arguments before creating a job", async () => {
    const receiverServices = services();
    for (const argumentsValue of [
      { connection_id: APPLICATION_CONNECTION_ID, delivery_guid: "delivery-guid-1", connector_id: "connector-1" },
      { connection_id: APPLICATION_CONNECTION_ID, delivery_guid: "delivery-guid-1", receiverId: RECEIVER_CONNECTION_ID },
    ]) {
      const result = await rpc({
        jsonrpc: "2.0",
        id: "invalid",
        method: "tools/call",
        params: { name: RECEIVER_MCP_BUSINESS_STATE_TOOL, arguments: argumentsValue },
      }, receiverServices);
      expect((result.result as { isError?: boolean }).isError).toBe(true);
    }
    expect(receiverServices.jobs.createBusinessStateJob).not.toHaveBeenCalled();
  });

  it("requires READY for business state but permits health while VERIFYING", async () => {
    const verifying = services(receiver(RECEIVER_CONNECTION_VERIFYING), job({
      capability: RECEIVER_CAPABILITY_HEALTH,
      input: {},
      state: RECEIVER_READ_JOB_SUCCEEDED,
      result: {
        schemaVersion: 1,
        healthStatus: "HEALTHY",
        observedAt: "2026-01-01T00:00:03.000Z",
      },
    }));
    const business = await rpc({
      jsonrpc: "2.0", id: "business", method: "tools/call",
      params: { name: RECEIVER_MCP_BUSINESS_STATE_TOOL, arguments: { connection_id: APPLICATION_CONNECTION_ID, delivery_guid: "delivery-guid-1" } },
    }, verifying);
    expect((business.result as { isError?: boolean }).isError).toBe(true);
    expect(verifying.jobs.createBusinessStateJob).not.toHaveBeenCalled();

    const health = await rpc({
      jsonrpc: "2.0", id: "health", method: "tools/call",
      params: { name: RECEIVER_MCP_HEALTH_TOOL, arguments: { connection_id: APPLICATION_CONNECTION_ID } },
    }, verifying);
    const text = ((health.result as { content: Array<{ text: string }> }).content[0]).text;
    expect(JSON.parse(text)).toMatchObject({ healthStatus: "HEALTHY" });
    expect(verifying.jobs.createHealthJob).toHaveBeenCalledWith(RECEIVER_CONNECTION_ID);
  });

  it("returns a sanitized timeout without cancelling the durable job", async () => {
    let now = 0;
    const pending = services(receiver(), job({ state: RECEIVER_READ_JOB_QUEUED }));
    const result = await rpc({
      jsonrpc: "2.0", id: "timeout", method: "tools/call",
      params: { name: RECEIVER_MCP_BUSINESS_STATE_TOOL, arguments: { connection_id: APPLICATION_CONNECTION_ID, delivery_guid: "delivery-guid-1" } },
    }, pending, {
      maxMs: 500,
      intervalMs: 250,
      clock: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        return true;
      },
    });
    expect((result.result as { isError?: boolean; content: Array<{ text: string }> }).isError).toBe(true);
    expect(((result.result as { content: Array<{ text: string }> }).content[0]).text).toContain("timed out");
    expect(pending.jobs.createBusinessStateJob).toHaveBeenCalledTimes(1);
  });
});

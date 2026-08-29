import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliveryService: {
    getFullFailedDelivery: vi.fn(async () => ({ id: "delivery-1", status: "Failed" })),
  },
  getServerConfig: vi.fn(() => ({ databasePath: "/tmp/redrive.sqlite", secretDir: "/tmp/redrive-secrets" })),
  getConfiguredDatabase: vi.fn(() => ({}) as never),
  createGithubApi: vi.fn(() => ({}) as never),
  createGithubDeliveryService: vi.fn(() => mocks.deliveryService),
  secretStore: vi.fn(),
}));

vi.mock("@/server/config", () => ({ getServerConfig: mocks.getServerConfig }));
vi.mock("@/server/database", () => ({ getConfiguredDatabase: mocks.getConfiguredDatabase }));
vi.mock("@/server/github-rest", () => ({ createGithubApi: mocks.createGithubApi }));
vi.mock("@/server/github-delivery-service", () => ({
  createGithubDeliveryService: mocks.createGithubDeliveryService,
}));
vi.mock("@/server/secret-store", () => ({
  FilesystemSecretStore: mocks.secretStore,
}));

import { GET, POST } from "@/app/api/mcp/github/route";

const token = "route-test-token";

function rpcRequest(body: unknown, authorization = `Bearer ${token}`): Request {
  return new Request("http://redrive.test/api/mcp/github", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("production GitHub MCP route", () => {
  const originalConnectionToken = process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;

  beforeEach(() => {
    process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN = token;
    mocks.deliveryService.getFullFailedDelivery.mockClear();
    mocks.createGithubDeliveryService.mockClear();
    mocks.getServerConfig.mockClear();
    mocks.getConfiguredDatabase.mockClear();
    mocks.createGithubApi.mockClear();
    mocks.secretStore.mockClear();
  });

  afterEach(() => {
    if (originalConnectionToken === undefined) {
      delete process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;
    } else {
      process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN = originalConnectionToken;
    }
  });

  it("serves an authenticated connection-bound tool call", async () => {
    const response = await POST(
      rpcRequest({
        jsonrpc: "2.0",
        id: "route-call",
        method: "tools/call",
        params: {
          name: "get_webhook_delivery",
          arguments: { connection_id: "connection-1", delivery_id: "delivery-1" },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.content[0].text).toContain(
      '"delivery-1"',
    );
    expect(mocks.deliveryService.getFullFailedDelivery).toHaveBeenCalledWith(
      "connection-1",
      "delivery-1",
    );
  });

  it("rejects authentication before configuration and database construction", async () => {
    const response = await POST(
      rpcRequest(
        { jsonrpc: "2.0", id: "unauthenticated", method: "tools/list" },
        "Bearer wrong-token",
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.getServerConfig).not.toHaveBeenCalled();
    expect(mocks.getConfiguredDatabase).not.toHaveBeenCalled();
    expect(mocks.createGithubApi).not.toHaveBeenCalled();
    expect(mocks.secretStore).not.toHaveBeenCalled();
  });

  it("rejects authentication before the delivery service is called", async () => {
    const response = await POST(
      rpcRequest(
        { jsonrpc: "2.0", id: "unauthenticated", method: "tools/list" },
        "Bearer wrong-token",
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.deliveryService.getFullFailedDelivery).not.toHaveBeenCalled();
  });

  it("does not expose a GET or a legacy route", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: "GitHub MCP accepts POST requests only.",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createGithubMcpServer,
  GITHUB_MCP_SERVER_NAME,
  GITHUB_WEBHOOK_DELIVERY_TOOL,
} from "@/server/github/github-mcp-server";

const TOKEN = "test-mcp-token";
const DELIVERY_ID = "900719925474099312345678901234567890";

function request(
  body: unknown,
  options: { token?: string; contentType?: string; method?: string } = {},
): Request {
  const headers = new Headers();
  if (options.contentType !== "none") {
    headers.set(
      "content-type",
      options.contentType ?? "application/json; charset=utf-8",
    );
  }
  if (options.token !== "none") {
    headers.set("authorization", `Bearer ${options.token ?? TOKEN}`);
  }
  return new Request("http://redrive.test/api/mcp/github", {
    method: options.method ?? "POST",
    headers,
    body:
      body === undefined || options.method === "GET"
        ? undefined
        : JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

describe("production connection-backed GitHub MCP", () => {
  function server() {
    const deliveryService = {
      getFullFailedDelivery: vi.fn(async () => ({
        id: DELIVERY_ID,
        status: "Failed",
        status_code: 500,
        request: { payload: { number: 9007199254740993123 } },
      })),
    };
    return {
      deliveryService,
      server: createGithubMcpServer({
        deliveryService,
        token: TOKEN,
        environment: { NODE_ENV: "test" },
      }),
    };
  }

  it("advertises only the strict connection-bound read tool", async () => {
    const { server: mcp } = server();
    const response = await mcp.handleRequest(
      request({ jsonrpc: "2.0", id: "list", method: "tools/list" }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson(response);
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]).toMatchObject({
      name: GITHUB_WEBHOOK_DELIVERY_TOOL,
      inputSchema: {
        type: "object",
        required: ["connection_id", "delivery_id"],
        additionalProperties: false,
      },
    });
    expect(body.result.tools[0].inputSchema.properties).toEqual({
      connection_id: expect.objectContaining({ type: "string" }),
      delivery_id: expect.objectContaining({ type: "string" }),
    });
    expect(JSON.stringify(body)).not.toContain("hook_id");
    expect(JSON.stringify(body)).not.toContain("repository");
    expect(body.result.tools[0].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("negotiates initialization and handles initialized notification", async () => {
    const { server: mcp } = server();
    const initialize = await mcp.handleRequest(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} },
      }),
    );
    expect(initialize.status).toBe(200);
    expect(await responseJson(initialize)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: GITHUB_MCP_SERVER_NAME },
      },
    });

    const initialized = await mcp.handleRequest(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe("");
  });

  it("rejects unauthenticated requests before provider lookup", async () => {
    const { server: mcp, deliveryService } = server();
    const missing = await mcp.handleRequest(
      request({ jsonrpc: "2.0", id: "x", method: "tools/list" }, { token: "none" }),
    );
    expect(missing.status).toBe(401);
    expect(await responseJson(missing)).toEqual({
      error: "GitHub MCP authentication is required.",
    });

    const wrong = await mcp.handleRequest(
      request({ jsonrpc: "2.0", id: "x", method: "tools/list" }, { token: "wrong" }),
    );
    expect(wrong.status).toBe(401);
    expect(deliveryService.getFullFailedDelivery).not.toHaveBeenCalled();
  });

  it("calls the service with exactly connection_id and delivery_id and emits lossless text evidence", async () => {
    const { server: mcp, deliveryService } = server();
    const response = await mcp.handleRequest(
      request({
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: GITHUB_WEBHOOK_DELIVERY_TOOL,
          arguments: {
            connection_id: "connection-1",
            delivery_id: DELIVERY_ID,
          },
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(deliveryService.getFullFailedDelivery).toHaveBeenCalledOnce();
    expect(deliveryService.getFullFailedDelivery).toHaveBeenCalledWith(
      "connection-1",
      DELIVERY_ID,
    );
    const body = await responseJson(response);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toHaveLength(1);
    const text = body.result.content[0].text;
    expect(typeof text).toBe("string");
    expect(JSON.parse(text)).toEqual({
      full: {
        http_status: 200,
        body: {
          id: DELIVERY_ID,
          status: "Failed",
          status_code: 500,
          request: { payload: { number: 9007199254740993123 } },
        },
      },
    });
  });

  it("rejects extra or legacy selectors without invoking the service", async () => {
    const { server: mcp, deliveryService } = server();
    for (const [field, value] of [
      ["hook_id", "legacy-hook"],
      ["mcp_server", "redrive-github"],
    ] as const) {
      const response = await mcp.handleRequest(
        request({
          jsonrpc: "2.0",
          id: `call-${field}`,
          method: "tools/call",
          params: {
            name: GITHUB_WEBHOOK_DELIVERY_TOOL,
            arguments: {
              connection_id: "connection-1",
              delivery_id: DELIVERY_ID,
              [field]: value,
            },
          },
        }),
      );
      expect(response.status).toBe(200);
      expect(await responseJson(response)).toMatchObject({
        jsonrpc: "2.0",
        result: { isError: true },
      });
    }
    expect(deliveryService.getFullFailedDelivery).not.toHaveBeenCalled();
  });

  it("sanitizes connection failures into a tool error", async () => {
    const deliveryService = {
      getFullFailedDelivery: vi.fn(async () => {
        throw new Error("secret-token and https://private.example/internal");
      }),
    };
    const mcp = createGithubMcpServer({
      deliveryService,
      token: TOKEN,
      environment: { NODE_ENV: "test" },
    });
    const response = await mcp.handleRequest(
      request({
        jsonrpc: "2.0",
        id: "call-3",
        method: "tools/call",
        params: {
          name: GITHUB_WEBHOOK_DELIVERY_TOOL,
          arguments: { connection_id: "connection-1", delivery_id: DELIVERY_ID },
        },
      }),
    );
    const body = await responseJson(response);
    expect(body.result).toMatchObject({ isError: true });
    expect(body.result.content[0].text).toBe(
      "The GitHub webhook delivery could not be read.",
    );
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("private.example");
  });

  it("fails closed for non-POST, malformed JSON, and missing configuration", async () => {
    const { server: mcp } = server();
    expect((await mcp.handleRequest(request({}, { method: "GET" }))).status).toBe(405);
    const malformed = new Request("http://redrive.test/api/mcp/github", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "not-json",
    });
    expect((await mcp.handleRequest(malformed)).status).toBe(400);

    const unconfigured = createGithubMcpServer({
      deliveryService: { getFullFailedDelivery: vi.fn() },
      environment: { NODE_ENV: "test" },
    });
    const response = await unconfigured.handleRequest(
      request({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(response.status).toBe(503);

  });
});

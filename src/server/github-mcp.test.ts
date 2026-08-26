import { describe, expect, it, vi } from "vitest";
import {
  createGithubMcpToolCaller,
  createGithubWebhookDeliveryReader,
  GithubMcpConfigurationError,
} from "./github-mcp";

const lookup = {
  repositoryId: "example/receiver",
  deliveryId: "900719925474099312345678901234567890",
};

describe("GitHub MCP boundary", () => {
  it("uses the read-only tool with an explicit hook ID mapping", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const reader = createGithubWebhookDeliveryReader(
      callTool,
      (repositoryId) => {
        expect(repositoryId).toBe(lookup.repositoryId);
        return "670245925";
      },
    );

    await reader.getWebhookDelivery(lookup);

    expect(callTool).toHaveBeenCalledWith("get_webhook_delivery", {
      hook_id: "670245925",
      delivery_id: lookup.deliveryId,
    });
  });

  it("fails closed when the hook mapping is missing", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const reader = createGithubWebhookDeliveryReader(
      callTool,
      () => {
        throw new GithubMcpConfigurationError("missing hook");
      },
    );

    await expect(reader.getWebhookDelivery(lookup)).rejects.toBeInstanceOf(
      GithubMcpConfigurationError,
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("parses an MCP tool envelope without exposing the envelope to the caller", async () => {
    let receivedRequest: RequestInit | undefined;
    const fetchImplementation: typeof fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedRequest = init;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "call-1",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    full: {
                      body: {
                        id: lookup.deliveryId,
                      },
                    },
                  }),
                },
              ],
            },
          }),
          { status: 200 },
        );
      },
    );
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      token: "secret",
      fetchImplementation,
    });

    await expect(
      callTool("get_webhook_delivery", {
        hook_id: "670245925",
        delivery_id: lookup.deliveryId,
      }),
    ).resolves.toEqual({
      full: {
        body: {
          id: lookup.deliveryId,
        },
      },
    });

    expect(receivedRequest?.method).toBe("POST");
    expect(receivedRequest?.headers).toMatchObject({
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(String(receivedRequest?.body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "get_webhook_delivery",
        arguments: {
          hook_id: "670245925",
          delivery_id: lookup.deliveryId,
        },
      },
    });
  });
});

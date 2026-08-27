import { describe, expect, it, vi } from "vitest";
import {
  createGithubMcpToolCaller,
  createGithubWebhookDeliveryReader,
  GithubMcpConfigurationError,
  GithubMcpError,
  GithubMcpResponseTooLargeError,
  GithubMcpTimeoutError,
  GITHUB_MCP_MAX_RESPONSE_BYTES,
  GITHUB_MCP_TIMEOUT_MS,
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
  it("passes an AbortSignal and reports fetch timeout without leaking details", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImplementation: typeof fetch = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal as AbortSignal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("secret body")), {
              once: true,
            });
          });
        },
      );
      const callTool = createGithubMcpToolCaller({
        endpoint: "https://mcp.example.test/mcp",
        token: "secret-token",
        fetchImplementation,
      });
      const pending = callTool("get_webhook_delivery", {
        hook_id: "hook",
        delivery_id: "delivery",
      });
      const result = expect(pending).rejects.toBeInstanceOf(GithubMcpTimeoutError);
      await vi.advanceTimersByTimeAsync(GITHUB_MCP_TIMEOUT_MS);
      await result;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the response limit on streamed bytes", async () => {
    const fetchImplementation: typeof fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(GITHUB_MCP_MAX_RESPONSE_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation,
    });
    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "delivery" }),
    ).rejects.toBeInstanceOf(GithubMcpResponseTooLargeError);
  });

  it("rejects an oversized Content-Length before consuming the body", async () => {
    const fetchImplementation: typeof fetch = vi.fn(async () =>
      new Response("not read", {
        status: 200,
        headers: { "content-length": String(GITHUB_MCP_MAX_RESPONSE_BYTES + 1) },
      }),
    );
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation,
    });
    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "delivery" }),
    ).rejects.toBeInstanceOf(GithubMcpResponseTooLargeError);
  });

  it("rejects non-2xx and malformed JSON responses without response details", async () => {
    const non2xx = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () => new Response("provider secret", { status: 502 })),
    });
    await expect(
      non2xx("get_webhook_delivery", { hook_id: "hook", delivery_id: "delivery" }),
    ).rejects.toMatchObject({
      name: "GithubMcpError",
      message: "GitHub MCP request failed with HTTP 502.",
    });

    const malformed = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () => new Response("not-json", { status: 200 })),
    });
    await expect(
      malformed("get_webhook_delivery", { hook_id: "hook", delivery_id: "delivery" }),
    ).rejects.toBeInstanceOf(GithubMcpError);
  });

  it("parses data-first SSE responses", async () => {
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response(`data: ${JSON.stringify({ result: { ok: true } })}\n\n`, { status: 200 }),
      ),
    });
    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "delivery" }),
    ).resolves.toEqual({ ok: true });
  });


  it("preserves unsafe integer literals as opaque strings before JSON parsing", async () => {
    const unsafeId = "900719925474099312345678901234567890";
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response(`{"full":{"body":{"id":${unsafeId}}}}`, { status: 200 }),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: unsafeId }),
    ).resolves.toEqual({ full: { body: { id: unsafeId } } });
  });

  it("rejects an SSE response with no usable data event", async () => {
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response("event: message\ndata: [DONE]\n\n", { status: 200 }),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "delivery" }),
    ).rejects.toBeInstanceOf(GithubMcpError);
  });

});

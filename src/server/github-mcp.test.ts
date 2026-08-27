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

function envelope(toolText: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "call-1",
    result: { content: [{ type: "text", text: toolText }] },
  });
}

function jsonResponse(toolResult: unknown): Response {
  return new Response(envelope(JSON.stringify(toolResult)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub MCP boundary", () => {
  it("uses the read-only tool with an explicit hook ID mapping", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const reader = createGithubWebhookDeliveryReader(callTool, (repositoryId) => {
      expect(repositoryId).toBe(lookup.repositoryId);
      return "670245925";
    });

    await reader.getWebhookDelivery(lookup);

    expect(callTool).toHaveBeenCalledWith("get_webhook_delivery", {
      hook_id: "670245925",
      delivery_id: lookup.deliveryId,
    });
  });

  it("fails closed when the hook mapping is missing", async () => {
    const callTool = vi.fn(async () => ({ ok: true }));
    const reader = createGithubWebhookDeliveryReader(callTool, () => {
      throw new GithubMcpConfigurationError("missing hook");
    });

    await expect(reader.getWebhookDelivery(lookup)).rejects.toBeInstanceOf(
      GithubMcpConfigurationError,
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it("accepts only the proven JSON-RPC text result shape", async () => {
    let receivedRequest: RequestInit | undefined;
    const fetchImplementation: typeof fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedRequest = init;
        return jsonResponse({ full: { http_status: 200, body: { id: "123" } } });
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
        delivery_id: "123",
      }),
    ).resolves.toEqual({ full: { http_status: 200, body: { id: "123" } } });
    expect(receivedRequest?.method).toBe("POST");
    expect(receivedRequest?.headers).toMatchObject({
      Authorization: "Bearer secret",
    });
  });

  it("rejects unproved structured-content and direct-result shapes", async () => {
    for (const result of [
      { structuredContent: { full: { body: { id: "123" } } } },
      { full: { body: { id: "123" } } },
    ]) {
      const callTool = createGithubMcpToolCaller({
        endpoint: "https://mcp.example.test/mcp",
        fetchImplementation: vi.fn(async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: "call-1", result }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      });
      await expect(
        callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
      ).rejects.toBeInstanceOf(GithubMcpError);
    }
  });

  it("preserves only an unsafe full.body.id integer", async () => {
    const unsafeId = lookup.deliveryId;
    const toolText = `{"full":{"http_status":200,"body":{"id":${unsafeId},"payload":{"count":1}}}}`;
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response(envelope(toolText), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: unsafeId }),
    ).resolves.toEqual({
      full: {
        http_status: 200,
        body: { id: unsafeId, payload: { count: 1 } },
      },
    });
  });

  it("rejects an unrelated unsafe payload integer instead of changing its type", async () => {
    const unsafeValue = "9007199254740993";
    const toolText = `{"full":{"http_status":200,"body":{"id":"123","request":{"payload":{"count":${unsafeValue}}}}}}`;
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response(envelope(toolText), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).rejects.toThrow("unsafe integer outside full.body.id");
  });

  it("times out one bounded request without leaking details", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImplementation: typeof fetch = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal as AbortSignal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("secret")), {
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
      const pending = expect(
        callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
      ).rejects.toBeInstanceOf(GithubMcpTimeoutError);

      await vi.advanceTimersByTimeAsync(GITHUB_MCP_TIMEOUT_MS);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the response limit on streamed bytes and Content-Length", async () => {
    const streamed = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(GITHUB_MCP_MAX_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    });
    await expect(
      streamed("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).rejects.toBeInstanceOf(GithubMcpResponseTooLargeError);

    const declared = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response("not read", {
          status: 200,
          headers: {
            "content-length": String(GITHUB_MCP_MAX_RESPONSE_BYTES + 1),
          },
        }),
      ),
    });
    await expect(
      declared("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).rejects.toBeInstanceOf(GithubMcpResponseTooLargeError);
  });

  it("rejects non-2xx and malformed JSON responses without response details", async () => {
    const non2xx = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response("provider secret", { status: 502 }),
      ),
    });
    await expect(
      non2xx("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).rejects.toMatchObject({
      name: "GithubMcpError",
      message: "GitHub MCP request failed with HTTP 502.",
    });

    const malformed = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    await expect(
      malformed("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).rejects.toBeInstanceOf(GithubMcpError);
  });

  it("accepts only the proven single-message SSE framing", async () => {
    const body = `event: message
data: ${envelope(JSON.stringify({
      full: { http_status: 200, body: { id: "123" } },
    }))}

`;
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).resolves.toEqual({ full: { http_status: 200, body: { id: "123" } } });
  });

  it("rejects data-first or multi-event SSE framing", async () => {
    for (const body of [
      `data: ${envelope("{}")}

`,
      `event: message
data: ${envelope("{}")}

event: message
data: ${envelope("{}")}

`,
    ]) {
      const callTool = createGithubMcpToolCaller({
        endpoint: "https://mcp.example.test/mcp",
        fetchImplementation: vi.fn(async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      });
      await expect(
        callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
      ).rejects.toBeInstanceOf(GithubMcpError);
    }
  });
});

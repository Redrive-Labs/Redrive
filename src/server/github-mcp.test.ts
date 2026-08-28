import { describe, expect, it, vi } from "vitest";
import {
  createGithubMcpToolCaller,
  createGithubWebhookDeliveryReader,
  GithubMcpConfigurationError,
  resolveConfiguredGithubHookId,
  GithubMcpError,
  GithubMcpResponseTooLargeError,
  GithubMcpTimeoutError,
  GITHUB_MCP_MAX_RESPONSE_BYTES,
  GITHUB_MCP_TIMEOUT_MS,
  MAX_JSON_NUMERIC_LITERAL_CHARS,
} from "./github-mcp";

const lookup = {
  repositoryId: "example/receiver",
  deliveryId: "900719925474099312345678901234567890",
};

function envelope(toolText: string, requestId = "call-1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    result: { content: [{ type: "text", text: toolText }] },
  });
}

function jsonResponse(toolResult: unknown, requestId: string): Response {
  return new Response(envelope(JSON.stringify(toolResult), requestId), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function callToolText(toolText: string): Promise<unknown> {
  const callTool = createGithubMcpToolCaller({
    endpoint: "https://mcp.example.test/mcp",
    fetchImplementation: vi.fn(async (_input, init) =>
      new Response(
        envelope(
          toolText,
          (JSON.parse(String(init?.body)) as { id: string }).id,
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ),
  });

  return callTool("get_webhook_delivery", {
    hook_id: "hook",
    delivery_id: "123",
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

  it("resolves the same explicit hook mapping used by provider investigation", () => {
    expect(
      resolveConfiguredGithubHookId("example/receiver", {
        NODE_ENV: "test",
        REDRIVE_GITHUB_HOOK_IDS: JSON.stringify({ "example/receiver": "hook-42" }),
        REDRIVE_GITHUB_HOOK_ID: "fallback-hook",
      }),
    ).toBe("hook-42");
    expect(
      resolveConfiguredGithubHookId("other/receiver", {
        NODE_ENV: "test",
        REDRIVE_GITHUB_HOOK_ID: "fallback-hook",
      }),
    ).toBe("fallback-hook");
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
        const request = JSON.parse(String(init?.body)) as { id: string };
        return jsonResponse(
          { full: { http_status: 200, body: { id: "123" } } },
          request.id,
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
        delivery_id: "123",
      }),
    ).resolves.toEqual({ full: { http_status: 200, body: { id: "123" } } });
    expect(receivedRequest?.method).toBe("POST");
    expect(receivedRequest?.headers).toMatchObject({
      Authorization: "Bearer secret",
    });
  });

  it("rejects a JSON-RPC response with a different response id", async () => {
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "not-the-request-id",
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    full: { http_status: 200, body: { id: "123" } },
                  }),
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
    ).rejects.toThrow("response ID");
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
      fetchImplementation: vi.fn(async (_input, init) =>
        new Response(
          envelope(toolText, (JSON.parse(String(init?.body)) as { id: string }).id),
          {
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
    const unsafeValues = ["9007199254740993", "9007199254740993.0", "9.007199254740993e15"];
    for (const unsafeValue of unsafeValues) {
      const toolText = `{"full":{"http_status":200,"body":{"id":"123","request":{"payload":{"count":${unsafeValue}}}}}}`;
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async (_input, init) =>
        new Response(
          envelope(toolText, (JSON.parse(String(init?.body)) as { id: string }).id),
          {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    await expect(
      callTool("get_webhook_delivery", { hook_id: "hook", delivery_id: "123" }),
      ).rejects.toThrow("unsafe integer outside full.body.id");
    }
  });

  it("accepts finite numbers whose decimal value survives Number serialization", async () => {
    const cases = [
      ["0", 0],
      ["-0", -0],
      ["0e100000000", 0],
      ["-0e-100000000", -0],
      ["0.1", 0.1],
      ["0.5", 0.5],
      ["1e3", 1000],
      ["1000", 1000],
      ["100.00e-2", 1],
      ["1", 1],
      ["1e-3", 0.001],
      ["5e-324", 5e-324],
      ["9007199254740991", 9007199254740991],
    ] as const;

    for (const [literal, expected] of cases) {
      const result = (await callToolText(
        `{"full":{"http_status":200,"body":{"id":"123","value":${literal}}}}`,
      )) as { full: { body: { value: number } } };
      if (Object.is(expected, -0)) {
        expect(Object.is(result.full.body.value, -0)).toBe(true);
      } else {
        expect(result.full.body.value).toBe(expected);
      }
    }
  });

  it("rejects decimal precision loss, underflow, and overflow", async () => {
    const lossyLiterals = [
      "1e-324",
      "-1e-324",
      "4e-324",
      "1e-100000000",
      "1.0000000000000001",
      "9007199254740991.1",
      "9007199254740992.1",
      `${"9".repeat(309)}.1`,
    ];

    for (const literal of lossyLiterals) {
      await expect(
        callToolText(
          `{"full":{"http_status":200,"body":{"id":"123","value":${literal}}}}`,
        ),
      ).rejects.toThrow(
        "GitHub MCP returned a numeric value that cannot be represented faithfully.",
      );
    }
  });

  it("handles the safe-integer boundary and Number.MAX_VALUE neighborhood", async () => {
    const safe = (await callToolText(
      '{"full":{"body":{"id":"123","value":9007199254740991}}}',
    )) as { full: { body: { value: number } } };
    expect(safe.full.body.value).toBe(9007199254740991);

    const unsafeId = "9007199254740992";
    await expect(
      callToolText(`{"full":{"body":{"id":${unsafeId}}}}`),
    ).resolves.toEqual({ full: { body: { id: unsafeId } } });

    for (const exactUnsafeId of [
      "1e100000000",
      "9.007199254740993e15",
    ]) {
      await expect(
        callToolText(`{"full":{"body":{"id":${exactUnsafeId}}}}`),
      ).resolves.toEqual({ full: { body: { id: exactUnsafeId } } });
    }

    await expect(
      callToolText(
        '{"full":{"body":{"id":9007199254740991.1}}}',
      ),
    ).rejects.toThrow(
      "GitHub MCP returned a numeric value that cannot be represented faithfully.",
    );

    const maxValue = "1.7976931348623157e308";
    await expect(
      callToolText(
        `{"full":{"body":{"id":${maxValue}}}}`,
      ),
    ).resolves.toEqual({ full: { body: { id: maxValue } } });
    await expect(
      callToolText(
        `{"full":{"body":{"id":"123","value":${maxValue}}}}`,
      ),
    ).rejects.toThrow("unsafe integer outside full.body.id");
  });

  it("rejects multiple unsafe values and forged unsafe-integer markers", async () => {
    await expect(
      callToolText(
        '{"full":{"body":{"id":"123","first":9007199254740993,"second":9007199254740995}}}',
      ),
    ).rejects.toThrow("unsafe integer outside full.body.id");

    await expect(
      callToolText(
        '{"full":{"body":{"id":9007199254740993,"other":9007199254740995}}}',
      ),
    ).rejects.toThrow("unsafe integer outside full.body.id");

    await expect(
      callToolText(
        '{"full":{"body":{"id":{"__redriveUnsafeInteger":"forged"},"value":9007199254740993}}}',
      ),
    ).rejects.toThrow("unsafe integer outside full.body.id");

    await expect(
      callToolText(
        '{"full":{"body":{"id":"123","first":1.0000000000000001,"second":1e-324}}}',
      ),
    ).rejects.toThrow(
      "GitHub MCP returned a numeric value that cannot be represented faithfully.",
    );
  });

  it("bounds numeric literal length and exponent parsing", async () => {
    const tooLong = `1${"0".repeat(MAX_JSON_NUMERIC_LITERAL_CHARS)}`;
    await expect(
      callToolText(
        `{"full":{"body":{"id":"123","value":${tooLong}}}}`,
      ),
    ).rejects.toThrow("GitHub MCP returned a JSON numeric literal that is too long.");

    const longExponent = `1e${"9".repeat(
      MAX_JSON_NUMERIC_LITERAL_CHARS - 3,
    )}`;
    await expect(
      callToolText(
        `{"full":{"body":{"id":"123","value":${longExponent}}}}`,
      ),
    ).rejects.toThrow("unsafe integer outside full.body.id");
  });

  it("rejects malformed JSON number forms", async () => {
    for (const literal of ["01", "1.", "1e", "1e+", "--1"]) {
      await expect(
        callToolText(
          `{"full":{"body":{"id":"123","value":${literal}}}}`,
        ),
      ).rejects.toThrow("GitHub MCP returned invalid JSON.");
    }
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
    })).replace("call-1", "PLACEHOLDER_REQUEST_ID")}

`;
    const callTool = createGithubMcpToolCaller({
      endpoint: "https://mcp.example.test/mcp",
      fetchImplementation: vi.fn(async (_input, init) =>
        new Response(
          body.replace(
            "PLACEHOLDER_REQUEST_ID",
            (JSON.parse(String(init?.body)) as { id: string }).id,
          ),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
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

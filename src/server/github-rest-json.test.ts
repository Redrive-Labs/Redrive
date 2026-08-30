import { describe, expect, it, vi } from "vitest";
import {
  MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS,
  GithubRestJsonError,
  parseGithubRestJson,
} from "@/server/github-rest-json";
import {
  GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
  GITHUB_REST_MAX_PAGES,
  GithubApi,
  GithubRestError,
} from "@/server/github-rest";

function deliveryResponse(value: unknown, link?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/vnd.github+json",
      ...(link === undefined ? {} : { Link: link }),
    },
  });
}

describe("lossless GitHub REST JSON decoding", () => {
  it("redelivers one delivery through the exact empty-success POST path", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, {
        status: 202,
        headers: { "content-type": "application/vnd.github+json" },
      }),
    );
    const api = new GithubApi({ fetchImplementation });

    await expect(
      api.redeliverWebhookDelivery(
        "octocat/receiver",
        "hook-42",
        "delivery-99",
        "installation-token",
      ),
    ).resolves.toBe(202);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/receiver/hooks/hook-42/deliveries/delivery-99/attempts",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "Redrive-GitHub-App-Connection",
          Authorization: "Bearer installation-token",
        },
      }),
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it.each([
    [new Error("network"), "NETWORK"],
    [new DOMException("aborted", "AbortError"), "TIMEOUT"],
  ])("classifies redelivery transport failure %s without retry", async (failure, code) => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      throw failure;
    });
    const api = new GithubApi({ fetchImplementation });

    await expect(
      api.redeliverWebhookDelivery("octocat/receiver", "42", "delivery-1", "token"),
    ).rejects.toMatchObject({ code });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("preserves bounded rate-limit metadata without retaining error bodies or credentials", async () => {
    const credential = "app-jwt-secret";
    const responseBody = `{"message":"rate limited; credential=${credential}"}`;
    const fetchImplementation = vi.fn(async () =>
      new Response(responseBody, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "Retry-After": "172800",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1893456000",
        },
      }),
    );
    const api = new GithubApi({ fetchImplementation });

    let caught: unknown;
    try {
      await api.getInstallation("42", credential);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GithubRestError);
    const error = caught as GithubRestError;
    expect(error).toMatchObject({
      code: "HTTP",
      status: 429,
      retryAfterSeconds: GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
      rateLimitRemaining: 0,
      rateLimitResetEpochSeconds: 1893456000,
      rateLimit: {
        retryAfterSeconds: GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
        rateLimitRemaining: 0,
        rateLimitResetEpochSeconds: 1893456000,
      },
    });
    expect(error.message).not.toContain(responseBody);
    expect(error.message).not.toContain(credential);
    expect(error).not.toHaveProperty("body");
    expect(error).not.toHaveProperty("response");
  });

  it.each([
    "foo Jan 1 2030",
    "Wed, 02 Jan 2030 00:00:30 UTC",
    "Wed, 02 Jan 2030 00:00:30 GMT trailing",
    "Wed, 2 Jan 2030 00:00:30 GMT",
    "Tue, 02 Jan 2030 00:00:30 GMT",
  ])("rejects non-IMF Retry-After date %s", async (retryAfter) => {
    const fetchImplementation = vi.fn(async () =>
      new Response("forbidden", {
        status: 403,
        headers: {
          "Retry-After": retryAfter,
          "X-RateLimit-Remaining": "1",
        },
      }),
    );
    const api = new GithubApi({ fetchImplementation });

    await expect(api.getInstallation("42", "app-jwt")).rejects.toMatchObject({
      status: 403,
      retryAfterSeconds: null,
      rateLimitRemaining: 1,
      rateLimitResetEpochSeconds: null,
      rateLimit: {
        retryAfterSeconds: null,
        rateLimitRemaining: 1,
        rateLimitResetEpochSeconds: null,
      },
    });
  });

  it("accepts a strictly validated IMF-fixdate Retry-After value", async () => {
    const now = Date.UTC(2030, 0, 1, 0, 0, 0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const fetchImplementation = vi.fn(async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "Retry-After": "Tue, 01 Jan 2030 00:00:30 GMT" },
        }),
      );
      const api = new GithubApi({ fetchImplementation });

      await expect(api.getInstallation("42", "app-jwt")).rejects.toMatchObject({
        status: 403,
        retryAfterSeconds: 30,
        rateLimit: { retryAfterSeconds: 30 },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("preserves unsafe integer IDs as exact strings without touching quoted values", () => {
    const appId = "900719925474099312345678901234567890";
    const parsed = parseGithubRestJson(
      `{"id":${appId},"owner":{"id":9007199254740993},"quoted":${JSON.stringify(appId)}}`,
    ) as { id: string; owner: { id: string }; quoted: string };

    expect(parsed).toEqual({ id: appId, owner: { id: "9007199254740993" }, quoted: appId });
  });

  it("rejects malformed, unfaithful, and overlong numeric literals", () => {
    expect(() => parseGithubRestJson('{"id":01}')).toThrow(GithubRestJsonError);
    expect(() => parseGithubRestJson('{"value":9007199254740993.1}')).toThrow(
      "cannot be represented faithfully",
    );
    expect(() => parseGithubRestJson('{"value":1e4000}')).toThrow(
      "cannot be represented faithfully",
    );
    expect(() =>
      parseGithubRestJson(
        `{"id":${"9".repeat(MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS + 1)}}`,
      ),
    ).toThrow("numeric literal that is too long");
  });

  it("does not round a large ID through Number before the API boundary", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response('{"id":900719925474099312345678901234567890}', {
        status: 201,
        headers: { "content-type": "application/vnd.github+json" },
      }),
    );
    const api = new GithubApi({ fetchImplementation });
    const response = await api.convertManifest("one-time-code");

    expect(response).toEqual({ id: "900719925474099312345678901234567890" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/one-time-code/conversions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "Redrive-GitHub-App-Connection",
        }),
      }),
    );
  });

  it("sends repository IDs as exact JSON integer tokens without converting them to Numbers", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response('{"token":"temporary-token","expires_at":"2026-01-01T00:10:00Z"}', {
        status: 201,
        headers: { "content-type": "application/vnd.github+json" },
      }),
    );
    const api = new GithubApi({ fetchImplementation });
    const id = "900719925474099312345678901234567890";
    await api.createInstallationToken("42", "app-jwt", [id]);
    const body = (fetchImplementation.mock.calls[0]?.[1] as RequestInit).body as string;
    expect(body).toContain(`"repository_ids":[${id}]`);
    expect(body).not.toContain("900719925474099400000000000000000000");
  });

  it("paginates repository hook discovery with bounded requests", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    const fetchImplementation = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      const values = page === 1 ? firstPage : [{ id: 100 }];
      return new Response(JSON.stringify(values), {
        status: 200,
        headers: { "content-type": "application/vnd.github+json" },
      });
    });
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listRepositoryHooks("octocat/receiver", "installation-token"))
      .resolves.toHaveLength(101);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toContain("page=1");
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain("page=2");
    expect((fetchImplementation.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer installation-token",
    });
  });

  it("starts delivery pagination with per_page and no page parameter", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request) => deliveryResponse([]));
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listWebhookDeliveries("octocat/receiver", "42", "installation-token"))
      .resolves.toEqual([]);

    const requestUrl = new URL(String(fetchImplementation.mock.calls[0]?.[0]));
    expect(requestUrl.pathname).toBe("/repos/octocat/receiver/hooks/42/deliveries");
    expect(requestUrl.searchParams.get("per_page")).toBe("100");
    expect(requestUrl.searchParams.has("page")).toBe(false);
    expect(requestUrl.search).toBe("?per_page=100");
  });

  it("stops delivery pagination after one request when Link has no next relation", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request) => deliveryResponse([{ id: "only" }]));
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listWebhookDeliveries("octocat/receiver", "42", "installation-token"))
      .resolves.toEqual([{ id: "only" }]);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("follows a delivery Link next cursor on the known endpoint", async () => {
    const path = "/repos/octocat/receiver/hooks/42/deliveries";
    const responses = [
      deliveryResponse([{ id: "first" }], `<${path}?per_page=100&cursor=next-token>; rel="next"`),
      deliveryResponse([{ id: "second" }]),
    ];
    const fetchImplementation = vi.fn(async (_input: string | URL | Request) => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listWebhookDeliveries("octocat/receiver", "42", "installation-token"))
      .resolves.toEqual([{ id: "first" }, { id: "second" }]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toBe(
      "https://api.github.com/repos/octocat/receiver/hooks/42/deliveries?per_page=100&cursor=next-token",
    );
  });

  it("collects delivery pages in order across multiple cursors", async () => {
    const path = "/repos/octocat/receiver/hooks/42/deliveries";
    const nextLink = (cursor: string) =>
      `<${path}?per_page=100&cursor=${encodeURIComponent(cursor)}>; rel="next"`;
    const responses = [
      deliveryResponse([{ id: "first" }], nextLink("cursor-1")),
      deliveryResponse([{ id: "second" }], nextLink("cursor-2")),
      deliveryResponse([{ id: "third" }]),
    ];
    const fetchImplementation = vi.fn(async (_input: string | URL | Request) => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listWebhookDeliveries("octocat/receiver", "42", "installation-token"))
      .resolves.toEqual([{ id: "first" }, { id: "second" }, { id: "third" }]);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("stops delivery pagination at the configured request bound", async () => {
    const path = "/repos/octocat/receiver/hooks/42/deliveries";
    let requestCount = 0;
    const fetchImplementation = vi.fn(async () => {
      const cursor = String(requestCount++);
      return deliveryResponse(
        [{ id: cursor }],
        `<${path}?cursor=${cursor}>; rel="next"`,
      );
    });
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listWebhookDeliveries("octocat/receiver", "42", "installation-token"))
      .rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        message: "GitHub webhook deliveries pagination exceeded the safety bound.",
      });
    expect(fetchImplementation).toHaveBeenCalledTimes(GITHUB_REST_MAX_PAGES);
  });

  it("ignores malformed or untrusted delivery Link targets", async () => {
    const path = "/repos/octocat/receiver/hooks/42/deliveries";
    const fetchImplementation = vi.fn(async (_input: string | URL | Request) =>
      deliveryResponse(
        Array.from({ length: 100 }, (_, index) => ({ id: index })),
        `<https://api.github.com/repos/attacker/other/hooks/999/deliveries?cursor=bad>; rel="next", <https://evil.example/${path}?cursor=evil>; rel="next"`,
      ),
    );
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listWebhookDeliveries("octocat/receiver", "42", "installation-token"))
      .resolves.toHaveLength(100);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/octocat/receiver/hooks/42/deliveries?per_page=100",
    );
  });

  it("encodes cursor contents without changing the delivery endpoint", async () => {
    const path = "/repos/octocat/receiver/hooks/42/deliveries";
    const cursor = "cursor&with=unsafe /?";
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(
        deliveryResponse(
          [{ id: "first" }],
          `<${path}?cursor=${encodeURIComponent(cursor)}>; rel="next"`,
        ),
      )
      .mockResolvedValueOnce(deliveryResponse([{ id: "second" }]));
    const api = new GithubApi({ fetchImplementation });

    await api.listWebhookDeliveries("octocat/receiver", "42", "installation-token");

    const nextRequest = new URL(String(fetchImplementation.mock.calls[1]?.[0]));
    expect(nextRequest.origin).toBe("https://api.github.com");
    expect(nextRequest.pathname).toBe(path);
    expect(nextRequest.searchParams.get("cursor")).toBe(cursor);
    expect(nextRequest.searchParams.has("page")).toBe(false);
    expect(nextRequest.search).not.toContain(cursor);
  });

  it("keeps large delivery IDs as exact lexical strings", async () => {
    const id = "900719925474099312345678901234567899";
    const fetchImplementation = vi.fn(async () =>
      deliveryResponse([{ id, status_code: 500 }]),
    );
    const api = new GithubApi({ fetchImplementation });

    const deliveries = await api.listWebhookDeliveries(
      "octocat/receiver",
      "42",
      "installation-token",
    );

    expect(deliveries).toEqual([{ id, status_code: 500 }]);
  });

});

import { describe, expect, it, vi } from "vitest";
import {
  TrueForge as TrueForgeSdk,
  TrueForgeError,
} from "@truefoundry/trueforge-sdk";
import {
  createTrueForgeClient,
  getTrueForgeClientOptions,
  TrueForgeConfigurationError,
  TrueForgeSessionCreateError,
  TrueForgeSessionLookupError,
  TrueForgeSessionNotFoundError,
} from "@/server/trueforge-client";

function createSdkDouble() {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      listTurnEvents: vi.fn(),
    },
  } as unknown as TrueForgeSdk;
}

describe("TrueForge SDK adapter", () => {
  it("uses the SDK's inline session request and disables POST retries", async () => {
    const sdk = createSdkDouble();
    sdk.sessions.create = vi.fn().mockResolvedValue({
      data: { id: "opaque-session-id" },
    });
    const client = createTrueForgeClient(sdk);
    const spec = {
      model: { name: "configured-trueforge-resource" },
    } as never;

    await expect(client.createSession(spec)).resolves.toBe("opaque-session-id");
    expect(sdk.sessions.create).toHaveBeenCalledWith(
      { agent: { spec } },
      { maxRetries: 0 },
    );
  });

  it("uses inline session update and exact-turn events without SDK retries", async () => {
    const sdk = createSdkDouble();
    sdk.sessions.update = vi.fn().mockResolvedValue({ data: { id: "same-session" } });
    sdk.sessions.createTurnStream = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "turn.created" };
      },
    });
    const page = {
      async *[Symbol.asyncIterator]() {
        yield { type: "turn.created" };
      },
    };
    sdk.sessions.listTurnEvents = vi.fn().mockResolvedValue(page);
    const client = createTrueForgeClient(sdk);
    const spec = { model: { name: "configured-model" } } as never;
    const request = { input: [{ type: "user.message", content: "inspect" }] } as never;

    await client.updateSession("same-session", spec);
    const stream = await client.createTurnStream("same-session", request);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ type: "turn.created" }]);
    const persistedEvents = await client.listTurnEvents(
      "same-session",
      "completed-turn-id",
    );
    expect(persistedEvents).toBe(page);
    const persisted = [];
    for await (const event of persistedEvents) persisted.push(event);
    expect(persisted).toEqual([{ type: "turn.created" }]);
    expect(sdk.sessions.listTurnEvents).toHaveBeenCalledWith(
      "same-session",
      "completed-turn-id",
      { order: "asc" },
      { maxRetries: 0 },
    );
    expect(sdk.sessions.update).toHaveBeenCalledWith(
      "same-session",
      { agent: { spec } },
      { maxRetries: 0 },
    );
    expect(sdk.sessions.createTurnStream).toHaveBeenCalledWith(
      "same-session",
      request,
      { maxRetries: 0 },
    );
  });

  it("classifies server validation failures as definitive create failures", async () => {
    const sdk = createSdkDouble();
    sdk.sessions.create = vi.fn().mockRejectedValue(
      new TrueForgeError({ statusCode: 422, message: "invalid spec" }),
    );
    const client = createTrueForgeClient(sdk);

    await expect(
      client.createSession({ model: { name: "configured-trueforge-resource" } } as never),
    ).rejects.toMatchObject({
      kind: "DEFINITIVE",
      statusCode: 422,
    });
  });

  it("fails closed for statuses not declared by the session-create SDK contract", async () => {
    for (const statusCode of [401, 403, 409, 499, 500]) {
      const sdk = createSdkDouble();
      sdk.sessions.create = vi.fn().mockRejectedValue(
        new TrueForgeError({ statusCode, message: `status ${statusCode}` }),
      );
      const client = createTrueForgeClient(sdk);

      await expect(
        client.createSession({ model: { name: "configured-trueforge-resource" } } as never),
      ).rejects.toMatchObject({
        kind: "AMBIGUOUS",
        statusCode,
      });
    }
  });

  it("maps SDK 404 reads to an explicit not-found error", async () => {
    const sdk = createSdkDouble();
    sdk.sessions.get = vi.fn().mockRejectedValue(
      new TrueForgeError({ statusCode: 404, message: "missing" }),
    );
    const client = createTrueForgeClient(sdk);

    await expect(client.getSession("lost-session")).rejects.toBeInstanceOf(
      TrueForgeSessionNotFoundError,
    );
  });

  it("keeps transient lookup failures distinct from a confirmed loss", async () => {
    const sdk = createSdkDouble();
    sdk.sessions.get = vi.fn().mockRejectedValue(
      new TrueForgeError({ statusCode: 503, message: "unavailable" }),
    );
    const client = createTrueForgeClient(sdk);

    await expect(client.getSession("active-session")).rejects.toBeInstanceOf(
      TrueForgeSessionLookupError,
    );
  });

  it("validates the configured URL and defaults to the standalone runtime", () => {
    expect(getTrueForgeClientOptions({ NODE_ENV: "test" })).toMatchObject({
      baseUrl: "http://localhost:8790",
    });
    expect(() =>
      getTrueForgeClientOptions({
        NODE_ENV: "test",
        REDRIVE_TRUEFORGE_URL: "",
      }),
    ).toThrow(TrueForgeConfigurationError);
    expect(() =>
      getTrueForgeClientOptions({
        NODE_ENV: "test",
        REDRIVE_TRUEFORGE_URL: "ftp://example",
      }),
    ).toThrow(TrueForgeConfigurationError);
  });

  it("exposes failure classes for injected-client tests", () => {
    expect(
      new TrueForgeSessionCreateError("AMBIGUOUS", "timeout"),
    ).toBeInstanceOf(Error);
  });
});

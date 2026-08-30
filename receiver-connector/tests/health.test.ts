import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHealthAdapter,
  DEFAULT_HEALTH_MAX_RESPONSE_BYTES,
} from "../src/health.js";
import type { HealthInput } from "../src/model.js";

const OBSERVED_AT = new Date("2026-08-29T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("health:v1 adapter", () => {
  it("normalizes the expected healthy receiver response", async () => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify({ status: "ok", database: "ok" })));
    const adapter = createHealthAdapter({
      healthUrl: "http://receiver.test:3000/health",
      fetchImpl,
      clock: () => OBSERVED_AT,
    });

    await expect(adapter.observe({})).resolves.toEqual({
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: OBSERVED_AT.toISOString(),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://receiver.test:3000/health",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("maps a valid receiver-declared failure to UNHEALTHY", async () => {
    const fetchImpl = vi.fn(async () => response(
      JSON.stringify({ status: "error", database: "error" }),
      503,
    ));
    const adapter = createHealthAdapter({
      healthUrl: "http://receiver.test:3000/health",
      fetchImpl,
      clock: () => OBSERVED_AT,
    });

    await expect(adapter.observe({})).resolves.toMatchObject({
      schemaVersion: 1,
      healthStatus: "UNHEALTHY",
    });
  });

  it("rejects malformed JSON, redirects, and oversized responses", async () => {
    const malformed = createHealthAdapter({
      healthUrl: "http://receiver.test/health",
      fetchImpl: vi.fn(async () => response("not-json")),
    });
    await expect(malformed.observe({})).rejects.toMatchObject({
      code: "HEALTH_MALFORMED_JSON",
    });

    const redirect = createHealthAdapter({
      healthUrl: "http://receiver.test/health",
      fetchImpl: vi.fn(async () => response("redirect", 302)),
    });
    await expect(redirect.observe({})).rejects.toMatchObject({
      code: "HEALTH_REDIRECT",
    });

    const oversized = createHealthAdapter({
      healthUrl: "http://receiver.test/health",
      maxResponseBytes: 10,
      fetchImpl: vi.fn(async () => response("x".repeat(11))),
    });
    await expect(oversized.observe({})).rejects.toMatchObject({
      code: "HEALTH_RESPONSE_TOO_LARGE",
    });
  });

  it("uses a bounded timeout and rejects transport failures as typed observations", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Promise<Response>(() => undefined));
    const adapter = createHealthAdapter({
      healthUrl: "http://receiver.test/health",
      timeoutMs: 20,
      fetchImpl,
    });
    const pending = adapter.observe({});
    const assertion = expect(pending).rejects.toMatchObject({ code: "HEALTH_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;

    const transport = createHealthAdapter({
      healthUrl: "http://receiver.test/health",
      fetchImpl: vi.fn(async () => {
        throw new Error("socket credentials should not escape");
      }),
    });
    await expect(transport.observe({})).rejects.toMatchObject({
      code: "HEALTH_TRANSPORT_ERROR",
      message: "The receiver health endpoint could not be reached.",
    });
  });

  it("does not permit a job to override the configured health URL", async () => {
    const fetchImpl = vi.fn(async () => response(JSON.stringify({ status: "ok", database: "ok" })));
    const adapter = createHealthAdapter({
      healthUrl: "http://receiver.test/health",
      fetchImpl,
    });

    await expect(adapter.observe({ url: "http://attacker.test" } as unknown as HealthInput)).rejects.toMatchObject({
      code: "INVALID_JOB",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the configured response bound finite", () => {
    expect(DEFAULT_HEALTH_MAX_RESPONSE_BYTES).toBeGreaterThan(0);
  });
});

import { createServer, type ServerResponse } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BusinessStateQueryClient } from "../src/business-state.js";
import type { ConnectorConfig } from "../src/config.js";
import { createReceiverConnectorRuntime } from "../src/runtime.js";
import {
  ConcreteRedriveHttpTransport,
} from "../src/http-transport.js";
import {
  loadOrCreateIdentity,
} from "../src/identity.js";
import {
  RECEIVER_CAPABILITIES,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  type CapabilityResult,
  type ConnectorIdentity,
} from "../src/model.js";
import type {
  CompleteRequest,
  EnrollmentRequest,
  FailRequest,
  LeaseRequest,
} from "../src/transport.js";

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

type RequestHandler = (
  request: CapturedRequest,
  response: ServerResponse,
) => void | Promise<void>;

interface TestServer {
  readonly origin: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

const testServers: TestServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const server of testServers.splice(0)) {
    await server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-connector-http-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function requestBody(request: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(handler: RequestHandler): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await requestBody(request);
      const captured: CapturedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers as Record<string, string | undefined>,
        body,
      };
      requests.push(captured);
      try {
        await handler(captured, response);
      } catch {
        if (!response.headersSent) response.statusCode = 500;
        response.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address.");
  }
  let closed = false;
  const testServer: TestServer = {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
  testServers.push(testServer);
  return testServer;
}

function sendJson(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function identity(origin: string): ConnectorIdentity {
  return {
    schemaVersion: 1,
    serverOrigin: origin,
    connectorId: "connector-id",
    connectorSecret: "connector-secret",
  };
}

function enrollmentRequest(origin: string): EnrollmentRequest {
  return {
    identity: identity(origin),
    enrollmentToken: "enrollment-token",
    capabilities: RECEIVER_CAPABILITIES,
  };
}

function leaseRequest(origin: string): LeaseRequest {
  return {
    identity: identity(origin),
    capabilities: RECEIVER_CAPABILITIES,
  };
}

function businessResult(deliveryGuid = "delivery-guid"): CapabilityResult {
  return {
    schemaVersion: 1,
    deliveryGuid,
    mutationCount: 1,
    businessState: "EXACTLY_ONE",
    observedAt: "2026-08-30T00:00:00.000Z",
  };
}

function config(origin: string, stateDir: string, token = "enrollment-token"): ConnectorConfig {
  return {
    redriveUrl: origin,
    enrollmentToken: token,
    observerDatabaseUrl: "postgresql://127.0.0.1:5434/receiver",
    receiverHealthUrl: "http://127.0.0.1:3000/health",
    connectorStateDir: stateDir,
  };
}

function centralEnrollmentResponse(
  connectorId: string,
  disposition: "ENROLLED" | "ALREADY_ENROLLED" = "ENROLLED",
): Record<string, unknown> {
  return {
    receiverConnection: { connectorId },
    disposition,
    healthJobId: "health-job-id",
  };
}

function centralCompletionResponse(
  jobId: string,
  leaseGeneration: number,
  outcome: "SUCCEEDED" | "FAILED",
  options: {
    capability?: string;
    input?: unknown;
    result?: unknown;
    errorCode?: string | null;
    job?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    job: {
      jobId,
      capability: options.capability ?? RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: options.input ?? { deliveryGuid: "delivery-guid" },
      state: outcome,
      leaseGeneration,
      leaseExpiresAt: null,
      deadlineAt: "2026-08-30T00:01:00.000Z",
      result: outcome === "SUCCEEDED" ? options.result ?? null : null,
      errorCode: outcome === "FAILED" ? options.errorCode ?? null : null,
      completedAt: "2026-08-30T00:00:03.000Z",
      ...options.job,
    },
  };
}

describe("ConcreteRedriveHttpTransport", () => {
  it.each([
    ["remote HTTPS", "https://redrive.example:4317"],
    ["localhost HTTP", "http://localhost:4317"],
    ["127.0.0.1 HTTP", "http://127.0.0.1:4317"],
    ["IPv6 loopback HTTP", "http://[::1]:4317"],
  ])("accepts %s Redrive origins", (_label, redriveUrl) => {
    expect(() => new ConcreteRedriveHttpTransport({ redriveUrl })).not.toThrow();
  });

  it.each([
    "http://redrive.example:4317",
    "https://user@redrive.example:4317",
    "https://user:password@redrive.example:4317",
    "https://redrive.example:4317/path",
    "https://redrive.example:4317?query=value",
    "https://redrive.example:4317#fragment",
  ])("rejects unsafe or non-origin Redrive URL %s", (redriveUrl) => {
    expect(() => new ConcreteRedriveHttpTransport({ redriveUrl })).toThrowError(
      expect.objectContaining({ code: "TRANSPORT_REJECTED" }),
    );
  });

  it("enrolls with the exact body and no connector auth headers", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, centralEnrollmentResponse("connector-id"));
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.enroll(enrollmentRequest(server.origin))).resolves.toEqual({
      connectorId: "connector-id",
    });

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/receiver/enroll");
    expect(request.headers["content-type"]).toMatch(/^application\/json/);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-redrive-connector-id"]).toBeUndefined();
    expect(JSON.parse(request.body)).toEqual({
      protocolVersion: "1",
      enrollmentToken: "enrollment-token",
      connectorId: "connector-id",
      connectorSecret: "connector-secret",
      capabilities: [...RECEIVER_CAPABILITIES],
    });
    expect(request.url).not.toContain("enrollment-token");
    expect(request.url).not.toContain("connector-secret");
  });

  it("classifies enrollment rejection without exposing the central body", async () => {
    const server = await startServer((_request, response) => {
      sendJson(
        response,
        {
          error: "central details must not escape",
          code: "TOKEN_INVALID",
          connectorSecret: "secret-from-central",
        },
        401,
      );
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    const error = await transport.enroll(enrollmentRequest(server.origin)).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "TRANSPORT_REJECTED",
      retryable: false,
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("central details");
    expect((error as Error).message).not.toContain("secret-from-central");
    expect((error as Error).message).not.toContain("enrollment-token");
  });

  it("bounds enrollment timeouts", async () => {
    const server = await startServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sendJson(response, centralEnrollmentResponse("connector-id"));
    });
    const transport = new ConcreteRedriveHttpTransport({
      redriveUrl: server.origin,
      enrollmentTimeoutMs: 10,
    });

    await expect(transport.enroll(enrollmentRequest(server.origin))).rejects.toMatchObject({
      code: "TRANSPORT_TIMEOUT",
      retryable: true,
    });
  });

  it("rejects malformed enrollment JSON and redirects", async () => {
    const malformedServer = await startServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end("not-json");
    });
    const malformedTransport = new ConcreteRedriveHttpTransport({
      redriveUrl: malformedServer.origin,
    });
    await expect(
      malformedTransport.enroll(enrollmentRequest(malformedServer.origin)),
    ).rejects.toMatchObject({
      code: "TRANSPORT_MALFORMED_RESPONSE",
      retryable: false,
    });

    const redirectServer = await startServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "/api/receiver/enroll");
      response.end();
    });
    const redirectTransport = new ConcreteRedriveHttpTransport({
      redriveUrl: redirectServer.origin,
    });
    await expect(
      redirectTransport.enroll(enrollmentRequest(redirectServer.origin)),
    ).rejects.toMatchObject({
      code: "TRANSPORT_REDIRECT",
      retryable: false,
    });
  });

  it("leases no work with the exact authenticated bodyless request", async () => {
    const server = await startServer((_request, response) => {
      sendJson(response, { job: null });
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.lease(leaseRequest(server.origin))).resolves.toBeNull();

    const request = server.requests[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/receiver/jobs/lease");
    expect(request.body).toBe("");
    expect(request.headers["x-redrive-connector-id"]).toBe("connector-id");
    expect(request.headers.authorization).toBe("Bearer connector-secret");
    expect(request.headers["content-type"]).toBeUndefined();
  });

  it("strictly parses business and health leases", async () => {
    const jobs = [
      {
        jobId: "business-job",
        capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
        input: { deliveryGuid: "delivery-guid" },
        leaseGeneration: 4,
        leaseExpiresAt: "2026-08-30T00:00:15.000Z",
        deadlineAt: "2026-08-30T00:01:00.000Z",
      },
      {
        jobId: "health-job",
        capability: RECEIVER_CAPABILITY_HEALTH,
        input: {},
        leaseGeneration: 5,
        leaseExpiresAt: "2026-08-30T00:00:15.000Z",
        deadlineAt: "2026-08-30T00:01:00.000Z",
      },
    ];
    const server = await startServer((_request, response) => {
      sendJson(response, { job: jobs.shift() ?? null });
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.lease(leaseRequest(server.origin))).resolves.toEqual({
      jobId: "business-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 4,
      leaseExpiresAt: "2026-08-30T00:00:15.000Z",
      deadlineAt: "2026-08-30T00:01:00.000Z",
    });
    await expect(transport.lease(leaseRequest(server.origin))).resolves.toEqual({
      jobId: "health-job",
      capability: RECEIVER_CAPABILITY_HEALTH,
      input: {},
      leaseGeneration: 5,
      leaseExpiresAt: "2026-08-30T00:00:15.000Z",
      deadlineAt: "2026-08-30T00:01:00.000Z",
    });
  });

  it("rejects lease jobs without identifiers or with unsupported capabilities", async () => {
    const invalidJobs = [
      {
        capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
        input: { deliveryGuid: "delivery-guid" },
        leaseGeneration: 1,
      },
      {
        jobId: "unknown-job",
        capability: "logs:v1",
        input: {},
        leaseGeneration: 1,
      },
    ];
    const server = await startServer((_request, response) => {
      sendJson(response, { job: invalidJobs.shift() });
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.lease(leaseRequest(server.origin))).rejects.toMatchObject({
      code: "TRANSPORT_MALFORMED_RESPONSE",
    });
    await expect(transport.lease(leaseRequest(server.origin))).rejects.toMatchObject({
      code: "TRANSPORT_MALFORMED_RESPONSE",
    });
  });

  it("classifies lease timeout and network failure as retryable", async () => {
    const timeoutServer = await startServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sendJson(response, { job: null });
    });
    const timeoutTransport = new ConcreteRedriveHttpTransport({
      redriveUrl: timeoutServer.origin,
      leaseTimeoutMs: 10,
    });
    await expect(timeoutTransport.lease(leaseRequest(timeoutServer.origin))).rejects.toMatchObject({
      code: "TRANSPORT_TIMEOUT",
      retryable: true,
    });

    const networkTransport = new ConcreteRedriveHttpTransport({
      redriveUrl: "http://127.0.0.1:1",
      leaseTimeoutMs: 100,
    });
    await expect(networkTransport.lease(leaseRequest("http://127.0.0.1:1"))).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      retryable: true,
    });
  });

  it("completes a job on its encoded path with the exact leased generation", async () => {
    const jobId = "job/id?value=1#fragment";
    const server = await startServer((_request, response) => {
      sendJson(response, centralCompletionResponse(jobId, 17, "SUCCEEDED", {
        result: businessResult(),
      }));
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });
    const request: CompleteRequest = {
      identity: identity(server.origin),
      jobId,
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 17,
      result: businessResult(),
    };

    await expect(transport.complete(request)).resolves.toBeUndefined();

    const captured = server.requests[0];
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe(
      "/api/receiver/jobs/job%2Fid%3Fvalue%3D1%23fragment/complete",
    );
    expect(captured.headers["x-redrive-connector-id"]).toBe("connector-id");
    expect(captured.headers.authorization).toBe("Bearer connector-secret");
    expect(captured.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(captured.body)).toEqual({
      leaseGeneration: 17,
      outcome: "SUCCEEDED",
      result: businessResult(),
    });
    expect(captured.url).not.toContain("connector-secret");
  });

  it("fails a job with only the sanitized error code and rejects central failure", async () => {
    const jobId = "job-failure";
    const server = await startServer((request, response) => {
      if (request.url?.endsWith("/complete")) {
        sendJson(response, centralCompletionResponse(jobId, 23, "FAILED", {
          capability: RECEIVER_CAPABILITY_HEALTH,
          input: {},
          errorCode: "HEALTH_TIMEOUT",
        }));
        return;
      }
      sendJson(response, { error: "rejected", code: "STALE_LEASE" }, 409);
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });
    const request: FailRequest = {
      identity: identity(server.origin),
      jobId,
      capability: RECEIVER_CAPABILITY_HEALTH,
      leaseGeneration: 23,
      error: {
        schemaVersion: 1,
        code: "HEALTH_TIMEOUT",
        message: "local detail must not be sent",
        retryable: true,
      },
    };

    await expect(transport.fail(request)).resolves.toBeUndefined();
    expect(JSON.parse(server.requests[0].body)).toEqual({
      leaseGeneration: 23,
      outcome: "FAILED",
      errorCode: "HEALTH_TIMEOUT",
    });
    expect(server.requests[0].body).not.toContain("local detail");

  });

  it.each([
    [409, "STALE_LEASE", "TRANSPORT_COMPLETION_FENCED"],
    [409, "LEASE_EXPIRED", "TRANSPORT_COMPLETION_FENCED"],
    [422, "DEADLINE_EXPIRED", "TRANSPORT_COMPLETION_FENCED"],
    [422, "JOB_EXPIRED", "TRANSPORT_COMPLETION_FENCED"],
    [409, "JOB_ALREADY_COMPLETED", "TRANSPORT_REJECTED"],
    [409, "INVALID_STATE", "TRANSPORT_REJECTED"],
    [409, undefined, "TRANSPORT_REJECTED"],
    [422, undefined, "TRANSPORT_REJECTED"],
  ] as const)("classifies completion status %s and code %s", async (status, centralCode, expectedCode) => {
    const server = await startServer((_request, response) => {
      sendJson(
        response,
        centralCode === undefined
          ? { error: "central rejection" }
          : { error: "central rejection", code: centralCode },
        status,
      );
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.complete({
      identity: identity(server.origin),
      jobId: "completion-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 17,
      result: businessResult(),
    })).rejects.toMatchObject({
      code: expectedCode,
      retryable: false,
    });
  });

  it("classifies a malformed completion error response as malformed, not fenced", async () => {
    const server = await startServer((_request, response) => {
      response.statusCode = 409;
      response.setHeader("content-type", "application/json");
      response.end("not-json");
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.complete({
      identity: identity(server.origin),
      jobId: "completion-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 17,
      result: businessResult(),
    })).rejects.toMatchObject({
      code: "TRANSPORT_MALFORMED_RESPONSE",
      retryable: false,
    });
  });

  it.each([
    [502, "<html>bad gateway</html>"],
    [503, ""],
    [503, "not-json"],
  ] as const)("preserves retryable completion transport errors for %s with a transient body", async (status, body) => {
    const server = await startServer((_request, response) => {
      response.statusCode = status;
      response.end(body);
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.complete({
      identity: identity(server.origin),
      jobId: "completion-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 17,
      result: businessResult(),
    })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      retryable: true,
    });
  });

  it("classifies completion authentication without parsing a malformed body", async () => {
    const server = await startServer((_request, response) => {
      response.statusCode = 401;
      response.end("not-json");
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });

    await expect(transport.complete({
      identity: identity(server.origin),
      jobId: "completion-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 17,
      result: businessResult(),
    })).rejects.toMatchObject({
      code: "TRANSPORT_AUTHENTICATION",
      retryable: false,
    });
  });

  it("rejects completion responses without exact correlation and terminal outcome", async () => {
    const responses: Record<string, unknown>[] = [
      centralCompletionResponse("completion-job", 4, "SUCCEEDED", {
        result: businessResult(),
        job: { jobId: "different-job" },
      }),
      centralCompletionResponse("completion-job", 4, "SUCCEEDED", {
        result: businessResult(),
        job: { leaseGeneration: 5 },
      }),
      centralCompletionResponse("completion-job", 4, "SUCCEEDED", {
        result: businessResult(),
        job: { state: "FAILED" },
      }),
      { job: { jobId: "completion-job" } },
    ];
    const server = await startServer((_request, response) => {
      sendJson(response, responses.shift());
    });
    const transport = new ConcreteRedriveHttpTransport({ redriveUrl: server.origin });
    const request: CompleteRequest = {
      identity: identity(server.origin),
      jobId: "completion-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid" },
      leaseGeneration: 4,
      result: businessResult(),
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(transport.complete(request)).rejects.toMatchObject({
        code: "TRANSPORT_MALFORMED_RESPONSE",
        retryable: false,
      });
    }
  });
});

describe("receiver connector runtime over HTTP", () => {
  it("persists identity before enrollment, acknowledges it after HTTP success, leases, dispatches, and completes", async () => {
    const stateDir = temporaryDirectory();
    let enrollmentRequestObservedBeforeAcknowledgment = false;
    let leaseCalls = 0;
    const server = await startServer((request, response) => {
      if (request.url === "/api/receiver/enroll") {
        const persisted = JSON.parse(
          readFileSync(path.join(stateDir, "identity.json"), "utf8"),
        ) as { enrollmentAcknowledged?: unknown };
        enrollmentRequestObservedBeforeAcknowledgment =
          persisted.enrollmentAcknowledged === false;
        sendJson(response, centralEnrollmentResponse("connector-id"));
        return;
      }
      if (request.url === "/api/receiver/jobs/lease") {
        leaseCalls += 1;
        sendJson(response, {
          job: leaseCalls === 1
            ? {
                jobId: "business-job",
                capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
                input: { deliveryGuid: "delivery-guid" },
                leaseGeneration: 8,
              }
            : null,
        });
        return;
      }
      if (request.url === "/api/receiver/jobs/business-job/complete") {
        sendJson(response, centralCompletionResponse("business-job", 8, "SUCCEEDED", {
          result: businessResult(),
        }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const connectorConfig = config(server.origin, stateDir);
    const databaseClient = {
      query: vi.fn(async () => ({
        rows: [{ mutation_count: "1" }],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      })),
    } as unknown as BusinessStateQueryClient;
    const runtime = createReceiverConnectorRuntime({
      config: connectorConfig,
      transport: new ConcreteRedriveHttpTransport({ redriveUrl: server.origin }),
      databaseClient,
      identityGenerator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });

    await expect(runtime.worker.runOnce()).resolves.toMatchObject({
      kind: "COMPLETED",
      job: { jobId: "business-job", leaseGeneration: 8 },
    });
    await runtime.close();

    const persisted = JSON.parse(
      readFileSync(path.join(stateDir, "identity.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(enrollmentRequestObservedBeforeAcknowledgment).toBe(true);
    expect(persisted).toMatchObject({
      connectorId: "connector-id",
      connectorSecret: "connector-secret",
      enrollmentAcknowledged: true,
    });
    expect(JSON.stringify(persisted)).not.toContain("enrollment-token");
    expect(server.requests.map(({ url }) => url)).toEqual([
      "/api/receiver/enroll",
      "/api/receiver/jobs/lease",
      "/api/receiver/jobs/business-job/complete",
    ]);
    expect(JSON.parse(server.requests[2].body)).toMatchObject({
      leaseGeneration: 8,
      outcome: "SUCCEEDED",
      result: {
        deliveryGuid: "delivery-guid",
        mutationCount: 1,
        businessState: "EXACTLY_ONE",
      },
    });
    expect(databaseClient.query).toHaveBeenCalledTimes(1);
  });

  it("replays accepted enrollment after an unacknowledged durable state and continues with the same identity", async () => {
    const stateDir = temporaryDirectory();
    let enrollmentCalls = 0;
    const server = await startServer((request, response) => {
      if (request.url === "/api/receiver/enroll") {
        enrollmentCalls += 1;
        sendJson(
          response,
          centralEnrollmentResponse(
            "connector-id",
            enrollmentCalls === 1 ? "ENROLLED" : "ALREADY_ENROLLED",
          ),
        );
        return;
      }
      if (request.url === "/api/receiver/jobs/lease") {
        sendJson(response, {
          job: {
            jobId: "replayed-business-job",
            capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
            input: { deliveryGuid: "replayed-delivery-guid" },
            leaseGeneration: 2,
          },
        });
        return;
      }
      if (request.url === "/api/receiver/jobs/replayed-business-job/complete") {
        sendJson(response, centralCompletionResponse("replayed-business-job", 2, "SUCCEEDED", {
          input: { deliveryGuid: "replayed-delivery-guid" },
          result: businessResult("replayed-delivery-guid"),
        }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const connectorConfig = config(server.origin, stateDir);
    const first = loadOrCreateIdentity({
      stateDir,
      serverOrigin: server.origin,
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });
    await new ConcreteRedriveHttpTransport({ redriveUrl: server.origin }).enroll({
      identity: first.identity,
      enrollmentToken: "enrollment-token",
      capabilities: RECEIVER_CAPABILITIES,
    });
    expect(JSON.parse(readFileSync(first.identityPath, "utf8"))).toMatchObject({
      connectorId: first.identity.connectorId,
      connectorSecret: first.identity.connectorSecret,
      enrollmentAcknowledged: false,
    });

    const databaseClient = {
      query: vi.fn(async () => ({
        rows: [{ mutation_count: "0" }],
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
      })),
    } as unknown as BusinessStateQueryClient;
    const generator = {
      connectorId: vi.fn(() => "must-not-be-used"),
      connectorSecret: vi.fn(() => "must-not-be-used"),
    };
    const runtime = createReceiverConnectorRuntime({
      config: connectorConfig,
      transport: new ConcreteRedriveHttpTransport({ redriveUrl: server.origin }),
      databaseClient,
      identityGenerator: generator,
    });

    await expect(runtime.worker.runOnce()).resolves.toMatchObject({
      kind: "COMPLETED",
      job: { jobId: "replayed-business-job", leaseGeneration: 2 },
    });
    await runtime.close();

    expect(enrollmentCalls).toBe(2);
    expect(generator.connectorId).not.toHaveBeenCalled();
    expect(generator.connectorSecret).not.toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(first.identityPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      connectorId: first.identity.connectorId,
      connectorSecret: first.identity.connectorSecret,
      enrollmentAcknowledged: true,
    });
    expect(server.requests[0].body).toBe(server.requests[1].body);
  });
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorConfig } from "../src/config.js";
import { TransportError } from "../src/errors.js";
import { connectorIdentityPath } from "../src/identity.js";
import {
  CapabilityValidationError,
  RECEIVER_CAPABILITIES,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  type CapabilityJob,
  type CapabilityResult,
  type ConnectorIdentity,
} from "../src/model.js";
import type { RedriveTransport } from "../src/transport.js";
import { ReceiverConnectorWorker } from "../src/worker.js";

const OBSERVED_AT = "2026-08-29T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-connector-worker-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(stateDir: string, enrollmentToken?: string): ConnectorConfig {
  return {
    redriveUrl: "http://redrive.test:4317",
    enrollmentToken,
    observerDatabaseUrl: "postgresql://127.0.0.1:5434/receiver",
    receiverHealthUrl: "http://127.0.0.1:3000/health",
    connectorStateDir: stateDir,
  };
}

function transport(overrides: Partial<RedriveTransport> = {}): RedriveTransport & {
  enroll: ReturnType<typeof vi.fn>;
  lease: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    enroll: vi.fn(async () => ({})),
    lease: vi.fn(async () => null),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as RedriveTransport & {
    enroll: ReturnType<typeof vi.fn>;
    lease: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
  };
}

function worker(
  stateDir: string,
  connectorTransport: RedriveTransport,
  dispatcher: (job: CapabilityJob) => Promise<CapabilityResult> = async (job) => {
    if (job.capability === RECEIVER_CAPABILITY_BUSINESS_STATE) {
      return {
        schemaVersion: 1,
        deliveryGuid: job.input.deliveryGuid,
        mutationCount: 0,
        businessState: "ABSENT",
        observedAt: OBSERVED_AT,
      };
    }
    return {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: OBSERVED_AT,
    };
  },
  enrollmentToken = "bootstrap-token",
  extra: Partial<ConstructorParameters<typeof ReceiverConnectorWorker>[0]> = {},
): ReceiverConnectorWorker {
  return new ReceiverConnectorWorker({
    config: config(stateDir, enrollmentToken),
    transport: connectorTransport,
    dispatcher,
    retryPolicy: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
    sleep: vi.fn(async () => undefined),
    ...extra,
  });
}

describe("receiver connector worker", () => {
  it("persists identity before the first enrollment attempt and advertises exactly two capabilities", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport();
    connectorTransport.enroll.mockImplementation(async (request: { identity: ConnectorIdentity; capabilities: readonly string[] }) => {
      expect(existsSync(connectorIdentityPath(stateDir))).toBe(true);
      expect(JSON.parse(readFileSync(connectorIdentityPath(stateDir), "utf8"))).toMatchObject({
        enrollmentAcknowledged: false,
      });
      expect(JSON.parse(readFileSync(connectorIdentityPath(stateDir), "utf8"))).not.toHaveProperty("enrollmentToken");
      expect(request.capabilities).toEqual(RECEIVER_CAPABILITIES);
      return {};
    });
    const connector = worker(stateDir, connectorTransport);

    await connector.runOnce();

    expect(connectorTransport.enroll).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(connectorIdentityPath(stateDir), "utf8"))).toMatchObject({
      enrollmentAcknowledged: true,
    });
    expect(connectorTransport.lease).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: RECEIVER_CAPABILITIES,
    }));
  });

  it("keeps the newly persisted identity when the bootstrap token is missing", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport();
    const connector = new ReceiverConnectorWorker({
      config: config(stateDir),
      transport: connectorTransport,
      dispatcher: async () => ({
        schemaVersion: 1,
        healthStatus: "HEALTHY",
        observedAt: OBSERVED_AT,
      }),
      sleep: vi.fn(async () => undefined),
    });

    await expect(connector.initialize()).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    expect(existsSync(connectorIdentityPath(stateDir))).toBe(true);
    expect(JSON.parse(readFileSync(connectorIdentityPath(stateDir), "utf8"))).toMatchObject({
      enrollmentAcknowledged: false,
    });
    expect(connectorTransport.enroll).not.toHaveBeenCalled();
  });

  it("reuses persisted identity on restart without enrollment", async () => {
    const stateDir = temporaryDirectory();
    const firstTransport = transport();
    const first = worker(stateDir, firstTransport);
    const firstIdentity = await first.initialize();

    const secondTransport = transport();
    const second = new ReceiverConnectorWorker({
      config: config(stateDir),
      transport: secondTransport,
      dispatcher: async () => ({
        schemaVersion: 1,
        healthStatus: "HEALTHY",
        observedAt: OBSERVED_AT,
      }),
      sleep: vi.fn(async () => undefined),
    });
    const secondIdentity = await second.initialize();

    expect(secondIdentity).toEqual(firstIdentity);
    expect(secondTransport.enroll).not.toHaveBeenCalled();
  });

  it("retries pending enrollment after restart with the same identity", async () => {
    const stateDir = temporaryDirectory();
    const connectorId = vi.fn(() => "connector-id");
    const connectorSecret = vi.fn(() => "connector-secret");
    const firstTransport = transport({
      enroll: vi.fn(async () => {
        throw new Error("enrollment failed");
      }),
    });
    const first = worker(stateDir, firstTransport, undefined, "bootstrap-token", {
      identityGenerator: { connectorId, connectorSecret },
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(first.initialize()).rejects.toThrow("enrollment failed");
    const firstIdentity = first.currentIdentity;
    expect(firstIdentity).toBeDefined();

    const secondConnectorId = vi.fn(() => "should-not-be-used");
    const secondConnectorSecret = vi.fn(() => "should-not-be-used");
    const secondTransport = transport();
    const second = worker(stateDir, secondTransport, undefined, "bootstrap-token", {
      identityGenerator: {
        connectorId: secondConnectorId,
        connectorSecret: secondConnectorSecret,
      },
    });

    await second.initialize();

    expect(second.currentIdentity).toEqual(firstIdentity);
    expect(secondTransport.enroll).toHaveBeenCalledWith(expect.objectContaining({
      identity: firstIdentity,
      enrollmentToken: "bootstrap-token",
    }));
    expect(secondConnectorId).not.toHaveBeenCalled();
    expect(secondConnectorSecret).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(connectorIdentityPath(stateDir), "utf8"))).toMatchObject({
      enrollmentAcknowledged: true,
    });
  });

  it("fails closed when pending enrollment restarts without a token", async () => {
    const stateDir = temporaryDirectory();
    const firstTransport = transport({
      enroll: vi.fn(async () => {
        throw new Error("enrollment failed");
      }),
    });
    const first = worker(stateDir, firstTransport, undefined, "bootstrap-token", {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
    });
    await expect(first.initialize()).rejects.toThrow("enrollment failed");

    const secondTransport = transport();
    const second = new ReceiverConnectorWorker({
      config: config(stateDir),
      transport: secondTransport,
      dispatcher: async () => ({
        schemaVersion: 1,
        healthStatus: "HEALTHY",
        observedAt: OBSERVED_AT,
      }),
    });

    await expect(second.initialize()).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      message: "REDRIVE_ENROLLMENT_TOKEN is required while connector enrollment is not acknowledged.",
    });
    expect(secondTransport.enroll).not.toHaveBeenCalled();
    expect(second.currentIdentity).toEqual(first.currentIdentity);
  });

  it("retries a lost enrollment response after restart with the same identity", async () => {
    const stateDir = temporaryDirectory();
    const firstTransport = transport({
      enroll: vi.fn(async () => {
        throw new Error("enrollment response lost");
      }),
    });
    const first = worker(stateDir, firstTransport, undefined, "bootstrap-token", {
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      identityGenerator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });

    await expect(first.initialize()).rejects.toThrow("enrollment response lost");
    const firstIdentity = first.currentIdentity;

    const secondTransport = transport();
    const second = worker(stateDir, secondTransport, undefined, "bootstrap-token", {
      identityGenerator: {
        connectorId: () => "should-not-be-used",
        connectorSecret: () => "should-not-be-used",
      },
    });
    await second.initialize();

    expect(second.currentIdentity).toEqual(firstIdentity);
    expect(secondTransport.enroll).toHaveBeenCalledWith(expect.objectContaining({
      identity: firstIdentity,
      enrollmentToken: "bootstrap-token",
    }));
  });

  it("retries a lost enrollment response with the same persisted identity", async () => {
    const stateDir = temporaryDirectory();
    const identities: ConnectorIdentity[] = [];
    let attempts = 0;
    const connectorTransport = transport();
    connectorTransport.enroll.mockImplementation(async (request: { identity: ConnectorIdentity }) => {
      identities.push(request.identity);
      attempts += 1;
      if (attempts === 1) throw new Error("response lost");
      return {};
    });
    const connector = worker(stateDir, connectorTransport, undefined, "bootstrap-token", {
      retryPolicy: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
    });

    await connector.initialize();

    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
    expect(JSON.parse(readFileSync(connectorIdentityPath(stateDir), "utf8"))).toMatchObject({
      connectorId: identities[0].connectorId,
      connectorSecret: identities[0].connectorSecret,
      enrollmentAcknowledged: true,
    });
  });

  it("rejects a business lease without jobId before dispatch", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
        leaseGeneration: 17,
        input: { deliveryGuid: "delivery-guid" },
      } as unknown as CapabilityJob)),
    });
    const dispatcher = vi.fn(async () => ({
      schemaVersion: 1 as const,
      deliveryGuid: "delivery-guid",
      mutationCount: 0,
      businessState: "ABSENT" as const,
      observedAt: OBSERVED_AT,
    }));
    const connector = worker(stateDir, connectorTransport, dispatcher);

    await expect(connector.runOnce()).rejects.toMatchObject({
      code: "INVALID_JOB",
    });
    expect(dispatcher).not.toHaveBeenCalled();
    expect(connectorTransport.complete).not.toHaveBeenCalled();
    expect(connectorTransport.fail).not.toHaveBeenCalled();
  });

  it("rejects a health lease without jobId before dispatch", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        capability: RECEIVER_CAPABILITY_HEALTH,
        leaseGeneration: 9,
        input: {},
      } as unknown as CapabilityJob)),
    });
    const dispatcher = vi.fn(async () => ({
      schemaVersion: 1 as const,
      healthStatus: "HEALTHY" as const,
      observedAt: OBSERVED_AT,
    }));
    const connector = worker(stateDir, connectorTransport, dispatcher);

    await expect(connector.runOnce()).rejects.toMatchObject({
      code: "INVALID_JOB",
    });
    expect(dispatcher).not.toHaveBeenCalled();
    expect(connectorTransport.complete).not.toHaveBeenCalled();
    expect(connectorTransport.fail).not.toHaveBeenCalled();
  });

  it("uses the exact leased generation for successful completion", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        jobId: "job-1",
        capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
        leaseGeneration: 17,
        input: { deliveryGuid: "delivery-guid" },
      })),
    });
    const connector = worker(stateDir, connectorTransport);

    await expect(connector.runOnce()).resolves.toMatchObject({ kind: "COMPLETED" });
    expect(connectorTransport.complete).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      leaseGeneration: 17,
      input: { deliveryGuid: "delivery-guid" },
      result: expect.objectContaining({ mutationCount: 0, businessState: "ABSENT" }),
    }));
    expect(connectorTransport.fail).not.toHaveBeenCalled();
  });

  it("fails a leased job when its adapter fails and does not complete it", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        jobId: "job-2",
        capability: RECEIVER_CAPABILITY_HEALTH,
        leaseGeneration: 9,
        input: {},
      })),
    });
    const connector = worker(stateDir, connectorTransport, async () => {
      throw new Error("adapter internals must not escape");
    });

    await expect(connector.runOnce()).resolves.toMatchObject({
      kind: "FAILED",
      error: { code: "TRANSPORT_ERROR", retryable: true },
    });
    expect(connectorTransport.fail).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-2",
      capability: RECEIVER_CAPABILITY_HEALTH,
      leaseGeneration: 9,
      error: expect.objectContaining({ message: expect.not.stringContaining("internals") }),
    }));
    expect(connectorTransport.complete).not.toHaveBeenCalled();
  });

  it("fails unknown capabilities safely using the leased generation", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        jobId: "job-unknown",
        capability: "logs:v1",
        leaseGeneration: 23,
        input: {},
      } as unknown as CapabilityJob)),
    });
    const dispatcher = vi.fn(async () => {
      throw new Error("must not dispatch unknown capability");
    });
    const connector = worker(stateDir, connectorTransport, dispatcher);

    await expect(connector.runOnce()).resolves.toMatchObject({
      kind: "FAILED",
      error: { code: "UNSUPPORTED_CAPABILITY", retryable: false },
    });
    expect(dispatcher).not.toHaveBeenCalled();
    expect(connectorTransport.fail).toHaveBeenCalledWith(expect.objectContaining({
      capability: "logs:v1",
      leaseGeneration: 23,
      error: expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }),
    }));
  });

  it("returns no-work without dispatching", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport();
    const dispatcher = vi.fn(async () => ({
      schemaVersion: 1 as const,
      healthStatus: "HEALTHY" as const,
      observedAt: OBSERVED_AT,
    }));
    const connector = worker(stateDir, connectorTransport, dispatcher);

    await expect(connector.runOnce()).resolves.toEqual({ kind: "NO_WORK" });
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("continues polling after a fenced completion and processes the next job", async () => {
    const stateDir = temporaryDirectory();
    const controller = new AbortController();
    let leaseCalls = 0;
    let completionCalls = 0;
    const firstJob: CapabilityJob = {
      jobId: "expired-job",
      capability: RECEIVER_CAPABILITY_HEALTH,
      leaseGeneration: 1,
      input: {},
    };
    const secondJob: CapabilityJob = {
      jobId: "next-job",
      capability: RECEIVER_CAPABILITY_HEALTH,
      leaseGeneration: 1,
      input: {},
    };
    const connectorTransport = transport({
      lease: vi.fn(async () => {
        leaseCalls += 1;
        if (leaseCalls === 1) return firstJob;
        if (leaseCalls === 2) return secondJob;
        return null;
      }),
      complete: vi.fn(async () => {
        completionCalls += 1;
        if (completionCalls === 1) {
          throw new TransportError(
            "TRANSPORT_COMPLETION_FENCED",
            "job expired",
            false,
          );
        }
        controller.abort();
      }),
    });
    const connector = worker(stateDir, connectorTransport);

    await expect(connector.run(controller.signal)).resolves.toBeUndefined();
    expect(connectorTransport.lease).toHaveBeenCalledTimes(2);
    expect(connectorTransport.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps authentication rejection fatal", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        jobId: "auth-job",
        capability: RECEIVER_CAPABILITY_HEALTH,
        leaseGeneration: 1,
        input: {},
      })),
      complete: vi.fn(async () => {
        throw new TransportError(
          "TRANSPORT_AUTHENTICATION",
          "authentication rejected",
          false,
        );
      }),
    });
    const connector = worker(stateDir, connectorTransport);

    await expect(connector.run()).rejects.toMatchObject({
      code: "TRANSPORT_AUTHENTICATION",
      retryable: false,
    });
  });

  it("keeps non-fenced completion rejection visible", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        jobId: "already-completed-job",
        capability: RECEIVER_CAPABILITY_HEALTH,
        leaseGeneration: 1,
        input: {},
      })),
      complete: vi.fn(async () => {
        throw new TransportError(
          "TRANSPORT_REJECTED",
          "central job is already completed",
          false,
        );
      }),
    });
    const connector = worker(stateDir, connectorTransport);

    await expect(connector.run()).rejects.toMatchObject({
      code: "TRANSPORT_REJECTED",
      retryable: false,
    });
  });

  it("keeps malformed completion protocol failures fatal", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport({
      lease: vi.fn(async () => ({
        jobId: "malformed-job",
        capability: RECEIVER_CAPABILITY_HEALTH,
        leaseGeneration: 1,
        input: {},
      })),
      complete: vi.fn(async () => {
        throw new CapabilityValidationError(
          "INVALID_RESULT",
          "malformed completion",
        );
      }),
    });
    const connector = worker(stateDir, connectorTransport);

    await expect(connector.run()).rejects.toMatchObject({
      code: "INVALID_RESULT",
    });
  });

  it("bounds transient transport retries with backoff", async () => {
    const stateDir = temporaryDirectory();
    let attempts = 0;
    const delays: number[] = [];
    const connectorTransport = transport({
      lease: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary transport failure");
        return null;
      }),
    });
    const connector = new ReceiverConnectorWorker({
      config: config(stateDir, "bootstrap-token"),
      transport: connectorTransport,
      dispatcher: async () => ({
        schemaVersion: 1,
        healthStatus: "HEALTHY",
        observedAt: OBSERVED_AT,
      }),
      retryPolicy: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20 },
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await expect(connector.runOnce()).resolves.toEqual({ kind: "NO_WORK" });
    expect(connectorTransport.lease).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]);
  });

  it("waits after no work in the long-running loop", async () => {
    const stateDir = temporaryDirectory();
    const connectorTransport = transport();
    const controller = new AbortController();
    const sleep = vi.fn(async () => {
      controller.abort();
    });
    const connector = worker(stateDir, connectorTransport, undefined, "bootstrap-token", {
      sleep,
      idleDelayMs: 321,
    });

    await connector.run(controller.signal);

    expect(sleep).toHaveBeenCalledWith(321);
    expect(connectorTransport.lease).toHaveBeenCalledTimes(1);
  });
});

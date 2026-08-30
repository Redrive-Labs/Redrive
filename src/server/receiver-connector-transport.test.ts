import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcreteRedriveHttpTransport } from "../../receiver-connector/src/http-transport.js";
import { ReceiverConnectorWorker } from "../../receiver-connector/src/worker.js";
import type { RedriveTransport } from "../../receiver-connector/src/transport.js";
import type { CapabilityJob } from "../../receiver-connector/src/model.js";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import {
  createReceiverConnectionService,
  type AuthenticatedReceiverConnector,
} from "@/server/receiver-connection-service";
import { createReceiverReadJobService } from "@/server/receiver-read-job-service";
import {
  toReceiverCompletedJob,
  toReceiverLeasedJob,
} from "@/server/receiver-route-utils";
import {
  RECEIVER_CAPABILITIES,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  RECEIVER_CONNECTION_READY,
  RECEIVER_CONNECTION_UNHEALTHY,
  RECEIVER_CONNECTION_VERIFYING,
  RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
  RECEIVER_CONNECTOR_PROTOCOL_VERSION,
} from "@/domain/receiver-connector";

const START = new Date("2026-01-01T00:00:00.000Z");
const APP_CONNECTION_ID = "application-connection-1";
const SECOND_APP_CONNECTION_ID = "application-connection-2";
const CONNECTOR_ID = "connector-1";
const CONNECTOR_SECRET = "connector-secret-1";

function addApplicationConnection(database: SqliteDatabase, id = APP_CONNECTION_ID): void {
  database.run(
    `INSERT INTO github_app_registrations
      (id, github_app_id, slug, owner_id, owner_login, owner_type,
       private_key_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["registration-1", "app-1", "redrive", "owner-1", "octocat", "User", "key-ref", START.toISOString(), START.toISOString()],
  );
  database.run(
    `INSERT INTO github_installations
      (installation_id, app_registration_id, account_id, account_login,
       account_type, repository_selection, last_verified_at, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["installation-1", "registration-1", "account-1", "octocat", "User", "selected", START.toISOString(), START.toISOString(), START.toISOString()],
  );
  database.run(
    `INSERT INTO application_connections
      (id, provider, github_installation_id, repository_id,
       repository_full_name, webhook_id, webhook_target_display, state,
       created_at, updated_at)
     VALUES (?, 'github', 'installation-1', 'repository-1',
       'octocat/receiver', 'webhook-1', 'https://receiver.example/hooks',
       'READY', ?, ?)`,
    [id, START.toISOString(), START.toISOString()],
  );
}

function addSecondApplicationConnection(database: SqliteDatabase): void {
  database.run(
    `INSERT INTO application_connections
      (id, provider, github_installation_id, repository_id,
       repository_full_name, webhook_id, webhook_target_display, state,
       created_at, updated_at)
     VALUES (?, 'github', 'installation-1', 'repository-2',
       'octocat/other-receiver', 'webhook-2', 'https://receiver.example/hooks',
       'READY', ?, ?)`,
    [SECOND_APP_CONNECTION_ID, START.toISOString(), START.toISOString()],
  );
}

describe("central receiver connector transport foundation", () => {
  let directory: string;
  let database: SqliteDatabase;
  let now: Date;
  let tokenNumber: number;
  let connections: ReturnType<typeof createReceiverConnectionService>;
  let jobs: ReturnType<typeof createReceiverReadJobService>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-receiver-transport-"));
    database = openDatabase(path.join(directory, "records.sqlite"));
    addApplicationConnection(database);
    now = new Date(START);
    tokenNumber = 0;
    connections = createReceiverConnectionService({
      database,
      clock: () => now,
      tokenGenerator: () => `enrollment-token-${++tokenNumber}`,
    });
    jobs = createReceiverReadJobService({ database, clock: () => now });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function issue() {
    return connections.issue(APP_CONNECTION_ID);
  }

  function enroll(
    token: string,
    connectorId = CONNECTOR_ID,
    connectorSecret = CONNECTOR_SECRET,
  ) {
    return connections.enroll({
      protocolVersion: RECEIVER_CONNECTOR_PROTOCOL_VERSION,
      enrollmentToken: token,
      connectorId,
      connectorSecret,
      capabilities: [...RECEIVER_CAPABILITIES],
    });
  }

  function authenticated(): AuthenticatedReceiverConnector {
    return connections.authenticate({
      connectorId: CONNECTOR_ID,
      connectorSecret: CONNECTOR_SECRET,
    });
  }

  it("migrates the receiver schema without changing a populated READY application connection", () => {
    expect(database.get<{ state: string }>(
      "SELECT state FROM application_connections WHERE id = ?",
      [APP_CONNECTION_ID],
    )?.state).toBe("READY");
    expect(database.all<{ name: string }>(
      "PRAGMA table_info('receiver_connections')",
    ).map(({ name }) => name)).toEqual([
      "id",
      "application_connection_id",
      "state",
      "enrollment_token_hash",
      "enrollment_expires_at",
      "enrollment_consumed_at",
      "connector_id",
      "connector_secret_hash",
      "protocol_version",
      "capabilities_json",
      "enrolled_at",
      "last_seen_at",
      "last_health_status",
      "last_health_at",
      "created_at",
      "updated_at",
    ]);

    database.exec("DROP INDEX receiver_read_jobs_queue_idx; DROP TABLE receiver_read_jobs; DROP INDEX receiver_connections_state_idx; DROP TABLE receiver_connections;");
    database.run("DELETE FROM schema_migrations WHERE version = 9");
    database.close();
    database = openDatabase(path.join(directory, "records.sqlite"));

    expect(database.get<{ state: string }>(
      "SELECT state FROM application_connections WHERE id = ?",
      [APP_CONNECTION_ID],
    )?.state).toBe("READY");
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM receiver_connections")?.count).toBe(0);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM receiver_read_jobs")?.count).toBe(0);
    expect(() => database.run(
      `INSERT INTO receiver_connections
        (id, application_connection_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["invalid-receiver", APP_CONNECTION_ID, "UNKNOWN", START.toISOString(), START.toISOString()],
    )).toThrow();
  });

  it("creates one waiting receiver connection and enforces ISSUE/REISSUE", () => {
    const first = issue();
    expect(first.receiverConnection).toMatchObject({
      applicationConnectionId: APP_CONNECTION_ID,
      state: RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
    });
    expect(first.token).toBe("enrollment-token-1");
    expect(first.enrollmentToken).toBe(first.token);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM receiver_connections")?.count).toBe(1);
    expect(() => issue()).toThrowError(expect.objectContaining({ code: "CONFLICT" }));

    const oldToken = first.token;
    const replacement = connections.reissue(APP_CONNECTION_ID);
    expect(replacement.token).not.toBe(oldToken);
    expect(() => enroll(oldToken)).toThrowError(expect.objectContaining({ code: "TOKEN_INVALID" }));
    expect(database.get<{ state: string }>("SELECT state FROM receiver_connections")?.state).toBe(RECEIVER_CONNECTION_WAITING_FOR_RECEIVER);
  });

  it("rejects an expired token and keeps raw enrollment material out of SQLite", () => {
    const invitation = issue();
    now = new Date(START.getTime() + 15 * 60 * 1000 + 1);
    expect(() => enroll(invitation.token)).toThrowError(expect.objectContaining({ code: "TOKEN_EXPIRED" }));
    const row = database.get<Record<string, unknown>>("SELECT * FROM receiver_connections");
    expect(JSON.stringify(row)).not.toContain(invitation.token);
    expect(row?.enrollment_token_hash).toEqual(expect.any(String));
  });

  it("enrolls exactly the supported capabilities and recovers a lost response", () => {
    const invitation = issue();
    const result = enroll(invitation.token);
    expect(result).toMatchObject({
      disposition: "ENROLLED",
      receiverConnection: {
        state: RECEIVER_CONNECTION_VERIFYING,
        connectorId: CONNECTOR_ID,
        protocolVersion: RECEIVER_CONNECTOR_PROTOCOL_VERSION,
        capabilities: [...RECEIVER_CAPABILITIES],
      },
    });
    expect(result.healthJobId).toEqual(expect.any(String));
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM receiver_read_jobs")?.count).toBe(1);
    const row = database.get<Record<string, unknown>>("SELECT * FROM receiver_connections");
    expect(JSON.stringify(row)).not.toContain(CONNECTOR_SECRET);
    expect(row?.connector_secret_hash).toEqual(expect.any(String));
    expect(row?.enrollment_consumed_at).toEqual(expect.any(String));

    const retry = enroll(invitation.token);
    expect(retry.disposition).toBe("ALREADY_ENROLLED");
    expect(retry.receiverConnection.id).toBe(result.receiverConnection.id);
    expect(retry.healthJobId).toBe(result.healthJobId);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM receiver_read_jobs")?.count).toBe(1);
    expect(() => enroll(invitation.token, "different-connector", CONNECTOR_SECRET)).toThrowError(
      expect.objectContaining({ code: "ENROLLMENT_REPLAY_MISMATCH" }),
    );
  });

  it("requires the exact capability list", () => {
    const invitation = issue();
    expect(() => connections.enroll({
      protocolVersion: RECEIVER_CONNECTOR_PROTOCOL_VERSION,
      enrollmentToken: invitation.token,
      connectorId: CONNECTOR_ID,
      connectorSecret: CONNECTOR_SECRET,
      capabilities: [RECEIVER_CAPABILITY_HEALTH, RECEIVER_CAPABILITY_BUSINESS_STATE],
    })).toThrow();
    expect(() => connections.enroll({
      protocolVersion: RECEIVER_CONNECTOR_PROTOCOL_VERSION,
      enrollmentToken: invitation.token,
      connectorId: CONNECTOR_ID,
      connectorSecret: CONNECTOR_SECRET,
      capabilities: [...RECEIVER_CAPABILITIES, "logs:v1"],
    })).toThrow();
  });

  it("authenticates only the enrolled connector and updates last_seen_at", () => {
    enroll(issue().token);
    expect(() => connections.authenticate({ connectorId: "wrong", connectorSecret: CONNECTOR_SECRET })).toThrowError(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
    expect(() => connections.authenticate({ connectorId: CONNECTOR_ID, connectorSecret: "wrong" })).toThrowError(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
    expect(database.get("SELECT last_seen_at FROM receiver_connections")?.last_seen_at).toBeNull();

    const auth = authenticated();
    expect(auth.receiverConnectionId).toBe(auth.receiverConnection.id);
    expect(auth.receiverConnection.lastSeenAt).toBe(START.toISOString());
    now = new Date(START.getTime() + 1000);
    const again = authenticated();
    expect(again.receiverConnection.lastSeenAt).toBe(now.toISOString());
  });

  it("creates typed jobs, fences lease generations, and accepts only the current completion", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createBusinessStateJob(enrollment.receiverConnection.id, "delivery-guid-1");
    expect(job).toMatchObject({
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      input: { deliveryGuid: "delivery-guid-1" },
      state: "QUEUED",
      leaseGeneration: 0,
    });
    expect(database.get<{ input_json: string }>("SELECT input_json FROM receiver_read_jobs WHERE id = ?", [job.id])?.input_json).toBe('{"deliveryGuid":"delivery-guid-1"}');
    expect(() => jobs.lease(job.id, {
      receiverConnectionId: enrollment.receiverConnection.id,
      connectorId: "wrong-connector",
      receiverConnection: enrollment.receiverConnection,
    })).toThrow();

    const firstLease = jobs.lease(job.id, auth);
    expect(firstLease).toMatchObject({ state: "LEASED", leaseGeneration: 1, leasedConnectorId: CONNECTOR_ID });
    now = new Date(START.getTime() + 16 * 1000);
    const secondLease = jobs.lease(job.id, auth);
    expect(secondLease.leaseGeneration).toBe(2);
    expect(() => jobs.complete(job.id, auth, 1, {
      schemaVersion: 1,
      deliveryGuid: "delivery-guid-1",
      mutationCount: 0,
      businessState: "ABSENT",
      observedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "STALE_LEASE" }));
    const completed = jobs.complete(job.id, auth, 2, {
      schemaVersion: 1,
      deliveryGuid: "delivery-guid-1",
      mutationCount: 0,
      businessState: "ABSENT",
      observedAt: now.toISOString(),
    });
    expect(completed).toMatchObject({ state: "SUCCEEDED", result: { mutationCount: 0, businessState: "ABSENT" } });
    expect(jobs.complete(job.id, auth, 2, completed.result)).toEqual(completed);
  });

  it("accepts only exact terminal replays and keeps ownership checks ahead of replay", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const result = {
      schemaVersion: 1 as const,
      deliveryGuid: "delivery-guid-1",
      mutationCount: 0,
      businessState: "ABSENT" as const,
      observedAt: START.toISOString(),
    };
    const job = jobs.createBusinessStateJob(
      enrollment.receiverConnection.id,
      result.deliveryGuid,
    );
    const lease = jobs.lease(job.id, auth);
    const completed = jobs.complete(job.id, auth, lease.leaseGeneration, result);
    const terminalRow = database.get<Record<string, unknown>>(
      "SELECT state, lease_generation, result_json, error_code, updated_at, completed_at FROM receiver_read_jobs WHERE id = ?",
      [job.id],
    );

    now = new Date(START.getTime() + 60 * 1000 + 1);
    expect(jobs.complete(job.id, auth, lease.leaseGeneration, result)).toEqual(completed);
    expect(database.get<Record<string, unknown>>(
      "SELECT state, lease_generation, result_json, error_code, updated_at, completed_at FROM receiver_read_jobs WHERE id = ?",
      [job.id],
    )).toEqual(terminalRow);

    expect(() => jobs.complete(job.id, auth, lease.leaseGeneration + 1, result)).toThrowError(
      expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }),
    );
    expect(() => jobs.fail(job.id, auth, lease.leaseGeneration, "CONNECTOR_ERROR"))
      .toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));
    expect(() => jobs.complete(job.id, auth, lease.leaseGeneration, {
      ...result,
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
    })).toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));

    const failedJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    const failedLease = jobs.lease(failedJob.id, auth);
    const failed = jobs.fail(
      failedJob.id,
      auth,
      failedLease.leaseGeneration,
      "CONNECTOR_ERROR",
    );
    expect(jobs.fail(
      failedJob.id,
      auth,
      failedLease.leaseGeneration,
      "CONNECTOR_ERROR",
    )).toEqual(failed);
    expect(() => jobs.fail(
      failedJob.id,
      auth,
      failedLease.leaseGeneration + 1,
      "CONNECTOR_ERROR",
    )).toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));
    expect(() => jobs.complete(failedJob.id, auth, failedLease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: START.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));
    expect(() => jobs.fail(
      failedJob.id,
      auth,
      failedLease.leaseGeneration,
      "OTHER_ERROR",
    )).toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));

    expect(() => jobs.complete(job.id, {
      receiverConnectionId: enrollment.receiverConnection.id,
      connectorId: "wrong-connector",
      receiverConnection: enrollment.receiverConnection,
    } as AuthenticatedReceiverConnector, lease.leaseGeneration, result)).toThrowError(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
  });

  it("recovers a lost completion response through exact HTTP replay", async () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.lease(
      jobs.createBusinessStateJob(
        enrollment.receiverConnection.id,
        "delivery-guid-1",
      ).id,
      auth,
    );
    const leasedJob = toReceiverLeasedJob(job) as unknown as CapabilityJob;
    const result = {
      schemaVersion: 1 as const,
      deliveryGuid: "delivery-guid-1",
      mutationCount: 1,
      businessState: "EXACTLY_ONE" as const,
      observedAt: START.toISOString(),
    };
    let completionCalls = 0;
    let firstTerminalRow: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body)) as {
        leaseGeneration: number;
        outcome: "SUCCEEDED" | "FAILED";
        result?: unknown;
        errorCode?: unknown;
      };
      const authenticatedConnector = connections.authenticate({
        connectorId: headers["X-Redrive-Connector-Id"],
        connectorSecret: headers.Authorization.slice("Bearer ".length),
      });
      const completed = body.outcome === "SUCCEEDED"
        ? jobs.complete(
            job.id,
            authenticatedConnector,
            body.leaseGeneration,
            body.result,
          )
        : jobs.fail(
            job.id,
            authenticatedConnector,
            body.leaseGeneration,
            body.errorCode,
          );
      completionCalls += 1;
      if (completionCalls === 1) {
        firstTerminalRow = database.get<Record<string, unknown>>(
          "SELECT state, lease_generation, result_json, error_code, updated_at, completed_at FROM receiver_read_jobs WHERE id = ?",
          [job.id],
        );
        throw new Error("completion response lost after central commit");
      }
      return new Response(JSON.stringify({ job: toReceiverCompletedJob(completed) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const httpTransport = new ConcreteRedriveHttpTransport({
      redriveUrl: "http://localhost",
      fetchImpl,
    });
    const transport: RedriveTransport = {
      enroll: async () => ({ connectorId: CONNECTOR_ID }),
      lease: async () => leasedJob,
      complete: (request) => httpTransport.complete(request),
      fail: (request) => httpTransport.fail(request),
    };
    const worker = new ReceiverConnectorWorker({
      config: {
        redriveUrl: "http://localhost",
        enrollmentToken: "enrollment-token",
        observerDatabaseUrl: "postgresql://observer.invalid/receiver",
        receiverHealthUrl: "http://receiver.invalid/health",
        connectorStateDir: directory,
      },
      transport,
      dispatcher: async () => result,
      identityGenerator: {
        connectorId: () => CONNECTOR_ID,
        connectorSecret: () => CONNECTOR_SECRET,
      },
      retryPolicy: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      kind: "COMPLETED",
      job: { jobId: leasedJob.jobId, leaseGeneration: leasedJob.leaseGeneration },
    });
    expect(completionCalls).toBe(2);
    expect(firstTerminalRow).toBeDefined();
    expect(database.get<Record<string, unknown>>(
      "SELECT state, lease_generation, result_json, error_code, updated_at, completed_at FROM receiver_read_jobs WHERE id = ?",
      [job.id],
    )).toEqual(firstTerminalRow);
  });

  it("requires an authenticated connector principal for every job mutation", () => {
    const enrollment = enroll(issue().token);
    const fakePrincipal = {
      receiverConnectionId: enrollment.receiverConnection.id,
      connectorId: CONNECTOR_ID,
      receiverConnection: enrollment.receiverConnection,
    } as AuthenticatedReceiverConnector;

    const leaseJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    expect(() => jobs.lease(leaseJob.id, fakePrincipal)).toThrowError(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
    expect(jobs.getById(leaseJob.id)?.state).toBe("QUEUED");

    const completeJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    const principal = authenticated();
    const lease = jobs.lease(completeJob.id, principal);
    expect(() => jobs.complete(completeJob.id, fakePrincipal, lease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "UNAUTHENTICATED" }));
    expect(jobs.getById(completeJob.id)?.state).toBe("LEASED");

    const failJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    const failLease = jobs.lease(failJob.id, principal);
    expect(() => jobs.fail(failJob.id, fakePrincipal, failLease.leaseGeneration, "CONNECTOR_ERROR"))
      .toThrowError(expect.objectContaining({ code: "UNAUTHENTICATED" }));
    expect(jobs.getById(failJob.id)?.state).toBe("LEASED");
  });

  it("scopes completion and failure lookup to the authenticated receiver", () => {
    addSecondApplicationConnection(database);
    const ownerEnrollment = enroll(issue().token);
    const otherEnrollment = connections.enroll({
      protocolVersion: RECEIVER_CONNECTOR_PROTOCOL_VERSION,
      enrollmentToken: connections.issue(SECOND_APP_CONNECTION_ID).token,
      connectorId: "connector-2",
      connectorSecret: "connector-secret-2",
      capabilities: [...RECEIVER_CAPABILITIES],
    });
    const owner = connections.authenticate(CONNECTOR_ID, CONNECTOR_SECRET);
    const other = connections.authenticate("connector-2", "connector-secret-2");
    const job = jobs.createHealthJob(ownerEnrollment.receiverConnection.id);
    const lease = jobs.lease(job.id, owner);
    const healthResult = {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: now.toISOString(),
    } as const;

    const completed = jobs.complete(
      job.id,
      owner,
      lease.leaseGeneration,
      healthResult,
    );
    expect(completed.state).toBe("SUCCEEDED");
    expect(jobs.complete(job.id, owner, lease.leaseGeneration, healthResult)).toEqual(completed);

    const missingJobId = "job-does-not-exist";
    expect(() => jobs.complete(job.id, other, lease.leaseGeneration, healthResult))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
    expect(() => jobs.complete(missingJobId, other, lease.leaseGeneration, healthResult))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
    expect(() => jobs.fail(job.id, other, lease.leaseGeneration, "CONNECTOR_ERROR"))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
    expect(() => jobs.fail(missingJobId, other, lease.leaseGeneration, "CONNECTOR_ERROR"))
      .toThrowError(expect.objectContaining({ code: "JOB_NOT_FOUND" }));
    expect(() => jobs.complete(missingJobId, {
      receiverConnectionId: otherEnrollment.receiverConnection.id,
      connectorId: "connector-2",
      receiverConnection: otherEnrollment.receiverConnection,
    } as AuthenticatedReceiverConnector, lease.leaseGeneration, healthResult))
      .toThrowError(expect.objectContaining({ code: "UNAUTHENTICATED" }));
    expect(otherEnrollment.receiverConnection.id).not.toBe(ownerEnrollment.receiverConnection.id);
  });

  it("validates all business result counts and delivery identity", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const completeWith = (mutationCount: number, businessState: string, deliveryGuid = "delivery-guid-1") => {
      const job = jobs.createBusinessStateJob(enrollment.receiverConnection.id, "delivery-guid-1");
      const lease = jobs.lease(job.id, auth);
      return () => jobs.complete(job.id, auth, lease.leaseGeneration, {
        schemaVersion: 1,
        deliveryGuid,
        mutationCount,
        businessState,
        observedAt: now.toISOString(),
      });
    };
    expect(completeWith(0, "ABSENT")()).toMatchObject({ state: "SUCCEEDED" });
    expect(completeWith(1, "EXACTLY_ONE")()).toMatchObject({ state: "SUCCEEDED" });
    expect(completeWith(2, "MULTIPLE")()).toMatchObject({ state: "SUCCEEDED" });
    expect(completeWith(0, "EXACTLY_ONE")).toThrow();
    expect(completeWith(1, "EXACTLY_ONE", "other-guid")).toThrow();
  });

  it("rejects completion after the durable deadline and fences the job as expired", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createBusinessStateJob(enrollment.receiverConnection.id, "deadline-guid");
    const lease = jobs.lease(job.id, auth);
    now = new Date(START.getTime() + 60 * 1000 + 1);

    expect(() => jobs.complete(job.id, auth, lease.leaseGeneration, {
      schemaVersion: 1,
      deliveryGuid: "deadline-guid",
      mutationCount: 0,
      businessState: "ABSENT",
      observedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "DEADLINE_EXPIRED" }));
    expect(jobs.getById(job.id)).toMatchObject({
      state: "EXPIRED",
      errorCode: "JOB_DEADLINE_EXPIRED",
      completedAt: now.toISOString(),
    });
  });

  it("expires queued work during normal polling and never leases it after the deadline", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createHealthJob(enrollment.receiverConnection.id);
    now = new Date(START.getTime() + 60 * 1000 + 1);

    expect(jobs.leaseNext(auth)).toBeNull();
    expect(jobs.getById(job.id)).toMatchObject({
      state: "EXPIRED",
      errorCode: "JOB_DEADLINE_EXPIRED",
      completedAt: now.toISOString(),
    });
    expect(() => jobs.lease(job.id, auth)).toThrowError(
      expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }),
    );
  });

  it("expires leased work during polling after its durable deadline", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createHealthJob(enrollment.receiverConnection.id);
    jobs.lease(job.id, auth);
    now = new Date(START.getTime() + 60 * 1000 + 1);

    expect(jobs.leaseNext(auth)).toBeNull();
    expect(jobs.getById(job.id)).toMatchObject({
      state: "EXPIRED",
      errorCode: "JOB_DEADLINE_EXPIRED",
      leasedConnectorId: null,
      leaseExpiresAt: null,
    });
  });

  it("expires before fencing stale late reports and rejects all terminal payloads", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createBusinessStateJob(enrollment.receiverConnection.id, "late-guid");
    const lateFailureJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    const firstLease = jobs.lease(job.id, auth);
    now = new Date(START.getTime() + 16 * 1000);
    const currentLease = jobs.lease(job.id, auth);
    now = new Date(START.getTime() + 60 * 1000 + 1);

    expect(() => jobs.complete(job.id, auth, firstLease.leaseGeneration, {
      schemaVersion: 1,
      deliveryGuid: "late-guid",
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      observedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "DEADLINE_EXPIRED" }));
    expect(jobs.getById(job.id)).toMatchObject({
      state: "EXPIRED",
      result: null,
      errorCode: "JOB_DEADLINE_EXPIRED",
    });
    expect(() => jobs.complete(job.id, auth, currentLease.leaseGeneration, {
      schemaVersion: 1,
      deliveryGuid: "late-guid",
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      observedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));
    expect(() => jobs.fail(job.id, auth, currentLease.leaseGeneration, "CONNECTOR_ERROR"))
      .toThrowError(expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }));
    expect(jobs.getById(job.id)?.state).toBe("EXPIRED");

    expect(() => jobs.fail(lateFailureJob.id, auth, 0, "CONNECTOR_ERROR"))
      .toThrowError(expect.objectContaining({ code: "DEADLINE_EXPIRED" }));
    expect(jobs.getById(lateFailureJob.id)).toMatchObject({
      state: "EXPIRED",
      result: null,
      errorCode: "JOB_DEADLINE_EXPIRED",
    });
  });

  it("supports a fenced terminal failure without storing an untyped error payload", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createHealthJob(enrollment.receiverConnection.id);
    const lease = jobs.lease(job.id, auth);

    const failed = jobs.fail(job.id, auth, lease.leaseGeneration, "CONNECTOR_ERROR");
    expect(failed).toMatchObject({
      state: "FAILED",
      errorCode: "CONNECTOR_ERROR",
      result: null,
    });
    expect(jobs.fail(job.id, auth, lease.leaseGeneration, "CONNECTOR_ERROR")).toEqual(failed);
    expect(() => jobs.fail(job.id, auth, lease.leaseGeneration, "OTHER_ERROR")).toThrowError(
      expect.objectContaining({ code: "JOB_ALREADY_COMPLETED" }),
    );
  });

  it("rejects malformed health results without changing the leased job or receiver", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createHealthJob(enrollment.receiverConnection.id);
    const lease = jobs.lease(job.id, auth);

    expect(() => jobs.complete(job.id, auth, lease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "BROKEN",
      observedAt: now.toISOString(),
    })).toThrow();
    expect(jobs.getById(job.id)?.state).toBe("LEASED");
    expect(connections.getById(enrollment.receiverConnection.id)?.state).toBe(RECEIVER_CONNECTION_VERIFYING);
  });

  it("transitions health state in the same transaction as job completion", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const initialHealth = jobs.getById(enrollment.healthJobId as string);
    expect(initialHealth?.capability).toBe(RECEIVER_CAPABILITY_HEALTH);
    const initialLease = jobs.lease(initialHealth?.id as string, auth);
    const healthy = jobs.complete(initialHealth?.id as string, auth, initialLease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: now.toISOString(),
    });
    expect(healthy.state).toBe("SUCCEEDED");
    expect(connections.getById(enrollment.receiverConnection.id)?.state).toBe(RECEIVER_CONNECTION_READY);

    const unhealthyJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    const unhealthyLease = jobs.lease(unhealthyJob.id, auth);
    jobs.complete(unhealthyJob.id, auth, unhealthyLease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "UNHEALTHY",
      observedAt: now.toISOString(),
    });
    expect(connections.getById(enrollment.receiverConnection.id)?.state).toBe(RECEIVER_CONNECTION_UNHEALTHY);

    const healthyAgainJob = jobs.createHealthJob(enrollment.receiverConnection.id);
    const healthyAgainLease = jobs.lease(healthyAgainJob.id, auth);
    jobs.complete(healthyAgainJob.id, auth, healthyAgainLease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: now.toISOString(),
    });
    expect(connections.getById(enrollment.receiverConnection.id)?.state).toBe(RECEIVER_CONNECTION_READY);
  });

  it("rolls back a health state failure together with the terminal job update", () => {
    const enrollment = enroll(issue().token);
    const auth = authenticated();
    const job = jobs.createHealthJob(enrollment.receiverConnection.id);
    const lease = jobs.lease(job.id, auth);
    database.run(
      "UPDATE receiver_connections SET state = ? WHERE id = ?",
      [RECEIVER_CONNECTION_WAITING_FOR_RECEIVER, enrollment.receiverConnection.id],
    );

    expect(() => jobs.complete(job.id, auth, lease.leaseGeneration, {
      schemaVersion: 1,
      healthStatus: "HEALTHY",
      observedAt: now.toISOString(),
    })).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(jobs.getById(job.id)?.state).toBe("LEASED");
    expect(connections.getById(enrollment.receiverConnection.id)?.state).toBe(RECEIVER_CONNECTION_WAITING_FOR_RECEIVER);
  });
});

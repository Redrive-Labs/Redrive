import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { REDRIVE_RECOVERY_SPEC_VERSION } from "@/agents/recovery-sandbox-agent";
import { RECOVERY_ATTEMPT_STATES } from "@/domain/recovery-attempt";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import {
  createProviderEvidenceService,
} from "@/server/provider-evidence-service";
import { createReceiverObservationService } from "@/server/receiver-observation-service";
import { createRecoveryAttemptRepository } from "@/server/recovery-attempt-repository";
import {
  createRecoverySandboxService,
  collectRecoveryTurn,
  RecoverySandboxAttemptStateError,
  RecoverySandboxPrerequisiteError,
  RecoverySandboxSessionError,
  RecoverySandboxTurnError,
} from "@/server/recovery-sandbox-service";
import { TrueForgeSessionNotFoundError } from "@/server/trueforge-client";

const connectionId = "connection-1";
const repositoryFullName = "Redrive-Labs/redrive-demo-receiver";
const revision = "5bfadf93d5233e4e6cfe0fdb19ad1b78328a5d79";
const deliveryId = "3839409944195514368";
const deliveryGuid = "acab6534-a25a-11f1-8324-8fdf05b88a6b";
const observedAt = "2026-08-30T00:00:00.000Z";
const environment = {
  NODE_ENV: "test",
  REDRIVE_TRUEFORGE_MODEL: "configured-model",
} satisfies NodeJS.ProcessEnv;

function iterable<T>(items: unknown[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item as T;
    },
  };
}

function lifecycle(turnId = "recovery-turn-1") {
  return iterable<TrueForgeApi.TurnStreamingEvent>([
    {
      type: "turn.created",
      id: `${turnId}-created-live`,
      turnId,
      state: { status: "running" },
    },
    {
      type: "turn.done",
      id: `${turnId}-done-live`,
      state: { status: "done" },
    },
  ]);
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "redrive.recovery.v1",
    result: "REPAIR_VERIFIED",
    sourceRepositoryFullName: repositoryFullName,
    originalRevision: revision,
    deliveryGuid,
    reproduction: { preCount: 0, httpStatus: 500, postCount: 1 },
    verification: { preCount: 1, httpStatus: 201, postCount: 1 },
    changedFiles: ["src/downstream.ts", "src/events.ts", "migrations/12.sql"],
    patch: "diff --git a/src/events.ts b/src/events.ts\n",
    validation: {
      testsPassed: true,
      typecheckPassed: true,
      buildPassed: true,
      diffCheckPassed: true,
    },
    notes: { postgresVersion: "PostgreSQL 15.19" },
    ...overrides,
  };
}

const expectedIdentity = {
  sourceRepositoryFullName: repositoryFullName,
  originalRevision: revision,
  deliveryGuid,
  providerStatusCode: 500,
  receiverMutationCount: 1,
};

function persistedEvents(
  result: unknown,
  turnId = "recovery-turn-1",
  options: { toolArguments?: string; toolResponse?: string; toolResponseIsError?: boolean } = {},
) {
  return iterable<TrueForgeApi.SessionEvent>([
    {
      type: "turn.created",
      id: `${turnId}-created`,
      turnId,
      state: { status: "running" },
    },
    {
      type: "model.message",
      id: `${turnId}-tool-message`,
      turnId,
      threadId: "main",
      content: null,
      toolCalls: [
        {
          id: `${turnId}-exec-call`,
          type: "function",
          function: {
            name: "exec",
            arguments:
              options.toolArguments ??
              JSON.stringify({ command: "cat /home/trueforge/evidence/artifact.json" }),
          },
          toolInfo: { type: "truefoundry-system", name: "exec" },
        },
        {
          id: `${turnId}-datetime-call`,
          type: "function",
          function: { name: "get_current_datetime", arguments: "{}" },
          toolInfo: { type: "truefoundry-system", name: "get_current_datetime" },
        },
      ],
    },
    {
      type: "sandbox.created",
      id: `${turnId}-sandbox-created`,
      turnId,
    },
    {
      type: "tool.response",
      id: `${turnId}-exec-response`,
      turnId,
      threadId: "main",
      toolCallId: `${turnId}-exec-call`,
      content: options.toolResponse ?? JSON.stringify(result),
      ...(options.toolResponseIsError === true ? { isError: true } : {}),
    },
    {
      type: "tool.response",
      id: `${turnId}-datetime-response`,
      turnId,
      threadId: "main",
      toolCallId: `${turnId}-datetime-call`,
      content: "2026-08-30T00:00:00.000Z",
    },
    {
      type: "model.message",
      id: `${turnId}-message`,
      turnId,
      threadId: "main",
      content: JSON.stringify(result),
      toolCalls: [],
    },
    {
      type: "turn.done",
      id: `${turnId}-done`,
      turnId,
      state: { status: "done" },
    },
  ]);
}

function githubResult(overrides: Record<string, unknown> = {}) {
  return {
    full: {
      http_status: 200,
      body: {
        id: deliveryId,
        guid: deliveryGuid,
        event: "push",
        status: "Invalid HTTP Response: 500",
        status_code: 500,
        delivered_at: observedAt,
        redelivery: false,
        repository_id: 1,
        request: {
          headers: {
            "X-GitHub-Delivery": deliveryGuid,
            "X-GitHub-Event": "push",
          },
          payload: {
            after: revision,
            repository: { id: 1, full_name: repositoryFullName },
          },
        },
        response: {
          headers: { "content-type": "text/plain" },
          payload: "receiver failed",
        },
        ...overrides,
      },
    },
  };
}

interface FixtureOptions {
  observationDeliveryGuid?: string;
}

function addConnection(database: SqliteDatabase): void {
  database.run(
    `INSERT INTO github_app_registrations
      (id, github_app_id, slug, owner_id, owner_login, owner_type,
       private_key_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["app-1", "app-id", "redrive", "owner-id", "octocat", "User", "key", observedAt, observedAt],
  );
  database.run(
    `INSERT INTO github_installations
      (installation_id, app_registration_id, account_id, account_login,
       account_type, repository_selection, last_verified_at, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["installation-1", "app-1", "owner-id", "octocat", "User", "selected", observedAt, observedAt, observedAt],
  );
  database.run(
    `INSERT INTO application_connections
      (id, provider, github_installation_id, repository_id,
       repository_full_name, webhook_id, webhook_target_display, state,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [connectionId, "github", "installation-1", repositoryFullName, repositoryFullName, "hook-1", "https://receiver.example/webhook", "READY", observedAt, observedAt],
  );
}

function createFixture(database: SqliteDatabase, options: FixtureOptions = {}) {
  addConnection(database);
  const incident = createIncidentService(database).create({
    provider: "github",
    externalDeliveryId: deliveryId,
    repositoryId: repositoryFullName,
  }).incident;
  database.run(
    "UPDATE incidents SET application_connection_id = ? WHERE id = ?",
    [connectionId, incident.id],
  );
  createProviderEvidenceService(database, () => observedAt).captureOrReconcileForIncident(
    incident.id,
    githubResult(),
  );
  database.run(
    `INSERT INTO trueforge_session_bindings
      (incident_id, state, trueforge_session_id, creation_token,
       coordinator_spec_version, created_at, updated_at)
     VALUES (?, 'ACTIVE', ?, NULL, 'm2.7-v1', ?, ?)`,
    [incident.id, "investigation-session", observedAt, observedAt],
  );
  const observationGuid = options.observationDeliveryGuid ?? deliveryGuid;
  createReceiverObservationService(database, () => observedAt).append({
    incidentId: incident.id,
    applicationConnectionId: connectionId,
    deliveryGuid: observationGuid,
    capability: "business_state:v1",
    tool: "get_business_state",
    mcpServerName: "redrive-receiver",
    result: {
      schemaVersion: 1,
      deliveryGuid: observationGuid,
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      observedAt,
    },
    trueForgeSessionId: "investigation-session",
    turnId: "receiver-turn-1",
    receiverInvestigatorThreadId: "receiver-thread-1",
    threadCreatedEventId: "receiver-thread-created",
    toolCallId: "receiver-call",
    toolCallEventId: "receiver-model",
    toolResponseEventId: "receiver-response",
    toolResponseCreatedAt: observedAt,
    createdAt: observedAt,
  });
  return incident;
}

function clientFor(result: unknown = artifact()) {
  return {
    createSession: vi.fn().mockResolvedValue("recovery-session-1"),
    getSession: vi.fn().mockResolvedValue({ id: "recovery-session-1" }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    createTurnStream: vi.fn().mockResolvedValue(lifecycle()),
    listTurnEvents: vi.fn().mockResolvedValue(persistedEvents(result)),
  };
}

describe("sandbox recovery orchestration", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-recovery-sandbox-"));
    database = openDatabase(path.join(directory, "incidents.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: false });
  });

  it("rejects MCP side effects and wrong-turn persisted events", async () => {
    const valid = artifact();
    const mcpEvents = persistedEvents(valid);
    const mcpEventList = [
      {
        type: "turn.created",
        id: "turn-created",
        turnId: "turn-1",
        state: { status: "running" },
      },
      {
        type: "model.message",
        id: "model-message",
        turnId: "turn-1",
        threadId: "main",
        content: null,
        toolCalls: [
          {
            id: "mcp-call",
            type: "function",
            function: { name: "get_webhook_delivery", arguments: "{}" },
            toolInfo: { type: "mcp", name: "get_webhook_delivery" },
          },
        ],
      },
      {
        type: "turn.done",
        id: "turn-done",
        turnId: "turn-1",
        state: { status: "done" },
      },
    ];
    await expect(
      collectRecoveryTurn(
        iterable(mcpEventList),
        "session-1",
        "turn-1",
        {
          sourceRepositoryFullName: repositoryFullName,
          originalRevision: revision,
          deliveryGuid,
          providerStatusCode: 500,
          receiverMutationCount: 1,
        },
      ),
    ).rejects.toBeInstanceOf(RecoverySandboxTurnError);
    await expect(
      collectRecoveryTurn(
        mcpEvents,
        "session-1",
        "different-turn",
        {
          sourceRepositoryFullName: repositoryFullName,
          originalRevision: revision,
          deliveryGuid,
          providerStatusCode: 500,
          receiverMutationCount: 1,
        },
      ),
    ).rejects.toBeInstanceOf(RecoverySandboxTurnError);
  });

  it("requires the exact successful sandbox artifact read and binds the final JSON to it", async () => {
    const valid = artifact();

    await expect(
      collectRecoveryTurn(
        persistedEvents(valid, "unrelated-exec", {
          toolArguments: JSON.stringify({ command: "cat /tmp/unrelated.json" }),
        }),
        "session-1",
        "unrelated-exec",
        expectedIdentity,
      ),
    ).rejects.toBeInstanceOf(RecoverySandboxTurnError);

    await expect(
      collectRecoveryTurn(
        persistedEvents(valid, "failed-read", {
          toolResponse: JSON.stringify({ exitCode: 1, stdout: "", stderr: "missing" }),
        }),
        "session-1",
        "failed-read",
        expectedIdentity,
      ),
    ).rejects.toBeInstanceOf(RecoverySandboxTurnError);

    await expect(
      collectRecoveryTurn(
        persistedEvents(valid, "wrong-path", {
          toolArguments: JSON.stringify({ path: "/tmp/artifact.json" }),
        }),
        "session-1",
        "wrong-path",
        expectedIdentity,
      ),
    ).rejects.toBeInstanceOf(RecoverySandboxTurnError);

    await expect(
      collectRecoveryTurn(
        persistedEvents({ ...valid, patch: "fabricated patch\n" }, "different-final", {
          toolResponse: JSON.stringify(valid),
        }),
        "session-1",
        "different-final",
        expectedIdentity,
      ),
    ).rejects.toBeInstanceOf(RecoverySandboxTurnError);

    await expect(
      collectRecoveryTurn(
        persistedEvents(valid, "exact-binding"),
        "session-1",
        "exact-binding",
        expectedIdentity,
      ),
    ).resolves.toMatchObject({ artifact: valid });
  });

  it("creates one durable recovery attempt and persists the host-computed SHA-256", async () => {
    const incident = createFixture(database);
    const client = clientFor();
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    const result = await service.startOrResumeSandboxRecovery(incident.id);
    const expectedHash = createHash("sha256")
      .update(result.artifact.patch, "utf8")
      .digest("hex");

    expect(result.attempt).toMatchObject({
      incidentId: incident.id,
      state: "REPAIR_VERIFIED",
      trueForgeSessionId: "recovery-session-1",
      trueForgeTurnId: "recovery-turn-1",
      sourceRepositoryFullName: repositoryFullName,
      originalRevision: revision,
      deliveryGuid,
      reproductionPreCount: 0,
      reproductionHttpStatus: 500,
      reproductionPostCount: 1,
      verificationPreCount: 1,
      verificationHttpStatus: 201,
      verificationPostCount: 1,
      patchSha256: expectedHash,
    });
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.getSession).not.toHaveBeenCalled();
    expect(client.updateSession).toHaveBeenCalledOnce();
    expect(client.createTurnStream).toHaveBeenCalledWith(
      "recovery-session-1",
      { input: expect.arrayContaining([expect.objectContaining({ type: "user.message" })]) },
    );
    const turnInput = client.createTurnStream.mock.calls[0][1].input[0].content as string;
    expect(turnInput).toContain(`"repositoryFullName":"${repositoryFullName}"`);
    expect(turnInput).toContain(`"originalRevision":"${revision}"`);
    expect(
      database.get<{ state: string; patch_sha256: string }>(
        "SELECT state, patch_sha256 FROM recovery_attempts WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ state: "REPAIR_VERIFIED", patch_sha256: expectedHash });
  });

  it("returns an existing verified artifact without another TrueForge turn", async () => {
    const incident = createFixture(database);
    const client = clientFor();
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    const first = await service.startOrResumeSandboxRecovery(incident.id);
    const second = await service.startOrResumeSandboxRecovery(incident.id);

    expect(second).toEqual(first);
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.createTurnStream).toHaveBeenCalledOnce();
    expect(client.getSession).not.toHaveBeenCalled();
  });

  it("fences a reservation race so only one creator can POST a session", async () => {
    const incident = createFixture(database);
    let resolveCreate!: (sessionId: string) => void;
    const client1 = clientFor();
    client1.createSession.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const client2 = clientFor();
    const service1 = createRecoverySandboxService(database, client1, environment, () => observedAt);
    const contenderDatabase = openDatabase(path.join(directory, "incidents.sqlite"));
    try {
      const service2 = createRecoverySandboxService(contenderDatabase, client2, environment, () => observedAt);
      const first = service1.startOrResumeSandboxRecovery(incident.id);
      await Promise.resolve();
      await expect(service2.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
        RecoverySandboxAttemptStateError,
      );
      resolveCreate("recovery-session-1");
      await first;
      expect(client1.createSession).toHaveBeenCalledOnce();
      expect(client2.createSession).not.toHaveBeenCalled();
    } finally {
      contenderDatabase.close();
    }
  });

  it("fences an ambiguous session create and never blindly retries it", async () => {
    const incident = createFixture(database);
    const client = clientFor();
    client.createSession.mockRejectedValueOnce(new Error("request timed out"));
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    await expect(service.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
      RecoverySandboxSessionError,
    );
    expect(
      database.get<{ state: string }>(
        "SELECT state FROM recovery_attempts WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ state: "SESSION_UNCERTAIN" });
    await expect(service.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
      RecoverySandboxAttemptStateError,
    );
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.createTurnStream).not.toHaveBeenCalled();
  });

  it("reuses a READY recovery session and reapplies the current AgentSpec", async () => {
    const incident = createFixture(database);
    const repository = createRecoveryAttemptRepository(database);
    const reservation = repository.reserveCreation({
      id: "attempt-ready",
      incidentId: incident.id,
      creationToken: "creation-token",
      recoverySpecVersion: REDRIVE_RECOVERY_SPEC_VERSION,
      sourceRepositoryFullName: repositoryFullName,
      originalRevision: revision,
      providerStatusCode: 500,
      receiverPreCount: 1,
      deliveryGuid,
      createdAt: observedAt,
    });
    repository.activate(incident.id, reservation.creationToken as string, "existing-session", observedAt);
    const client = clientFor();
    client.getSession.mockResolvedValue({ id: "existing-session" });
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    await service.startOrResumeSandboxRecovery(incident.id);

    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.getSession).toHaveBeenCalledWith("existing-session");
    expect(client.updateSession).toHaveBeenCalledWith(
      "existing-session",
      expect.objectContaining({ mcpServers: [] }),
    );
    expect(client.createTurnStream).toHaveBeenCalledWith(
      "existing-session",
      expect.anything(),
    );
  });

  it("marks a remote 404 SESSION_LOST without replacing the session identity", async () => {
    const incident = createFixture(database);
    const repository = createRecoveryAttemptRepository(database);
    const reservation = repository.reserveCreation({
      id: "attempt-lost",
      incidentId: incident.id,
      creationToken: "creation-token",
      recoverySpecVersion: REDRIVE_RECOVERY_SPEC_VERSION,
      sourceRepositoryFullName: repositoryFullName,
      originalRevision: revision,
      providerStatusCode: 500,
      receiverPreCount: 1,
      deliveryGuid,
      createdAt: observedAt,
    });
    repository.activate(incident.id, reservation.creationToken as string, "lost-session", observedAt);
    const client = clientFor();
    client.getSession.mockRejectedValueOnce(new TrueForgeSessionNotFoundError("lost-session"));
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    await expect(service.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
      RecoverySandboxSessionError,
    );
    expect(
      database.get<{ state: string; trueforge_session_id: string }>(
        "SELECT state, trueforge_session_id FROM recovery_attempts WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ state: "SESSION_LOST", trueforge_session_id: "lost-session" });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("fails a malformed result and leaves the failed attempt fenced", async () => {
    const incident = createFixture(database);
    const client = clientFor({ ...artifact(), reproduction: { preCount: 1, httpStatus: 500, postCount: 1 } });
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    await expect(service.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
      RecoverySandboxTurnError,
    );
    expect(
      database.get<{ state: string; failure_code: string }>(
        "SELECT state, failure_code FROM recovery_attempts WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ state: "FAILED", failure_code: "INVALID_TURN_ARTIFACT" });
    await expect(service.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
      RecoverySandboxAttemptStateError,
    );
    expect(client.createTurnStream).toHaveBeenCalledOnce();
  });

  it("rejects a receiver observation that does not correlate to the provider GUID", async () => {
    const incident = createFixture(database, { observationDeliveryGuid: "wrong-guid" });
    const client = clientFor();
    const service = createRecoverySandboxService(database, client, environment, () => observedAt);

    await expect(service.startOrResumeSandboxRecovery(incident.id)).rejects.toBeInstanceOf(
      RecoverySandboxPrerequisiteError,
    );
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("exposes only the intended recovery attempt states in migration 12", () => {
    expect(
      database.all<{ state: string }>(
        "SELECT name AS state FROM pragma_table_info('recovery_attempts') WHERE name = 'state'",
      ),
    ).toHaveLength(1);
    expect(RECOVERY_ATTEMPT_STATES).toEqual([
      "SESSION_CREATING",
      "SESSION_UNCERTAIN",
      "READY",
      "RUNNING",
      "REPAIR_VERIFIED",
      "FAILED",
      "SESSION_LOST",
    ]);
  });
});

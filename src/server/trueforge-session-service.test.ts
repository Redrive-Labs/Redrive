import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConnectionRecoveryCoordinatorAgentSpec,
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
  RecoveryCoordinatorConfigurationError,
} from "@/agents/recovery-coordinator";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import { createTrueForgeSessionBindingRepository } from "@/server/trueforge-session-binding-repository";
import {
  createTrueForgeSessionService,
  TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
  TrueForgeIncidentNotFoundError,
  TrueForgeSessionSpecUpgradeError,
  TrueForgeUnsupportedCoordinatorSpecError,
} from "@/server/trueforge-session-service";
import {
  TrueForgeSessionCreateError,
  TrueForgeSessionNotFoundError,
  type TrueForgeIncidentClient,
  type TrueForgeSessionClient,
} from "@/server/trueforge-client";

function createFakeClient() {
  return {
    createSession: vi.fn<TrueForgeSessionClient["createSession"]>(),
    getSession: vi.fn<TrueForgeSessionClient["getSession"]>(),
    updateSession: vi.fn<TrueForgeIncidentClient["updateSession"]>(),
  };
}

describe("TrueForge incident session spine", () => {
  let testDirectory: string;
  let databasePath: string;
  let database: SqliteDatabase;
  const configuredModel = "openrouter/free-model";
  const configuredConnectionMcpName = "redrive-github";
  const makeConnectionEnvironment = () => ({
    ...process.env,
    REDRIVE_TRUEFORGE_MODEL: configuredModel,
    REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: configuredConnectionMcpName,
    REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "test-connection-mcp-token",
  });
  let originalModel: string | undefined;
  let originalMcpName: string | undefined;
  let originalConnectionMcpName: string | undefined;
  let originalConnectionMcpToken: string | undefined;

  beforeEach(() => {
    originalModel = process.env.REDRIVE_TRUEFORGE_MODEL;
    originalConnectionMcpName = process.env.REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME;
    originalConnectionMcpToken = process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;
    process.env.REDRIVE_TRUEFORGE_MODEL = configuredModel;
    process.env.REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME = configuredConnectionMcpName;
    process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN = "test-connection-mcp-token";
    testDirectory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-trueforge-session-"),
    );
    databasePath = path.join(testDirectory, "incidents.sqlite");
    database = openDatabase(databasePath);
  });

  afterEach(() => {
    database.close();

    if (originalModel === undefined) {
      delete process.env.REDRIVE_TRUEFORGE_MODEL;
    } else {
      process.env.REDRIVE_TRUEFORGE_MODEL = originalModel;
    }
    if (originalConnectionMcpName === undefined) {
      delete process.env.REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME;
    } else {
      process.env.REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME = originalConnectionMcpName;
    }
    if (originalConnectionMcpToken === undefined) {
      delete process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;
    } else {
      process.env.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN = originalConnectionMcpToken;
    }

    const resolvedDirectory = path.resolve(testDirectory);
    if (
      path.dirname(resolvedDirectory) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedDirectory).startsWith("redrive-trueforge-session-")
    ) {
      throw new Error("Refusing to remove a non-test directory.");
    }
    rmSync(resolvedDirectory, { recursive: true, force: false });
  });

  function createIncident() {
    return createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: `delivery-${crypto.randomUUID()}`,
      repositoryId: "example/receiver",
    }).incident;
  }

  function makeConnectionBacked(incidentId: string): string {
    const connectionId = `connection-${incidentId}`;
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`app-${incidentId}`, "app-id", "redrive", "owner-id", "octocat", "User", "key", "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT INTO github_installations
        (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`installation-${incidentId}`, `app-${incidentId}`, "owner-id", "octocat", "User", "selected", "2026-01-01", "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT INTO application_connections
        (id, provider, github_installation_id, repository_id,
         repository_full_name, webhook_id, webhook_target_display, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [connectionId, "github", `installation-${incidentId}`, "repository-id", "octocat/receiver", "hook-id", "https://receiver.example/webhook", "READY", "2026-01-01", "2026-01-01"],
    );
    database.run(
      "UPDATE incidents SET application_connection_id = ? WHERE id = ?",
      [connectionId, incidentId],
    );
    return connectionId;
  }

  function insertActiveBinding(incidentId: string, version: string): void {
    database.run(
      `
        INSERT INTO trueforge_session_bindings (
          incident_id,
          state,
          trueforge_session_id,
          creation_token,
          coordinator_spec_version,
          created_at,
          updated_at
        ) VALUES (?, 'ACTIVE', ?, NULL, ?, ?, ?)
      `,
      [
        incidentId,
        "existing-session",
        version,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );
  }

  function insertCreatingBinding(
    incidentId: string,
    creationToken: string,
    createdAt: string,
  ): void {
    database.run(
      `
        INSERT INTO trueforge_session_bindings (
          incident_id,
          state,
          trueforge_session_id,
          creation_token,
          coordinator_spec_version,
          created_at,
          updated_at
        ) VALUES (?, 'CREATING', NULL, ?, ?, ?, ?)
      `,
      [
        incidentId,
        creationToken,
        CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
        createdAt,
        createdAt,
      ],
    );
  }

  it("keeps a fresh CREATING reservation in progress for concurrent callers", async () => {
    const incident = createIncident();
    insertCreatingBinding(
      incident.id,
      "fresh-creation-token",
      "2026-01-01T00:00:00.000Z",
    );
    const client1 = createFakeClient();
    const client2 = createFakeClient();
    const contenderDatabase = openDatabase(databasePath);
    try {
      const service1 = createTrueForgeSessionService(
        database,
        client1,
        () => "2026-01-01T00:00:30.000Z",
      );
      const service2 = createTrueForgeSessionService(
        contenderDatabase,
        client2,
        () => "2026-01-01T00:00:30.000Z",
      );

      const results = await Promise.all([
        service1.ensureTrueForgeSession(incident.id),
        service2.ensureTrueForgeSession(incident.id),
      ]);

      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outcome: "IN_PROGRESS",
            state: "CREATING",
            retryable: true,
          }),
        ]),
      );
      expect(results.every((result) => result.outcome === "IN_PROGRESS")).toBe(
        true,
      );
      expect(client1.createSession).not.toHaveBeenCalled();
      expect(client2.createSession).not.toHaveBeenCalled();
    } finally {
      contenderDatabase.close();
    }
  });

  it("marks a stale CREATING reservation uncertain after restart without creating remotely", async () => {
    const incident = createIncident();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const observedAt = new Date(
      Date.parse(createdAt) + TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
    ).toISOString();
    insertCreatingBinding(incident.id, "stale-creation-token", createdAt);
    const client = createFakeClient();
    database.close();
    database = openDatabase(databasePath);

    const restartedService = createTrueForgeSessionService(
      database,
      client,
      () => observedAt,
    );
    const result = await restartedService.ensureTrueForgeSession(incident.id);

    expect(result).toMatchObject({
      outcome: "CREATION_UNCERTAIN",
      state: "CREATION_UNCERTAIN",
      retryable: false,
      sessionId: null,
    });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(restartedService.getBindingByIncidentId(incident.id)).toMatchObject({
      state: "CREATION_UNCERTAIN",
      creationToken: "stale-creation-token",
      trueForgeSessionId: null,
    });

    const recreatedService = createTrueForgeSessionService(
      database,
      client,
      () => observedAt,
    );
    const blocked = await recreatedService.ensureTrueForgeSession(incident.id);
    expect(blocked.outcome).toBe("CREATION_UNCERTAIN");
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("lets the original owner activate a late result after stale recovery", async () => {
    const incident = createIncident();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const observedAt = new Date(
      Date.parse(createdAt) + TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
    ).toISOString();
    const ownerClient = createFakeClient();
    const staleRecoveryClient = createFakeClient();
    const contenderDatabase = openDatabase(databasePath);
    const staleService = createTrueForgeSessionService(
      contenderDatabase,
      staleRecoveryClient,
      () => observedAt,
    );
    let staleRecovery!: ReturnType<typeof staleService.ensureTrueForgeSession>;
    ownerClient.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          // Resolve the remote create first. Starting stale recovery in the
          // same turn pauses local activation until the reservation is fenced.
          resolve("late-session");
          staleRecovery = staleService.ensureTrueForgeSession(incident.id);
        }),
    );
    const ownerService = createTrueForgeSessionService(
      database,
      ownerClient,
      vi.fn().mockReturnValueOnce(createdAt).mockReturnValue(observedAt),
    );

    try {
      const ownerResult = await ownerService.ensureTrueForgeSession(incident.id);
      const staleResult = await staleRecovery;

      expect(staleResult).toMatchObject({
        outcome: "CREATION_UNCERTAIN",
        state: "CREATION_UNCERTAIN",
        sessionId: null,
      });
      expect(ownerResult).toMatchObject({
        outcome: "CREATED",
        state: "ACTIVE",
        sessionId: "late-session",
      });
      expect(ownerResult.binding.creationToken).toBeNull();
      expect(staleRecoveryClient.createSession).not.toHaveBeenCalled();
      expect(ownerClient.createSession).toHaveBeenCalledTimes(1);
      expect(ownerService.getBindingByIncidentId(incident.id)).toMatchObject({
        state: "ACTIVE",
        trueForgeSessionId: "late-session",
        creationToken: null,
      });
    } finally {
      contenderDatabase.close();
    }
  });

  it("rejects a differently-owned late activation without replacing the token", async () => {
    const incident = createIncident();
    const creationToken = "stale-fencing-token";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const observedAt = new Date(
      Date.parse(createdAt) + TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
    ).toISOString();
    insertCreatingBinding(incident.id, creationToken, createdAt);
    const client = createFakeClient();
    const service = createTrueForgeSessionService(
      database,
      client,
      () => observedAt,
    );

    await service.ensureTrueForgeSession(incident.id);
    const repository = createTrueForgeSessionBindingRepository(database);

    expect(
      repository.activate(
        incident.id,
        "wrong-fencing-token",
        "should-not-activate",
        observedAt,
      ),
    ).toBeNull();
    expect(service.getBindingByIncidentId(incident.id)).toMatchObject({
      state: "CREATION_UNCERTAIN",
      creationToken,
      trueForgeSessionId: null,
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("releases a stale uncertain reservation after the original owner is definitively rejected", async () => {
    const incident = createIncident();
    const createdAt = "2026-01-01T00:00:00.000Z";
    const observedAt = new Date(
      Date.parse(createdAt) + TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
    ).toISOString();
    const ownerClient = createFakeClient();
    const staleRecoveryClient = createFakeClient();
    const contenderDatabase = openDatabase(databasePath);
    const staleService = createTrueForgeSessionService(
      contenderDatabase,
      staleRecoveryClient,
      () => observedAt,
    );
    let staleRecovery!: ReturnType<typeof staleService.ensureTrueForgeSession>;
    ownerClient.createSession
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            // The definitive rejection arrives after stale recovery fences the
            // original owner, so cleanup must release CREATION_UNCERTAIN.
            reject(
              new TrueForgeSessionCreateError(
                "DEFINITIVE",
                "invalid agent specification",
              ),
            );
            staleRecovery = staleService.ensureTrueForgeSession(incident.id);
          }),
      )
      .mockResolvedValueOnce("replacement-session");
    const ownerService = createTrueForgeSessionService(
      database,
      ownerClient,
      vi.fn().mockReturnValueOnce(createdAt).mockReturnValue("2026-01-01T00:02:00.000Z"),
    );

    try {
      const ownerEnsure = ownerService.ensureTrueForgeSession(incident.id);
      await expect(ownerEnsure).rejects.toThrow("invalid agent specification");
      await expect(staleRecovery).resolves.toMatchObject({
        outcome: "CREATION_UNCERTAIN",
        state: "CREATION_UNCERTAIN",
        sessionId: null,
      });

      expect(ownerService.getBindingByIncidentId(incident.id)).toBeNull();
      const retry = await ownerService.ensureTrueForgeSession(incident.id);
      expect(retry).toMatchObject({
        outcome: "CREATED",
        state: "ACTIVE",
        sessionId: "replacement-session",
      });
      expect(staleRecoveryClient.createSession).not.toHaveBeenCalled();
      expect(ownerClient.createSession).toHaveBeenCalledTimes(2);
    } finally {
      contenderDatabase.close();
    }
  });

  it("does not release a stale uncertain reservation for a wrong token", async () => {
    const incident = createIncident();
    const creationToken = "stale-release-token";
    const createdAt = "2026-01-01T00:00:00.000Z";
    const observedAt = new Date(
      Date.parse(createdAt) + TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
    ).toISOString();
    insertCreatingBinding(incident.id, creationToken, createdAt);
    const client = createFakeClient();
    const service = createTrueForgeSessionService(
      database,
      client,
      () => observedAt,
    );

    await service.ensureTrueForgeSession(incident.id);
    const repository = createTrueForgeSessionBindingRepository(database);

    expect(
      repository.releaseCreation(incident.id, "wrong-release-token"),
    ).toBe(false);
    expect(service.getBindingByIncidentId(incident.id)).toMatchObject({
      state: "CREATION_UNCERTAIN",
      creationToken,
      trueForgeSessionId: null,
    });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("classifies activation that wins stale recovery instead of overwriting it", async () => {
    const incident = createIncident();
    const creationToken = "activation-race-token";
    insertCreatingBinding(
      incident.id,
      creationToken,
      "2026-01-01T00:00:00.000Z",
    );
    const client = createFakeClient();
    client.getSession.mockResolvedValue({ id: "activated-session" });
    const contenderDatabase = openDatabase(databasePath);
    const contenderRepository = createTrueForgeSessionBindingRepository(
      contenderDatabase,
    );
    let activated = false;
    try {
      const service = createTrueForgeSessionService(
        database,
        client,
        () => {
          if (!activated) {
            activated = true;
            expect(
              contenderRepository.activate(
                incident.id,
                creationToken,
                "activated-session",
                "2026-01-01T00:01:00.000Z",
              ),
            ).not.toBeNull();
          }
          return "2026-01-01T00:01:00.000Z";
        },
      );

      const result = await service.ensureTrueForgeSession(incident.id);

      expect(result).toMatchObject({
        outcome: "REUSED",
        state: "ACTIVE",
        sessionId: "activated-session",
      });
      expect(client.createSession).not.toHaveBeenCalled();
      expect(contenderRepository.getByIncidentId(incident.id)?.state).toBe(
        "ACTIVE",
      );
    } finally {
      contenderDatabase.close();
    }
  });

  it("preserves the no-replacement invariant after stale recovery", async () => {
    const incident = createIncident();
    insertCreatingBinding(
      incident.id,
      "stale-no-replacement-token",
      "2026-01-01T00:00:00.000Z",
    );
    const client = createFakeClient();
    const service = createTrueForgeSessionService(
      database,
      client,
      () => "2026-01-01T00:02:00.000Z",
    );

    const first = await service.ensureTrueForgeSession(incident.id);
    const second = await service.ensureTrueForgeSession(incident.id);

    expect(first.outcome).toBe("CREATION_UNCERTAIN");
    expect(second.outcome).toBe("CREATION_UNCERTAIN");
    expect(client.createSession).not.toHaveBeenCalled();
    expect(service.getBindingByIncidentId(incident.id)).toMatchObject({
      state: "CREATION_UNCERTAIN",
      creationToken: "stale-no-replacement-token",
    });
  });

  it("creates the schema and stores one inline versioned Coordinator binding", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession.mockResolvedValue("tf-session-1");
    const service = createTrueForgeSessionService(
      database,
      client,
      () => "2026-01-01T00:00:00.000Z",
    );

    const result = await service.ensureTrueForgeSession(incident.id);

    expect(result).toMatchObject({
      outcome: "CREATED",
      state: "ACTIVE",
      sessionId: "tf-session-1",
      retryable: false,
    });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.createSession).toHaveBeenCalledWith(
      getConnectionRecoveryCoordinatorAgentSpec(makeConnectionEnvironment()),
    );
    expect(result.binding).toMatchObject({
      incidentId: incident.id,
      trueForgeSessionId: "tf-session-1",
      coordinatorSpecVersion: CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      database.get<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = 4",
      ),
    ).toEqual({ version: 4 });
  });

  it("fails before remote creation when the model/resource name is missing or blank", async () => {
    const incident = createIncident();
    const client = createFakeClient();

    for (const model of [undefined, "", "   "]) {
      const environment = { ...process.env };
      if (model === undefined) {
        delete environment.REDRIVE_TRUEFORGE_MODEL;
      } else {
        environment.REDRIVE_TRUEFORGE_MODEL = model;
      }

      const service = createTrueForgeSessionService(
        database,
        client,
        undefined,
        environment,
      );

      await expect(service.ensureTrueForgeSession(incident.id)).rejects.toBeInstanceOf(
        RecoveryCoordinatorConfigurationError,
      );
    }

    expect(client.createSession).not.toHaveBeenCalled();
    expect(
      createTrueForgeSessionService(database, client).getBindingByIncidentId(
        incident.id,
      ),
    ).toBeNull();
  });

  it("reuses the persisted remote session after a database/service restart", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession.mockResolvedValue("tf-session-restart");
    client.getSession.mockResolvedValue({ id: "tf-session-restart" });
    const firstService = createTrueForgeSessionService(database, client);

    await firstService.ensureTrueForgeSession(incident.id);
    database.close();
    database = openDatabase(databasePath);

    const restartedService = createTrueForgeSessionService(database, client);
    const result = await restartedService.ensureTrueForgeSession(incident.id);

    expect(result.outcome).toBe("REUSED");
    expect(result.state).toBe("ACTIVE");
    expect(result.sessionId).toBe("tf-session-restart");
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.getSession).toHaveBeenCalledWith("tf-session-restart");
  });

  it("allows only the persisted reservation owner to call remote create across connections", async () => {
    const incident = createIncident();
    const client1 = createFakeClient();
    const client2 = createFakeClient();
    const contenderDatabase = openDatabase(databasePath);
    let releaseCreate!: (sessionId: string) => void;
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const remoteCreate = new Promise<string>((resolve) => {
      releaseCreate = resolve;
    });
    client1.createSession.mockImplementation(async () => {
      markCreateStarted();
      return remoteCreate;
    });
    client2.createSession.mockResolvedValue("should-not-be-created");

    let first: ReturnType<
      ReturnType<typeof createTrueForgeSessionService>["ensureTrueForgeSession"]
    > | undefined;
    try {
      const service1 = createTrueForgeSessionService(database, client1);
      const service2 = createTrueForgeSessionService(
        contenderDatabase,
        client2,
      );
      first = service1.ensureTrueForgeSession(incident.id);
      const second = service2.ensureTrueForgeSession(incident.id);

      await createStarted;
      const secondResult = await second;
      expect(secondResult).toMatchObject({
        outcome: "IN_PROGRESS",
        state: "CREATING",
        retryable: true,
      });
      expect(client2.createSession).not.toHaveBeenCalled();

      releaseCreate("tf-session-race-safe");
      const firstResult = await first;
      expect(firstResult.outcome).toBe("CREATED");
      expect(client1.createSession).toHaveBeenCalledTimes(1);
      expect(
        contenderDatabase.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM trueforge_session_bindings",
        ),
      ).toEqual({ count: 1 });
    } finally {
      releaseCreate?.("tf-session-race-safe");
      if (first !== undefined) {
        await first.catch(() => undefined);
      }
      contenderDatabase.close();
    }
  });

  it("blocks retries after an ambiguous remote create failure", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession.mockRejectedValue(new Error("request timed out"));
    const service = createTrueForgeSessionService(database, client);

    const first = await service.ensureTrueForgeSession(incident.id);
    const second = await service.ensureTrueForgeSession(incident.id);

    expect(first).toMatchObject({
      outcome: "CREATION_UNCERTAIN",
      state: "CREATION_UNCERTAIN",
      retryable: false,
      sessionId: null,
    });
    expect(second).toMatchObject({
      outcome: "CREATION_UNCERTAIN",
      state: "CREATION_UNCERTAIN",
      retryable: false,
    });
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });

  it("blocks replacement after an unknown SDK status such as 499", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession.mockRejectedValue(
      new TrueForgeSessionCreateError(
        "AMBIGUOUS",
        "client closed the request",
        { statusCode: 499 },
      ),
    );
    const service = createTrueForgeSessionService(database, client);

    const first = await service.ensureTrueForgeSession(incident.id);
    const second = await service.ensureTrueForgeSession(incident.id);

    expect(first).toMatchObject({
      outcome: "CREATION_UNCERTAIN",
      state: "CREATION_UNCERTAIN",
      sessionId: null,
    });
    expect(second).toMatchObject({
      outcome: "CREATION_UNCERTAIN",
      state: "CREATION_UNCERTAIN",
      retryable: false,
    });
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });

  it("permits a safe retry only after a definitive create rejection", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession
      .mockRejectedValueOnce(
        new TrueForgeSessionCreateError("DEFINITIVE", "invalid agent spec"),
      )
      .mockResolvedValueOnce("tf-session-after-rejection");
    const service = createTrueForgeSessionService(database, client);

    await expect(service.ensureTrueForgeSession(incident.id)).rejects.toThrow(
      "invalid agent spec",
    );
    expect(service.getBindingByIncidentId(incident.id)).toBeNull();

    const retry = await service.ensureTrueForgeSession(incident.id);
    expect(retry.outcome).toBe("CREATED");
    expect(retry.sessionId).toBe("tf-session-after-rejection");
    expect(client.createSession).toHaveBeenCalledTimes(2);
  });

  it("marks a remote 404 as LOST and never silently creates a replacement", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession.mockResolvedValue("tf-session-lost");
    client.getSession.mockRejectedValue(
      new TrueForgeSessionNotFoundError("tf-session-lost"),
    );
    const service = createTrueForgeSessionService(database, client);

    await service.ensureTrueForgeSession(incident.id);
    const lost = await service.ensureTrueForgeSession(incident.id);
    const stillLost = await service.ensureTrueForgeSession(incident.id);

    expect(lost).toMatchObject({
      outcome: "LOST",
      state: "LOST",
      sessionId: "tf-session-lost",
      retryable: false,
    });
    expect(stillLost.outcome).toBe("LOST");
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  it("keeps ACTIVE state on a transient session lookup failure", async () => {
    const incident = createIncident();
    const client = createFakeClient();
    client.createSession.mockResolvedValue("tf-session-transient");
    client.getSession.mockRejectedValue(new Error("TrueForge unavailable"));
    const service = createTrueForgeSessionService(database, client);

    await service.ensureTrueForgeSession(incident.id);
    const result = await service.ensureTrueForgeSession(incident.id);

    expect(result).toMatchObject({
      outcome: "TRANSIENT_LOOKUP_FAILURE",
      state: "ACTIVE",
      sessionId: "tf-session-transient",
      retryable: true,
    });
    expect(service.getBindingByIncidentId(incident.id)?.state).toBe("ACTIVE");
  });

  it("creates a connection-backed session with the m2.6b spec", async () => {
    const incident = createIncident();
    makeConnectionBacked(incident.id);
    const client = createFakeClient();
    client.createSession.mockResolvedValue("connection-session");
    const connectionEnvironment = makeConnectionEnvironment();

    const service = createTrueForgeSessionService(
      database,
      client,
      undefined,
      connectionEnvironment,
    );

    const result = await service.ensureTrueForgeSession(incident.id);

    expect(result).toMatchObject({
      state: "ACTIVE",
      sessionId: "connection-session",
      outcome: "CREATED",
      binding: { coordinatorSpecVersion: CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION },
    });
    expect(client.createSession).toHaveBeenCalledWith(
      getConnectionRecoveryCoordinatorAgentSpec(connectionEnvironment)
    );
  });

  it("never silently downgrades an unsupported newer Coordinator version", async () => {
    const incident = createIncident();
    insertActiveBinding(incident.id, "m2.5-v9");
    const client = createFakeClient();
    client.getSession.mockResolvedValue({ id: "existing-session" });
    const service = createTrueForgeSessionService(database, client);

    await expect(service.ensureCoordinatorForIncident(incident.id)).rejects.toBeInstanceOf(
      TrueForgeUnsupportedCoordinatorSpecError,
    );
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.updateSession).not.toHaveBeenCalled();
  });

  it("does not contact TrueForge for an unknown incident", async () => {
    const client = createFakeClient();
    const service = createTrueForgeSessionService(database, client);

    await expect(
      service.ensureTrueForgeSession("missing-incident"),
    ).rejects.toBeInstanceOf(TrueForgeIncidentNotFoundError);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.getSession).not.toHaveBeenCalled();
  });
});

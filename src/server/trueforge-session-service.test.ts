import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecoveryCoordinatorAgentSpec,
  RECOVERY_COORDINATOR_SPEC_VERSION,
  RecoveryCoordinatorConfigurationError,
} from "@/agents/recovery-coordinator";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import {
  createTrueForgeSessionService,
  TrueForgeIncidentNotFoundError,
} from "@/server/trueforge-session-service";
import {
  TrueForgeSessionCreateError,
  TrueForgeSessionNotFoundError,
  type TrueForgeSessionClient,
} from "@/server/trueforge-client";

function createFakeClient() {
  return {
    createSession: vi.fn<TrueForgeSessionClient["createSession"]>(),
    getSession: vi.fn<TrueForgeSessionClient["getSession"]>(),
  };
}

describe("TrueForge incident session spine", () => {
  let testDirectory: string;
  let databasePath: string;
  let database: SqliteDatabase;
  const configuredModel = "openrouter/free-model";
  let originalModel: string | undefined;

  beforeEach(() => {
    originalModel = process.env.REDRIVE_TRUEFORGE_MODEL;
    process.env.REDRIVE_TRUEFORGE_MODEL = configuredModel;
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
      getRecoveryCoordinatorAgentSpec({
        ...process.env,
        REDRIVE_TRUEFORGE_MODEL: configuredModel,
      }),
    );
    expect(result.binding).toMatchObject({
      incidentId: incident.id,
      trueForgeSessionId: "tf-session-1",
      coordinatorSpecVersion: RECOVERY_COORDINATOR_SPEC_VERSION,
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

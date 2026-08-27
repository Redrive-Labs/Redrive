import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IncidentValidationError,
  type Incident,
} from "@/domain/incident";
import {
  openDatabase,
  type SqliteDatabase,
} from "@/server/database";
import {
  createIncidentService,
  INCIDENT_LIST_LIMIT,
} from "@/server/incident-service";

describe("incident persistence", () => {
  let testDirectory: string;
  let databasePath: string;
  let database: SqliteDatabase;
  let service: ReturnType<typeof createIncidentService>;

  beforeEach(async () => {
    testDirectory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-control-plane-"),
    );
    databasePath = path.join(testDirectory, "incidents.sqlite");
    database = await openDatabase(databasePath);
    service = createIncidentService(database);
  });

  afterEach(() => {
    database.close();

    const resolvedDirectory = path.resolve(testDirectory);
    const temporaryRoot = path.resolve(os.tmpdir());
    const isIsolatedTestDirectory =
      path.dirname(resolvedDirectory) === temporaryRoot &&
      path.basename(resolvedDirectory).startsWith("redrive-control-plane-");

    if (!isIsolatedTestDirectory) {
      throw new Error("Refusing to remove a non-test directory.");
    }

    rmSync(resolvedDirectory, { recursive: true, force: false });
  });

  it("persists a newly created incident", () => {
    const incident = service.create({
      provider: "development",
      externalDeliveryId: "delivery-001",
      repositoryId: "example/receiver",
    }).incident;

    expect(incident).toMatchObject({
      provider: "development",
      externalDeliveryId: "delivery-001",
      repositoryId: "example/receiver",
      status: "OPEN",
    });
    expect(incident.id).toEqual(expect.any(String));
    expect(incident.createdAt).toBe(incident.updatedAt);
    expect(service.list()).toContainEqual(incident);
  });

  it("converges sequential duplicate creation on the existing incident", () => {
    const input = {
      provider: "github",
      externalDeliveryId: "delivery-duplicate",
      repositoryId: "example/receiver",
    };

    const first = service.create(input);
    const duplicate = service.create(input);

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({
      incident: first.incident,
      created: false,
    });
    expect(service.list()).toHaveLength(1);
  });

  it("allows the same delivery id for a different provider or repository", () => {
    const externalDeliveryId = "delivery-shared-id";
    const first = service.create({
      provider: "github",
      externalDeliveryId,
      repositoryId: "example/receiver",
    });
    const second = service.create({
      provider: "gitlab",
      externalDeliveryId,
      repositoryId: "example/receiver",
    });
    const third = service.create({
      provider: "github",
      externalDeliveryId,
      repositoryId: "other/receiver",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(third.created).toBe(true);
    expect(new Set([
      first.incident.id,
      second.incident.id,
      third.incident.id,
    ]).size).toBe(3);
    expect(service.list()).toHaveLength(3);
  });

  it("retrieves the stored values by incident id", () => {
    const created = service.create({
      provider: "local",
      externalDeliveryId: "retrieval-check",
      repositoryId: "sample/consumer",
    }).incident;

    expect(service.getById(created.id)).toEqual(created);
    expect(service.getById("missing-incident")).toBeNull();
  });

  it("round-trips opaque external identifiers without numeric conversion", () => {
    const externalDeliveryId = "000000000000000000000000000042";

    const created = service.create({
      provider: "opaque-provider",
      externalDeliveryId,
      repositoryId: "sample/consumer",
    }).incident;

    expect(service.getById(created.id)?.externalDeliveryId).toBe(
      externalDeliveryId,
    );
  });

  it("round-trips the required giant external delivery identifier exactly", () => {
    const externalDeliveryId = "900719925474099312345678901234567890";

    const created = service.create({
      provider: "github",
      externalDeliveryId,
      repositoryId: "Redrive-Labs/redrive-demo-receiver",
    }).incident;

    expect(service.getById(created.id)?.externalDeliveryId).toBe(
      externalDeliveryId,
    );
  });

  it("rejects clearly invalid creation input", () => {
    expect(() =>
      service.create({
        provider: "development",
        externalDeliveryId: 42,
        repositoryId: "sample/consumer",
      }),
    ).toThrow(IncidentValidationError);

    expect(() =>
      service.create({
        provider: " ",
        externalDeliveryId: "delivery-002",
        repositoryId: "sample/consumer",
      }),
    ).toThrow(IncidentValidationError);
  });

  it("bounds incident lists while retaining newest-first ordering", () => {
    const totalIncidents = INCIDENT_LIST_LIMIT + 5;

    for (let index = 0; index < totalIncidents; index += 1) {
      const createdAt = new Date(
        Date.UTC(2025, 0, 1, 0, 0, index),
      ).toISOString();

      database.run(
        `
          INSERT INTO incidents (
            id,
            provider,
            external_delivery_id,
            repository_id,
            status,
            created_at,
            updated_at
          ) VALUES (
            @id,
            @provider,
            @externalDeliveryId,
            @repositoryId,
            @status,
            @createdAt,
            @updatedAt
          )
        `,
        {
          id: `incident-${index.toString().padStart(3, "0")}`,
          provider: "test",
          externalDeliveryId: `delivery-${index}`,
          repositoryId: "test/receiver",
          status: "OPEN",
          createdAt,
          updatedAt: createdAt,
        },
      );
    }

    const incidents = service.list();

    expect(incidents).toHaveLength(INCIDENT_LIST_LIMIT);
    expect(incidents.map((incident) => incident.externalDeliveryId)).toEqual(
      Array.from(
        { length: INCIDENT_LIST_LIMIT },
        (_, index) => `delivery-${totalIncidents - index - 1}`,
      ),
    );
  });

  it("keeps the incident after a new database connection and service are created", async () => {
    const created = service.create({
      provider: "development",
      externalDeliveryId: "survives-reconnect",
      repositoryId: "sample/consumer",
    }).incident;

    database.close();
    database = await openDatabase(databasePath);
    service = createIncidentService(database);

    const reloaded: Incident | null = service.getById(created.id);
    expect(reloaded).toEqual(created);
  });
});

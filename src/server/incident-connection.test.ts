import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IncidentValidationError } from "@/domain/incident";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";

describe("connection-backed incident persistence boundary", () => {
  const resources: Array<{ directory: string; database: SqliteDatabase }> = [];

  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-incident-connection-test-"),
    );
    const database = openDatabase(path.join(directory, "records.sqlite"));
    const resource = { directory, database };
    resources.push(resource);
    return resource;
  }

  it("does not expose connection-backed persistence through the legacy service", () => {
    const { database } = fixture();
    const service = createIncidentService(database);

    expect(() =>
      service.create({
        applicationConnectionId: "connection-1",
        deliveryId: "delivery-1",
      }),
    ).toThrow(IncidentValidationError);
    expect(
      database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
    ).toBe(0);
  });

  it("rejects connection fields even when a legacy form-shaped payload is otherwise complete", () => {
    const { database } = fixture();
    const service = createIncidentService(database);

    expect(() =>
      service.create({
        provider: "github",
        externalDeliveryId: "delivery-1",
        repositoryId: "octocat/receiver",
        applicationConnectionId: "connection-1",
        deliveryId: "delivery-1",
      }),
    ).toThrow(IncidentValidationError);
    expect(
      database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
    ).toBe(0);
  });

  it("keeps the historical incident operation unchanged", () => {
    const { database } = fixture();
    const service = createIncidentService(database);
    const input = {
      provider: "github",
      externalDeliveryId: "delivery-1",
      repositoryId: "octocat/receiver",
    };

    const first = service.create(input);
    const duplicate = service.create(input);

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ incident: first.incident, created: false });
    expect(first.incident.applicationConnectionId).toBeUndefined();
  });
});

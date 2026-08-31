import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeConfiguredDatabase, openDatabase } from "@/server/infrastructure/database";
import { POST } from "./route";

describe("legacy incident route", () => {
  let directory: string;
  let databasePath: string;
  const originalDatabasePath = process.env.REDRIVE_DATABASE_PATH;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-legacy-incident-route-test-"),
    );
    databasePath = path.join(directory, "records.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
    openDatabase(databasePath).close();
  });

  afterEach(() => {
    closeConfiguredDatabase(databasePath);
    if (originalDatabasePath === undefined) {
      delete process.env.REDRIVE_DATABASE_PATH;
    } else {
      process.env.REDRIVE_DATABASE_PATH = originalDatabasePath;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  async function postJson(body: unknown): Promise<Response> {
    return POST(
      new Request("http://redrive.example/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("rejects connection-shaped JSON without creating an incident", async () => {
    const response = await postJson({
      applicationConnectionId: "connection-1",
      deliveryId: "delivery-1",
    });

    expect(response.status).toBe(400);
    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects connection fields in a complete legacy form payload", async () => {
    const response = await POST(
      new Request("http://redrive.example/api/incidents", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          provider: "github",
          externalDeliveryId: "delivery-1",
          repositoryId: "octocat/receiver",
          applicationConnectionId: "connection-1",
          deliveryId: "delivery-1",
        }),
      }),
    );

    expect(response.status).toBe(400);
    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("keeps legacy creation and duplicate idempotency", async () => {
    const body = {
      provider: "github",
      externalDeliveryId: "delivery-1",
      repositoryId: "octocat/receiver",
    };
    const first = await postJson(body);
    const duplicate = await postJson(body);

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual(await first.json());
  });
});

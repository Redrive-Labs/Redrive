import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/database";
import { POST } from "./route";

describe("incident route", () => {
  let testDirectory: string;
  let databasePath: string;
  const originalDatabasePath = process.env.REDRIVE_DATABASE_PATH;

  beforeEach(() => {
    testDirectory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-route-test-"),
    );
    databasePath = path.join(testDirectory, "incidents.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
  });

  afterEach(() => {
    if (originalDatabasePath === undefined) {
      delete process.env.REDRIVE_DATABASE_PATH;
    } else {
      process.env.REDRIVE_DATABASE_PATH = originalDatabasePath;
    }

    const resolvedDirectory = path.resolve(testDirectory);
    const temporaryRoot = path.resolve(os.tmpdir());
    const isIsolatedTestDirectory =
      path.dirname(resolvedDirectory) === temporaryRoot &&
      path.basename(resolvedDirectory).startsWith("redrive-route-test-");

    if (!isIsolatedTestDirectory) {
      throw new Error("Refusing to remove a non-test directory.");
    }

    rmSync(resolvedDirectory, { recursive: true, force: false });
  });

  it("persists a native browser form submission and redirects to the homepage", async () => {
    const externalDeliveryId = "900719925474099312345678901234567890";
    const form = new URLSearchParams({
      provider: "github",
      externalDeliveryId,
      repositoryId: "Redrive-Labs/redrive-demo-receiver",
    });

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/");

    const database = await openDatabase(databasePath);
    try {
      const result = database.exec(
        "SELECT provider, external_delivery_id, repository_id, status FROM incidents",
      );

      expect(result[0]?.values).toEqual([
        [
          "github",
          externalDeliveryId,
          "Redrive-Labs/redrive-demo-receiver",
          "OPEN",
        ],
      ]);
    } finally {
      database.close();
    }
  });

  it("returns a 400 for invalid form input without creating a row", async () => {
    const form = new URLSearchParams({
      provider: "github",
      externalDeliveryId: "",
      repositoryId: "Redrive-Labs/redrive-demo-receiver",
    });

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(400);

    const database = await openDatabase(databasePath);
    try {
      const result = database.exec(
        "SELECT COUNT(*) AS count FROM incidents",
      );

      expect(result[0]?.values).toEqual([[0]]);
    } finally {
      database.close();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import { GithubDeliveryNormalizationError } from "@/server/github-provider-evidence";
import { createProviderEvidenceService } from "@/server/provider-evidence-service";

const deliveryId = "900719925474099312345678901234567890";

function makeMcpResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: deliveryId,
    guid: "guid-001",
    event: "push",
    status: "Invalid HTTP Response: 500",
    status_code: 500,
    delivered_at: "2026-08-25T09:56:40.78Z",
    redelivery: false,
    repository_id: 1345932290,
    request: {
      headers: {
        "X-Github-Delivery": "guid-001",
        "X-Github-Event": "push",
      },
      payload: {
        ref: "refs/heads/main",
        repository: { id: 1345932290, full_name: "example/receiver" },
      },
    },
    response: {
      headers: { "content-type": "text/plain" },
      payload: "receiver failed",
    },
    ...overrides,
  };

  return {
    id: deliveryId,
    guid: "guid-001",
    event: "push",
    status_code: 500,
    delivered_at: "2026-08-25T09:56:40.78Z",
    redelivery: false,
    full: { http_status: 200, body },
  };
}

describe("provider evidence persistence", () => {
  let testDirectory: string;
  let databasePath: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    testDirectory = mkdtempSync(path.join(os.tmpdir(), "redrive-provider-evidence-"));
    databasePath = path.join(testDirectory, "incidents.sqlite");
    database = openDatabase(databasePath);
  });

  afterEach(() => {
    database.close();
    const resolvedDirectory = path.resolve(testDirectory);
    if (
      path.dirname(resolvedDirectory) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolvedDirectory).startsWith("redrive-provider-evidence-")
    ) {
      throw new Error("Refusing to remove a non-test directory.");
    }
    rmSync(resolvedDirectory, { recursive: true, force: false });
  });

  function createIncident() {
    return createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    }).incident;
  }

  it("returns captured incident IDs without loading evidence snapshots", () => {
    const incidents = createIncidentService(database);
    const first = incidents.create({ provider: "github", externalDeliveryId: "projection-delivery-1", repositoryId: "example/receiver" }).incident;
    const second = incidents.create({ provider: "github", externalDeliveryId: "projection-delivery-2", repositoryId: "example/receiver" }).incident;
    database.run(
      `INSERT INTO provider_evidence (
        incident_id, schema_version, provider, provider_delivery_id,
        delivery_guid, outcome_status, status_code, delivered_at,
        canonical_payload_sha256, evidence_json, captured_at
      ) VALUES (?, 1, 'github', ?, ?, 'Delivered', 200, ?, ?, ?, ?)`,
      [first.id, "projection-provider-delivery", "projection-guid", "2026-08-25T09:56:40.78Z", "projection-hash", '{"large":"not loaded"}', "2026-08-25T10:00:00.000Z"],
    );

    const service = createProviderEvidenceService(database);
    expect(service.getCapturedIncidentIds([first.id, second.id])).toEqual(new Set([first.id]));
  });

  it("normalizes, persists, and reloads one evidence snapshot", () => {
    const service = createProviderEvidenceService(database, () => "2026-08-25T10:00:00.000Z");
    const incident = createIncident();
    const result = service.captureOrReconcileForIncident(incident.id, makeMcpResult());

    expect(result.disposition).toBe("CAPTURED");
    expect(result.evidence).toMatchObject({
      provider: "github",
      repositoryId: "example/receiver",
      providerDeliveryId: deliveryId,
      deliveryGuid: "guid-001",
      event: "push",
      outcome: { statusCode: 500 },
      response: { body: "receiver failed" },
    });

    database.close();
    database = openDatabase(databasePath);
    expect(createProviderEvidenceService(database).getByIncidentId(incident.id)).toEqual(result.evidence);
  });

  it("keeps unexpected MCP fields out of normalized persisted evidence", () => {
    const service = createProviderEvidenceService(database, () => "2026-08-25T10:00:00.000Z");
    const incident = createIncident();
    service.captureOrReconcileForIncident(incident.id, {
      ...makeMcpResult({ unexpected: "root" }),
      unexpectedRoot: "ignored",
    });
    const row = database.get<{ evidence_json: string }>("SELECT evidence_json FROM provider_evidence WHERE incident_id = ?", [incident.id]);
    expect(row?.evidence_json).not.toContain("unexpectedRoot");
    expect(row?.evidence_json).not.toContain('"unexpected"');
    expect(row?.evidence_json).not.toContain('"full"');
  });

  it("persists no evidence when a required provider field is malformed", () => {
    const service = createProviderEvidenceService(database);
    const incident = createIncident();
    expect(() => service.captureOrReconcileForIncident(incident.id, makeMcpResult({ status_code: "500" }))).toThrow(GithubDeliveryNormalizationError);
    expect(service.getByIncidentId(incident.id)).toBeNull();
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM provider_evidence")?.count).toBe(0);
  });

  it("rejects a mismatched delivery ID before persisting", () => {
    const service = createProviderEvidenceService(database);
    const incident = createIncident();
    expect(() => service.captureOrReconcileForIncident(incident.id, makeMcpResult({ id: "different-delivery" }))).toThrow("does not match the incident delivery ID");
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM provider_evidence")?.count).toBe(0);
  });

  it("persists nothing when GUID and X-GitHub-Delivery contradict", () => {
    const service = createProviderEvidenceService(database);
    const incident = createIncident();
    expect(() => service.captureOrReconcileForIncident(incident.id, makeMcpResult({ guid: "different-guid" }))).toThrow("does not match the delivery GUID");
    expect(service.getByIncidentId(incident.id)).toBeNull();
  });

  it("rejects indexed columns that disagree with normalized evidence JSON", () => {
    const service = createProviderEvidenceService(database);
    const incident = createIncident();
    service.captureOrReconcileForIncident(incident.id, makeMcpResult());
    database.run("UPDATE provider_evidence SET delivery_guid = ? WHERE incident_id = ?", ["tampered-guid", incident.id]);
    expect(() => service.getByIncidentId(incident.id)).toThrow("does not match its normalized JSON");
  });
});

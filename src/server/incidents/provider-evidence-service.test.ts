import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { createIncidentService } from "@/server/incidents/incident-service";
import {
  GithubDeliveryNormalizationError,
  normalizeGithubWebhookDelivery,
} from "@/server/github/github-provider-evidence";
import { createProviderEvidenceService } from "@/server/incidents/provider-evidence-service";

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

function rewindToM26bSchema(database: SqliteDatabase): void {
  database.exec(`
    DROP TABLE receiver_observations;
    DROP INDEX provider_evidence_application_connection_idx;
    DROP INDEX provider_evidence_delivery_idx;
    ALTER TABLE provider_evidence RENAME TO provider_evidence_m27b_legacy;

    CREATE TABLE provider_evidence (
      incident_id TEXT PRIMARY KEY NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      provider TEXT NOT NULL CHECK (provider = 'github'),
      provider_delivery_id TEXT NOT NULL,
      delivery_guid TEXT NOT NULL,
      outcome_status TEXT NOT NULL,
      status_code INTEGER,
      delivered_at TEXT NOT NULL,
      canonical_payload_sha256 TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE
    );

    CREATE INDEX provider_evidence_delivery_idx
      ON provider_evidence (provider_delivery_id);

    INSERT INTO provider_evidence (
      incident_id,
      schema_version,
      provider,
      provider_delivery_id,
      delivery_guid,
      outcome_status,
      status_code,
      delivered_at,
      canonical_payload_sha256,
      evidence_json,
      captured_at
    )
    SELECT
      incident_id,
      schema_version,
      provider,
      provider_delivery_id,
      delivery_guid,
      outcome_status,
      status_code,
      delivered_at,
      canonical_payload_sha256,
      evidence_json,
      captured_at
    FROM provider_evidence_m27b_legacy;

    DROP TABLE provider_evidence_m27b_legacy;
    DELETE FROM schema_migrations WHERE version IN (10, 11);
  `);
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

  it("backfills M2.6B provider provenance and converges an identical M2.7 reobservation", () => {
    const applicationConnectionId = "connection-m27b-provenance";
    const now = "2026-08-30T00:00:00.000Z";
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["app-m27b-provenance", "app-id-m27b-provenance", "redrive", "owner-id", "octocat", "User", "key-m27b-provenance", now, now],
    );
    database.run(
      `INSERT INTO github_installations
       (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["installation-m27b-provenance", "app-m27b-provenance", "owner-id", "octocat", "User", "selected", now, now, now],
    );
    database.run(
      `INSERT INTO application_connections
        (id, provider, github_installation_id, repository_id,
         repository_full_name, webhook_id, webhook_target_display, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [applicationConnectionId, "github", "installation-m27b-provenance", "example/receiver", "example/receiver", "webhook-m27b-provenance", "https://receiver.example/webhook", "READY", now, now],
    );

    const incident = createIncident();
    database.run(
      "UPDATE incidents SET application_connection_id = ? WHERE id = ?",
      [applicationConnectionId, incident.id],
    );
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token,
         coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, ?, ?, ?)`,
      [incident.id, "m2.6b-session", "m2.6b-v1", now, now],
    );

    const preM27Evidence = normalizeGithubWebhookDelivery(
      makeMcpResult(),
      { repositoryId: "example/receiver", deliveryId },
      "2026-08-30T00:01:00.000Z",
    );
    const preM27EvidenceJson = JSON.stringify(preM27Evidence);
    database.run(
      `INSERT INTO provider_evidence (
        incident_id,
        application_connection_id,
        schema_version,
        provider,
        provider_delivery_id,
        delivery_guid,
        outcome_status,
        status_code,
        delivered_at,
        canonical_payload_sha256,
        evidence_json,
        captured_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incident.id,
        preM27Evidence.schemaVersion,
        preM27Evidence.provider,
        preM27Evidence.providerDeliveryId,
        preM27Evidence.deliveryGuid,
        preM27Evidence.outcome.status,
        preM27Evidence.outcome.statusCode,
        preM27Evidence.deliveredAt,
        preM27Evidence.request.canonicalPayloadSha256,
        preM27EvidenceJson,
        preM27Evidence.capturedAt,
      ],
    );

    const sessionBeforeMigration = database.get(
      "SELECT * FROM trueforge_session_bindings WHERE incident_id = ?",
      [incident.id],
    );

    rewindToM26bSchema(database);
    expect(
      database.all<{ name: string }>(
        "PRAGMA table_info('provider_evidence')",
      ).map(({ name }) => name),
    ).not.toContain("application_connection_id");
    database.close();
    database = openDatabase(databasePath);

    expect(
      database.get<{ application_connection_id: string | null }>(
        "SELECT application_connection_id FROM provider_evidence WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ application_connection_id: applicationConnectionId });
    expect(
      database.get<{ evidence_json: string }>(
        "SELECT evidence_json FROM provider_evidence WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ evidence_json: preM27EvidenceJson });
    expect(
      database.get(
        "SELECT * FROM trueforge_session_bindings WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual(sessionBeforeMigration);

    const service = createProviderEvidenceService(
      database,
      () => "2026-08-30T00:02:00.000Z",
    );
    const migratedEvidence = service.getByIncidentId(incident.id);
    expect(migratedEvidence).toEqual({
      ...preM27Evidence,
      incidentId: incident.id,
      applicationConnectionId,
    });

    expect(
      service.captureOrReconcileForIncident(incident.id, makeMcpResult()),
    ).toEqual({
      evidence: migratedEvidence,
      disposition: "REOBSERVED",
    });
    expect(
      database.get<{ evidence_json: string }>(
        "SELECT evidence_json FROM provider_evidence WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ evidence_json: preM27EvidenceJson });
  });
});

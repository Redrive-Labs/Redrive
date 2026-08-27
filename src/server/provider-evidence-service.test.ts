import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GithubDeliveryNormalizationError,
} from "@/server/github-provider-evidence";
import type {
  GithubWebhookDeliveryLookup,
  GithubWebhookDeliveryReader,
} from "@/server/github-mcp";
import { GithubMcpTimeoutError } from "@/server/github-mcp";
import {
  openDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import {
  createProviderEvidenceService,
  ProviderEvidenceReadError,
} from "@/server/provider-evidence-service";

const deliveryId = "900719925474099312345678901234567890";
const lookup: GithubWebhookDeliveryLookup = {
  repositoryId: "example/receiver",
  deliveryId,
};

function makeMcpResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
        repository: {
          id: 1345932290,
          full_name: "example/receiver",
        },
      },
    },
    response: {
      headers: {
        "content-type": "text/plain",
      },
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
    full: {
      http_status: 200,
      body,
    },
  };
}

function createReader(
  result: unknown,
  onLookup?: (received: GithubWebhookDeliveryLookup) => void,
): GithubWebhookDeliveryReader {
  return {
    async getWebhookDelivery(received) {
      onLookup?.(received);
      return result;
    },
  };
}

describe("provider evidence persistence", () => {
  let testDirectory: string;
  let databasePath: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    testDirectory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-provider-evidence-"),
    );
    databasePath = path.join(testDirectory, "incidents.sqlite");
    database = openDatabase(databasePath);
  });

  afterEach(() => {
    database.close();

    const resolvedDirectory = path.resolve(testDirectory);
    const temporaryRoot = path.resolve(os.tmpdir());
    const isIsolatedTestDirectory =
      path.dirname(resolvedDirectory) === temporaryRoot &&
      path.basename(resolvedDirectory).startsWith("redrive-provider-evidence-");

    if (!isIsolatedTestDirectory) {
      throw new Error("Refusing to remove a non-test directory.");
    }

    rmSync(resolvedDirectory, { recursive: true, force: false });
  });


  it("returns captured incident IDs without loading evidence snapshots", () => {
    const incidents = createIncidentService(database);
    const first = incidents.create({
      provider: "github",
      externalDeliveryId: "projection-delivery-1",
      repositoryId: "example/receiver",
    }).incident;
    const second = incidents.create({
      provider: "github",
      externalDeliveryId: "projection-delivery-2",
      repositoryId: "example/receiver",
    }).incident;

    database.run(
      `
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
        ) VALUES (?, 1, 'github', ?, ?, 'Delivered', 200, ?, ?, ?, ?)
      `,
      [
        first.id,
        "projection-provider-delivery",
        "projection-guid",
        "2026-08-25T09:56:40.78Z",
        "projection-hash",
        '{"large":"not loaded"}',
        "2026-08-25T10:00:00.000Z",
      ],
    );

    const service = createProviderEvidenceService(
      database,
      createReader(null),
    );

    expect(service.getCapturedIncidentIds([first.id, second.id])).toEqual(
      new Set([first.id]),
    );
  });

  it("normalizes, persists, and reloads one evidence snapshot", async () => {
    let receivedLookup: GithubWebhookDeliveryLookup | undefined;
    const incidentService = createProviderEvidenceService(
      database,
      createReader(makeMcpResult(), (received) => {
        receivedLookup = received;
      }),
      () => "2026-08-25T10:00:00.000Z",
    );
    const incidents = createIncidentService(database);
    const { incident } = incidents.create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    const evidence = await incidentService.inspectForIncident(incident.id);

    expect(receivedLookup).toEqual(lookup);
    expect(evidence).toMatchObject({
      provider: "github",
      repositoryId: lookup.repositoryId,
      providerDeliveryId: deliveryId,
      deliveryGuid: "guid-001",
      event: "push",
      outcome: {
        statusCode: 500,
      },
      response: {
        body: "receiver failed",
      },
    });
    expect(incidentService.getByIncidentId(incident.id)).toEqual(evidence);

    database.close();
    database = openDatabase(databasePath);
    const reloadedService = createProviderEvidenceService(
      database,
      createReader(null),
    );

    expect(reloadedService.getByIncidentId(incident.id)).toEqual(evidence);
  });

  it("keeps unexpected MCP fields out of normalized persisted evidence", async () => {
    const incidentService = createProviderEvidenceService(
      database,
      createReader({
        ...makeMcpResult({ unexpected: "root" }),
        unexpectedRoot: "ignored",
      }),
      () => "2026-08-25T10:00:00.000Z",
    );
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    await incidentService.inspectForIncident(incident.id);

    const row = database.get<{ evidence_json: string }>(
      "SELECT evidence_json FROM provider_evidence WHERE incident_id = ?",
      [incident.id],
    );
    expect(row?.evidence_json).toBeDefined();
    expect(row?.evidence_json).not.toContain("unexpectedRoot");
    expect(row?.evidence_json).not.toContain('"unexpected"');
    expect(row?.evidence_json).not.toContain('"full"');
  });

  it("persists no evidence when a required MCP field is malformed", async () => {
    const incidentService = createProviderEvidenceService(
      database,
      createReader(makeMcpResult({ status_code: "500" })),
    );
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    await expect(incidentService.inspectForIncident(incident.id)).rejects.toBeInstanceOf(
      GithubDeliveryNormalizationError,
    );
    expect(incidentService.getByIncidentId(incident.id)).toBeNull();
    expect(database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM provider_evidence",
    )?.count).toBe(0);
  });

  it("rejects a mismatched delivery ID before persisting", async () => {
    const incidentService = createProviderEvidenceService(
      database,
      createReader(makeMcpResult({ id: "different-delivery" })),
    );
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    await expect(incidentService.inspectForIncident(incident.id)).rejects.toThrow(
      "does not match the incident delivery ID",
    );
    expect(database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM provider_evidence",
    )?.count).toBe(0);
  });

  it("leaves the incident intact and writes nothing when the MCP read fails", async () => {
    const incidentService = createProviderEvidenceService(database, {
      async getWebhookDelivery() {
        throw new Error("MCP unavailable");
      },
    });
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    await expect(incidentService.inspectForIncident(incident.id)).rejects.toBeInstanceOf(
      ProviderEvidenceReadError,
    );
    expect(createIncidentService(database).getById(incident.id)).toEqual(incident);
    expect(database.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM provider_evidence",
    )?.count).toBe(0);
  });

  it("returns the immutable first capture without a second MCP call", async () => {
    let calls = 0;
    let currentResult: unknown = makeMcpResult();
    const service = createProviderEvidenceService(database, {
      async getWebhookDelivery() {
        calls += 1;
        return currentResult;
      },
    }, () => calls === 1
      ? "2026-08-25T10:00:00.000Z"
      : "2026-08-25T11:00:00.000Z");
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    const first = await service.inspectForIncident(incident.id);
    currentResult = makeMcpResult({
      status: "Delivered",
      status_code: 200,
      response: { headers: {}, payload: "conflicting later response" },
    });
    const second = await service.inspectForIncident(incident.id);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(second.outcome.statusCode).toBe(500);
    expect(second.response.body).toBe("receiver failed");
  });

  it("persists nothing when GUID and X-GitHub-Delivery contradict", async () => {
    const service = createProviderEvidenceService(
      database,
      createReader(makeMcpResult({ guid: "different-guid" })),
    );
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    await expect(service.inspectForIncident(incident.id)).rejects.toThrow(
      "does not match the delivery GUID",
    );
    expect(service.getByIncidentId(incident.id)).toBeNull();
  });

  it("fails closed on a typed MCP timeout", async () => {
    const service = createProviderEvidenceService(database, {
      async getWebhookDelivery() {
        throw new GithubMcpTimeoutError();
      },
    });
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });

    await expect(service.inspectForIncident(incident.id)).rejects.toBeInstanceOf(
      ProviderEvidenceReadError,
    );
    expect(service.getByIncidentId(incident.id)).toBeNull();
  });

  it("rejects indexed columns that disagree with normalized evidence JSON", async () => {
    const service = createProviderEvidenceService(
      database,
      createReader(makeMcpResult()),
    );
    const { incident } = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: deliveryId,
      repositoryId: "example/receiver",
    });
    await service.inspectForIncident(incident.id);

    database.run(
      "UPDATE provider_evidence SET delivery_guid = ? WHERE incident_id = ?",
      ["tampered-guid", incident.id],
    );

    expect(() => service.getByIncidentId(incident.id)).toThrow(
      "does not match its normalized JSON",
    );
  });

});

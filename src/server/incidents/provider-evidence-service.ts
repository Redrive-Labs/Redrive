import {
  GITHUB_PROVIDER,
  parseProviderEvidence,
  PROVIDER_EVIDENCE_SCHEMA_VERSION,
  type ProviderEvidence,
} from "@/domain/provider-evidence";
import { normalizeGithubWebhookDelivery } from "@/server/github/github-provider-evidence";
import { getConfiguredDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { getServerConfig } from "@/server/infrastructure/config";
import { createIncidentService } from "@/server/incidents/incident-service";

export class IncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`Incident ${incidentId} was not found.`);
    this.name = "IncidentNotFoundError";
  }
}

export class UnsupportedProviderEvidenceError extends Error {
  constructor(provider: string) {
    super(`Provider evidence is not supported for provider ${provider}.`);
    this.name = "UnsupportedProviderEvidenceError";
  }
}


export type ProviderEvidenceDisposition = "CAPTURED" | "REOBSERVED";

export interface ProviderEvidenceCaptureResult {
  evidence: ProviderEvidence;
  disposition: ProviderEvidenceDisposition;
}

export class ProviderEvidenceConflictError extends Error {
  readonly existing: ProviderEvidence;
  readonly observation: ProviderEvidence;

  constructor(existing: ProviderEvidence, observation: ProviderEvidence) {
    super("The provider observation conflicts with immutable ProviderEvidence.");
    this.name = "ProviderEvidenceConflictError";
    this.existing = existing;
    this.observation = observation;
  }
}

interface ProviderEvidenceRow extends Record<string, unknown> {
  incidentId: unknown;
  applicationConnectionId: unknown;
  schemaVersion: unknown;
  provider: unknown;
  providerDeliveryId: unknown;
  deliveryGuid: unknown;
  outcomeStatus: unknown;
  statusCode: unknown;
  deliveredAt: unknown;
  canonicalPayloadSha256: unknown;
  evidenceJson: unknown;
  capturedAt: unknown;
}

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Provider evidence row has an invalid ${field} value.`);
  }

  return value;
}

function readIntegerOrNull(
  row: Record<string, unknown>,
  field: string,
): number | null {
  const value = row[field];
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value))
  ) {
    throw new Error(`Provider evidence row has an invalid ${field} value.`);
  }

  return value;
}

function readNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provider evidence row has an invalid ${field} value.`);
  }
  return value;
}

function mapProviderEvidenceRow(
  row: ProviderEvidenceRow,
  expectedIncidentId: string,
): ProviderEvidence {
  const evidenceJson = readText(row, "evidenceJson");
  let parsed: unknown;

  try {
    parsed = JSON.parse(evidenceJson) as unknown;
  } catch {
    throw new Error("Provider evidence row contains invalid JSON.");
  }

  const evidence = parseProviderEvidence(parsed);
  const applicationConnectionId = readNullableText(
    row,
    "applicationConnectionId",
  );

  if (row.incidentId !== expectedIncidentId) {
    throw new Error("Provider evidence row has an invalid incident ID.");
  }
  if (
    evidence.incidentId !== undefined &&
    evidence.incidentId !== expectedIncidentId
  ) {
    throw new Error("Provider evidence JSON has an invalid incident ID.");
  }
  if (
    evidence.applicationConnectionId !== undefined &&
    evidence.applicationConnectionId !== applicationConnectionId
  ) {
    throw new Error(
      "Provider evidence JSON has an invalid application connection ID.",
    );
  }

  if (
    row.schemaVersion !== evidence.schemaVersion ||
    row.provider !== evidence.provider ||
    row.providerDeliveryId !== evidence.providerDeliveryId ||
    row.deliveryGuid !== evidence.deliveryGuid ||
    row.outcomeStatus !== evidence.outcome.status ||
    readIntegerOrNull(row, "statusCode") !== evidence.outcome.statusCode ||
    row.deliveredAt !== evidence.deliveredAt ||
    row.canonicalPayloadSha256 !== evidence.request.canonicalPayloadSha256 ||
    row.capturedAt !== evidence.capturedAt
  ) {
    throw new Error(
      "Provider evidence row does not match its normalized JSON.",
    );
  }

  return {
    ...evidence,
    incidentId: expectedIncidentId,
    ...(applicationConnectionId === null ? {} : { applicationConnectionId }),
  };
}

const providerEvidenceColumns = `
  incident_id AS incidentId,
  application_connection_id AS applicationConnectionId,
  schema_version AS schemaVersion,
  provider,
  provider_delivery_id AS providerDeliveryId,
  delivery_guid AS deliveryGuid,
  outcome_status AS outcomeStatus,
  status_code AS statusCode,
  delivered_at AS deliveredAt,
  canonical_payload_sha256 AS canonicalPayloadSha256,
  evidence_json AS evidenceJson,
  captured_at AS capturedAt
`;

function canonicalizeForComparison(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeForComparison).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalizeForComparison(item)}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function providerEvidenceMatchesIgnoringCaptureTime(
  left: ProviderEvidence,
  right: ProviderEvidence,
): boolean {
  const { capturedAt: _leftCapturedAt, ...leftFacts } = left;
  const { capturedAt: _rightCapturedAt, ...rightFacts } = right;
  return (
    canonicalizeForComparison(leftFacts) ===
    canonicalizeForComparison(rightFacts)
  );
}

export function createProviderEvidenceService(
  database: SqliteDatabase,
  now: () => string = () => new Date().toISOString(),
) {
  const incidentService = createIncidentService(database);

  function getByIncidentId(incidentId: string): ProviderEvidence | null {
    const row = database.get<ProviderEvidenceRow>(
      `
        SELECT ${providerEvidenceColumns}
        FROM provider_evidence
        WHERE incident_id = ?
      `,
      [incidentId],
    );

    return row === undefined ? null : mapProviderEvidenceRow(row, incidentId);
  }

  function getCapturedIncidentIds(incidentIds: readonly string[]): Set<string> {
    if (incidentIds.length === 0) {
      return new Set();
    }

    const placeholders = incidentIds.map(() => "?").join(", ");
    const rows = database.all<{ incidentId: string }>(
      `
        SELECT incident_id AS incidentId
        FROM provider_evidence
        WHERE incident_id IN (${placeholders})
      `,
      incidentIds,
    );

    return new Set(rows.map((row) => row.incidentId));
  }

  function getIncidentOrThrow(incidentId: string) {
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new IncidentNotFoundError(incidentId);
    }
    return incident;
  }

  function normalizeForIncident(
    incidentId: string,
    result: unknown,
    capturedAt = now(),
  ): ProviderEvidence {
    const incident = getIncidentOrThrow(incidentId);
    if (incident.provider !== GITHUB_PROVIDER) {
      throw new UnsupportedProviderEvidenceError(incident.provider);
    }

    const evidence = normalizeGithubWebhookDelivery(
      result,
      {
        repositoryId: incident.repositoryId,
        deliveryId: incident.externalDeliveryId,
      },
      capturedAt,
    );
    return {
      ...evidence,
      incidentId,
      ...(incident.applicationConnectionId === undefined
        ? {}
        : { applicationConnectionId: incident.applicationConnectionId }),
    };
  }


  function serializeEvidence(evidence: ProviderEvidence): string {
    const evidenceJson = JSON.stringify(evidence);
    if (evidenceJson === undefined) {
      throw new Error("Provider evidence could not be serialized.");
    }
    return evidenceJson;
  }

  interface ProviderEvidenceReconciliation {
    capture: ProviderEvidenceCaptureResult;
    conflict: ProviderEvidenceConflictError | null;
  }

  function reconcileNormalizedEvidenceWithinTransaction(
    incidentId: string,
    evidence: ProviderEvidence,
    evidenceJson: string,
  ): ProviderEvidenceReconciliation {
    if (evidence.incidentId !== incidentId) {
      throw new Error(
        "Provider evidence provenance does not match the incident.",
      );
    }
    const insertion = database.run(
      `
        INSERT INTO provider_evidence (
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
        ) VALUES (
          @incidentId,
          @applicationConnectionId,
          @schemaVersion,
          @provider,
          @providerDeliveryId,
          @deliveryGuid,
          @outcomeStatus,
          @statusCode,
          @deliveredAt,
          @canonicalPayloadSha256,
          @evidenceJson,
          @capturedAt
        )
        ON CONFLICT (incident_id) DO NOTHING
      `,
      {
        incidentId,
        applicationConnectionId: evidence.applicationConnectionId ?? null,
        schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
        provider: GITHUB_PROVIDER,
        providerDeliveryId: evidence.providerDeliveryId,
        deliveryGuid: evidence.deliveryGuid,
        outcomeStatus: evidence.outcome.status,
        statusCode: evidence.outcome.statusCode,
        deliveredAt: evidence.deliveredAt,
        canonicalPayloadSha256: evidence.request.canonicalPayloadSha256,
        evidenceJson,
        capturedAt: evidence.capturedAt,
      },
    );

    const persisted = getByIncidentId(incidentId);
    if (persisted === null) {
      throw new Error("Provider evidence insert did not produce a persisted snapshot.");
    }

    if (providerEvidenceMatchesIgnoringCaptureTime(persisted, evidence)) {
      return {
        capture: {
          evidence: persisted,
          disposition: insertion.changes === 1 ? "CAPTURED" : "REOBSERVED",
        },
        conflict: null,
      };
    }

    return {
      capture: { evidence: persisted, disposition: "REOBSERVED" },
      conflict: new ProviderEvidenceConflictError(persisted, evidence),
    };
  }

  function persistNormalizedEvidence(
    incidentId: string,
    evidence: ProviderEvidence,
  ): ProviderEvidenceCaptureResult {
    const evidenceJson = serializeEvidence(evidence);
    const reconciliation = database.transaction(
      () =>
        reconcileNormalizedEvidenceWithinTransaction(
          incidentId,
          evidence,
          evidenceJson,
        ),
      "immediate",
    );

    if (reconciliation.conflict !== null) {
      throw reconciliation.conflict;
    }
    return reconciliation.capture;
  }

  function captureOrReconcileForIncident(
    incidentId: string,
    result: unknown,
  ): ProviderEvidenceCaptureResult {
    const evidence = normalizeForIncident(incidentId, result);
    return persistNormalizedEvidence(incidentId, evidence);
  }


  return {
    getByIncidentId,
    getCapturedIncidentIds,
    normalizeForIncident,
    captureOrReconcileForIncident,
    reconcileNormalizedEvidenceWithinTransaction,
    serializeEvidence,
  };
}

type ProviderEvidenceService = ReturnType<typeof createProviderEvidenceService>;

function withConfiguredProviderEvidenceService<T>(
  operation: (service: ProviderEvidenceService) => T,
): T {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(createProviderEvidenceService(database));
}

export async function getProviderEvidenceByIncidentId(
  incidentId: string,
): Promise<ProviderEvidence | null> {
  return withConfiguredProviderEvidenceService((service) =>
    service.getByIncidentId(incidentId),
  );
}

export async function getProviderEvidenceCaptureStatus(
  incidentIds: readonly string[],
): Promise<Set<string>> {
  return withConfiguredProviderEvidenceService((service) =>
    service.getCapturedIncidentIds(incidentIds),
  );
}

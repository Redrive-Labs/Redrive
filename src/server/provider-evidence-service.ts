import {
  GITHUB_PROVIDER,
  parseProviderEvidence,
  PROVIDER_EVIDENCE_SCHEMA_VERSION,
  type ProviderEvidence,
} from "@/domain/provider-evidence";
import {
  createConfiguredGithubWebhookDeliveryReader,
  type GithubWebhookDeliveryReader,
} from "@/server/github-mcp";
import { normalizeGithubWebhookDelivery } from "@/server/github-provider-evidence";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { getServerConfig } from "@/server/config";
import { createIncidentService } from "@/server/incident-service";

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

export class ProviderEvidenceReadError extends Error {
  constructor(options?: ErrorOptions) {
    super("GitHub provider evidence could not be read.", options);
    this.name = "ProviderEvidenceReadError";
  }
}

interface ProviderEvidenceRow extends Record<string, unknown> {
  incidentId: unknown;
  schemaVersion: unknown;
  provider: unknown;
  deliveryId: unknown;
  outcomeStatus: unknown;
  statusCode: unknown;
  deliveredAt: unknown;
  payloadSha256: unknown;
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
    throw new Error(
      `Provider evidence row has an invalid ${field} value.`,
    );
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

  if (row.incidentId !== expectedIncidentId) {
    throw new Error("Provider evidence row has an invalid incident ID.");
  }

  if (
    row.schemaVersion !== evidence.schemaVersion ||
    row.provider !== evidence.provider ||
    row.deliveryId !== evidence.deliveryId ||
    row.outcomeStatus !== evidence.outcome.status ||
    readIntegerOrNull(row, "statusCode") !== evidence.outcome.statusCode ||
    row.deliveredAt !== evidence.deliveredAt ||
    row.payloadSha256 !== evidence.request.payloadSha256 ||
    row.capturedAt !== evidence.capturedAt
  ) {
    throw new Error("Provider evidence row does not match its normalized JSON.");
  }

  return evidence;
}

const providerEvidenceColumns = `
  incident_id AS incidentId,
  schema_version AS schemaVersion,
  provider,
  delivery_id AS deliveryId,
  outcome_status AS outcomeStatus,
  status_code AS statusCode,
  delivered_at AS deliveredAt,
  payload_sha256 AS payloadSha256,
  evidence_json AS evidenceJson,
  captured_at AS capturedAt
`;

export function createProviderEvidenceService(
  database: SqliteDatabase,
  githubDeliveryReader: GithubWebhookDeliveryReader,
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

    return row === undefined
      ? null
      : mapProviderEvidenceRow(row, incidentId);
  }

  async function inspectForIncident(
    incidentId: string,
  ): Promise<ProviderEvidence> {
    const incident = incidentService.getById(incidentId);

    if (incident === null) {
      throw new IncidentNotFoundError(incidentId);
    }

    if (incident.provider !== GITHUB_PROVIDER) {
      throw new UnsupportedProviderEvidenceError(incident.provider);
    }

    let result: unknown;
    try {
      result = await githubDeliveryReader.getWebhookDelivery({
        repositoryId: incident.repositoryId,
        deliveryId: incident.externalDeliveryId,
      });
    } catch (error) {
      throw new ProviderEvidenceReadError({ cause: error });
    }

    const evidence: ProviderEvidence = normalizeGithubWebhookDelivery(
      result,
      {
        repositoryId: incident.repositoryId,
        deliveryId: incident.externalDeliveryId,
      },
      now(),
    );

    const evidenceJson = JSON.stringify(evidence);
    if (evidenceJson === undefined) {
      throw new Error("Provider evidence could not be serialized.");
    }

    database.transaction(() => {
      database.run(
        `
          INSERT INTO provider_evidence (
            incident_id,
            schema_version,
            provider,
            delivery_id,
            outcome_status,
            status_code,
            delivered_at,
            payload_sha256,
            evidence_json,
            captured_at
          ) VALUES (
            @incidentId,
            @schemaVersion,
            @provider,
            @deliveryId,
            @outcomeStatus,
            @statusCode,
            @deliveredAt,
            @payloadSha256,
            @evidenceJson,
            @capturedAt
          )
          ON CONFLICT (incident_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            provider = excluded.provider,
            delivery_id = excluded.delivery_id,
            outcome_status = excluded.outcome_status,
            status_code = excluded.status_code,
            delivered_at = excluded.delivered_at,
            payload_sha256 = excluded.payload_sha256,
            evidence_json = excluded.evidence_json,
            captured_at = excluded.captured_at
        `,
        {
          incidentId,
          schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
          provider: GITHUB_PROVIDER,
          deliveryId: evidence.deliveryId,
          outcomeStatus: evidence.outcome.status,
          statusCode: evidence.outcome.statusCode,
          deliveredAt: evidence.deliveredAt,
          payloadSha256: evidence.request.payloadSha256,
          evidenceJson,
          capturedAt: evidence.capturedAt,
        },
      );
    }, "immediate");

    return evidence;
  }

  return {
    getByIncidentId,
    inspectForIncident,
  };
}

type ProviderEvidenceService = ReturnType<typeof createProviderEvidenceService>;

function createLazyConfiguredGithubReader(): GithubWebhookDeliveryReader {
  return {
    getWebhookDelivery(lookup) {
      return createConfiguredGithubWebhookDeliveryReader().getWebhookDelivery(
        lookup,
      );
    },
  };
}

function withConfiguredProviderEvidenceService<T>(
  operation: (service: ProviderEvidenceService) => T,
): T {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(
    createProviderEvidenceService(
      database,
      createLazyConfiguredGithubReader(),
    ),
  );
}

export async function inspectProviderEvidence(
  incidentId: string,
): Promise<ProviderEvidence> {
  return withConfiguredProviderEvidenceService((service) =>
    service.inspectForIncident(incidentId),
  );
}

export async function getProviderEvidenceByIncidentId(
  incidentId: string,
): Promise<ProviderEvidence | null> {
  return withConfiguredProviderEvidenceService((service) =>
    service.getByIncidentId(incidentId),
  );
}

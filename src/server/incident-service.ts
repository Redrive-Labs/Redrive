import { randomUUID } from "node:crypto";
import {
  INCIDENT_STATUS,
  type CreateIncidentInput,
  type Incident,
  parseCreateIncidentInput,
} from "@/domain/incident";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { getServerConfig } from "@/server/config";
import {
  getApplicationConnection,
} from "@/server/github-connection-service";
import type { VerifiedGithubFailedDelivery } from "@/server/github-delivery-service";

export const INCIDENT_LIST_LIMIT = 50;

export interface IncidentCreationResult {
  incident: Incident;
  created: boolean;
}

export class IncidentIdentityConflictError extends Error {
  constructor() {
    super("The delivery identity is already bound to a different incident.");
    this.name = "IncidentIdentityConflictError";
  }
}

const incidentColumns = `
  id,
  provider,
  external_delivery_id AS externalDeliveryId,
  repository_id AS repositoryId,
  application_connection_id AS applicationConnectionId,
  status,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function mapIncidentRow(row: Record<string, unknown>): Incident {
  function readText(column: string): string {
    const value = row[column];

    if (typeof value !== "string") {
      throw new Error(`Incident row has an invalid ${column} value.`);
    }

    return value;
  }

  const status = readText("status");

  if (status !== INCIDENT_STATUS) {
    throw new Error("Incident row has an invalid status.");
  }

  const applicationConnectionId = row.applicationConnectionId;
  if (
    applicationConnectionId !== null &&
    applicationConnectionId !== undefined &&
    typeof applicationConnectionId !== "string"
  ) {
    throw new Error("Incident row has an invalid application connection value.");
  }

  return {
    id: readText("id"),
    provider: readText("provider"),
    externalDeliveryId: readText("externalDeliveryId"),
    repositoryId: readText("repositoryId"),
    ...(applicationConnectionId === null || applicationConnectionId === undefined
      ? {}
      : { applicationConnectionId }),
    status,
    createdAt: readText("createdAt"),
    updatedAt: readText("updatedAt"),
  };
}

export function createIncidentService(database: SqliteDatabase) {
  const insertIncident = `
    INSERT INTO incidents (
      id,
      provider,
      external_delivery_id,
      repository_id,
      application_connection_id,
      status,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @provider,
      @externalDeliveryId,
      @repositoryId,
      @applicationConnectionId,
      @status,
      @createdAt,
      @updatedAt
    )
    ON CONFLICT (provider, repository_id, external_delivery_id) DO NOTHING
  `;
  const getIncident = `
    SELECT ${incidentColumns}
    FROM incidents
    WHERE id = ?
  `;
  const getIncidentByIdentity = `
    SELECT ${incidentColumns}
    FROM incidents
    WHERE provider = ?
      AND repository_id = ?
      AND external_delivery_id = ?
  `;
  const listIncidentRows = `
    SELECT ${incidentColumns}
    FROM incidents
    ORDER BY created_at DESC, id DESC
    LIMIT ${INCIDENT_LIST_LIMIT}
  `;

  function getById(id: string): Incident | null {
    const row = database.get<Record<string, unknown>>(getIncident, [id]);
    return row === undefined ? null : mapIncidentRow(row);
  }

  function getByDeliveryIdentity(
    provider: string,
    repositoryId: string,
    externalDeliveryId: string,
  ): Incident | null {
    const row = database.get<Record<string, unknown>>(
      getIncidentByIdentity,
      [provider, repositoryId, externalDeliveryId],
    );
    return row === undefined ? null : mapIncidentRow(row);
  }

  function insert(
    values: CreateIncidentInput & { applicationConnectionId?: string },
  ): IncidentCreationResult {
    const now = new Date().toISOString();
    const id = randomUUID();

    const insertion = database.run(
      insertIncident,
      {
        id,
        provider: values.provider,
        externalDeliveryId: values.externalDeliveryId,
        repositoryId: values.repositoryId,
        applicationConnectionId: values.applicationConnectionId ?? null,
        status: INCIDENT_STATUS,
        createdAt: now,
        updatedAt: now,
      },
    );

    const incident = getByDeliveryIdentity(
      values.provider,
      values.repositoryId,
      values.externalDeliveryId,
    );

    if (incident === null) {
      throw new Error("Created or existing incident could not be read back.");
    }

    return {
      incident,
      created: insertion.changes === 1,
    };
  }

  return {
    // This is the historical incident operation. Connection-shaped input is
    // rejected by parseCreateIncidentInput and cannot reach persistence here.
    create(input: unknown): IncidentCreationResult {
      return insert(parseCreateIncidentInput(input));
    },
    // The only connection-backed persistence operation accepts a value produced
    // by the GitHub delivery verification boundary, never raw request fields.
    createFromVerifiedConnectionDelivery(
      delivery: VerifiedGithubFailedDelivery,
    ): IncidentCreationResult {
      const connection = getApplicationConnection(
        database,
        delivery.connectionId,
      );
      if (
        connection === null ||
        connection.provider !== delivery.provider ||
        connection.repositoryId !== delivery.repositoryId ||
        connection.webhookId !== delivery.webhookId
      ) {
        throw new Error(
          "The verified GitHub delivery no longer matches its application connection.",
        );
      }
      const existing = getByDeliveryIdentity(
        connection.provider,
        connection.repositoryId,
        delivery.id,
      );
      if (
        existing !== null &&
        existing.applicationConnectionId !== connection.id
      ) {
        throw new IncidentIdentityConflictError();
      }
      const result = insert({
        provider: connection.provider,
        externalDeliveryId: delivery.id,
        repositoryId: connection.repositoryId,
        applicationConnectionId: connection.id,
      });
      // Re-check the row returned after the conflict-safe insert as well. A
      // concurrent legacy writer may have won between the preflight read and
      // INSERT; never return that row as a connection-backed incident.
      if (result.incident.applicationConnectionId !== connection.id) {
        throw new IncidentIdentityConflictError();
      }
      return result;
    },
    getById,
    getByDeliveryIdentity,
    list(): Incident[] {
      return database
        .all<Record<string, unknown>>(listIncidentRows)
        .map(mapIncidentRow);
    },
  };
}

type IncidentService = ReturnType<typeof createIncidentService>;

async function withConfiguredService<T>(
  operation: (service: IncidentService) => T,
): Promise<T> {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(createIncidentService(database));
}

export async function createIncident(
  input: unknown,
): Promise<IncidentCreationResult> {
  return withConfiguredService((service) => service.create(input));
}

export async function getIncidentById(
  id: string,
): Promise<Incident | null> {
  return withConfiguredService((service) => service.getById(id));
}

export async function listIncidents(): Promise<Incident[]> {
  return withConfiguredService((service) => service.list());
}

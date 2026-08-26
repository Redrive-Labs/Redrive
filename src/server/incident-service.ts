import { randomUUID } from "node:crypto";
import {
  INCIDENT_STATUS,
  type Incident,
  parseCreateIncidentInput,
} from "@/domain/incident";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { getServerConfig } from "@/server/config";

export const INCIDENT_LIST_LIMIT = 50;

const incidentColumns = `
  id,
  provider,
  external_delivery_id AS externalDeliveryId,
  repository_id AS repositoryId,
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

  return {
    id: readText("id"),
    provider: readText("provider"),
    externalDeliveryId: readText("externalDeliveryId"),
    repositoryId: readText("repositoryId"),
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
  `;
  const getIncident = `
    SELECT ${incidentColumns}
    FROM incidents
    WHERE id = ?
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

  return {
    create(input: unknown): Incident {
      const values = parseCreateIncidentInput(input);
      const now = new Date().toISOString();
      const id = randomUUID();

      database.run(
        insertIncident,
        {
          id,
          provider: values.provider,
          externalDeliveryId: values.externalDeliveryId,
          repositoryId: values.repositoryId,
          status: INCIDENT_STATUS,
          createdAt: now,
          updatedAt: now,
        },
      );

      const incident = getById(id);

      if (incident === null) {
        throw new Error("Created incident could not be read back.");
      }

      return incident;
    },
    getById,
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

export async function createIncident(input: unknown): Promise<Incident> {
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

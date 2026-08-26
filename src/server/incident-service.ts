import { randomUUID } from "node:crypto";
import {
  INCIDENT_STATUS,
  type Incident,
  parseCreateIncidentInput,
} from "@/domain/incident";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { getServerConfig } from "@/server/config";

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
  `;

  function getById(id: string): Incident | null {
    const statement = database.prepare(getIncident);

    try {
      if (!statement.bind([id]) || !statement.step()) {
        return null;
      }

      return mapIncidentRow(statement.getAsObject());
    } finally {
      statement.free();
    }
  }

  return {
    create(input: unknown): Incident {
      const values = parseCreateIncidentInput(input);
      const now = new Date().toISOString();
      const id = randomUUID();

      database.run(
        insertIncident,
        [id, values.provider, values.externalDeliveryId, values.repositoryId,
          INCIDENT_STATUS, now, now],
      );

      const incident = getById(id);

      if (incident === null) {
        throw new Error("Created incident could not be read back.");
      }

      return incident;
    },
    getById,
    list(): Incident[] {
      const statement = database.prepare(listIncidentRows);
      const incidents: Incident[] = [];

      try {
        while (statement.step()) {
          incidents.push(mapIncidentRow(statement.getAsObject()));
        }

        return incidents;
      } finally {
        statement.free();
      }
    },
  };
}

type IncidentService = ReturnType<typeof createIncidentService>;

async function withConfiguredService<T>(
  operation: (service: IncidentService) => T,
): Promise<T> {
  const database = await openDatabase(getServerConfig().databasePath);

  try {
    return operation(createIncidentService(database));
  } finally {
    database.close();
  }
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

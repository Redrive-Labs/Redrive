import {
  TRUEFORGE_SESSION_BINDING_STATES,
  type TrueForgeSessionBinding,
  type TrueForgeSessionBindingState,
} from "@/domain/trueforge-session";
import type { SqliteDatabase } from "@/server/database";

interface TrueForgeSessionBindingRow extends Record<string, unknown> {
  incidentId: unknown;
  state: unknown;
  trueForgeSessionId: unknown;
  creationToken: unknown;
  coordinatorSpecVersion: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const bindingColumns = `
  incident_id AS incidentId,
  state,
  trueforge_session_id AS trueForgeSessionId,
  creation_token AS creationToken,
  coordinator_spec_version AS coordinatorSpecVersion,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function readText(
  row: Record<string, unknown>,
  field: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`TrueForge session binding row has an invalid ${field} value.`);
  }
  return value;
}

function readNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new Error(`TrueForge session binding row has an invalid ${field} value.`);
  }
  return value;
}

function readState(value: unknown): TrueForgeSessionBindingState {
  if (
    typeof value !== "string" ||
    !TRUEFORGE_SESSION_BINDING_STATES.includes(
      value as TrueForgeSessionBindingState,
    )
  ) {
    throw new Error("TrueForge session binding row has an invalid state value.");
  }
  return value as TrueForgeSessionBindingState;
}

function mapBindingRow(row: TrueForgeSessionBindingRow): TrueForgeSessionBinding {
  const state = readState(row.state);
  const trueForgeSessionId = readNullableText(row, "trueForgeSessionId");
  const creationToken = readNullableText(row, "creationToken");

  if ((state === "ACTIVE" || state === "LOST") && trueForgeSessionId === null) {
    throw new Error(
      "TrueForge session binding row has no session ID for its state.",
    );
  }

  if (state === "CREATING" && creationToken === null) {
    throw new Error(
      "TrueForge session binding row has no creation token for CREATING.",
    );
  }

  if (state === "CREATING" && trueForgeSessionId !== null) {
    throw new Error(
      "TrueForge session binding row has a session ID for CREATING.",
    );
  }

  return {
    incidentId: readText(row, "incidentId"),
    state,
    trueForgeSessionId,
    creationToken,
    coordinatorSpecVersion: readText(row, "coordinatorSpecVersion"),
    createdAt: readText(row, "createdAt"),
    updatedAt: readText(row, "updatedAt"),
  };
}

export function createTrueForgeSessionBindingRepository(
  database: SqliteDatabase,
) {
  function getByIncidentId(
    incidentId: string,
  ): TrueForgeSessionBinding | null {
    const row = database.get<TrueForgeSessionBindingRow>(
      `
        SELECT ${bindingColumns}
        FROM trueforge_session_bindings
        WHERE incident_id = ?
      `,
      [incidentId],
    );

    return row === undefined ? null : mapBindingRow(row);
  }

  function reserveCreation(
    incidentId: string,
    creationToken: string,
    coordinatorSpecVersion: string,
    now: string,
  ): TrueForgeSessionBinding {
    return database.transaction(() => {
      const existing = getByIncidentId(incidentId);
      if (existing !== null) {
        return existing;
      }

      database.run(
        `
          INSERT INTO trueforge_session_bindings (
            incident_id,
            state,
            trueforge_session_id,
            creation_token,
            coordinator_spec_version,
            created_at,
            updated_at
          ) VALUES (
            @incidentId,
            'CREATING',
            NULL,
            @creationToken,
            @coordinatorSpecVersion,
            @now,
            @now
          )
        `,
        {
          incidentId,
          creationToken,
          coordinatorSpecVersion,
          now,
        },
      );

      const reserved = getByIncidentId(incidentId);
      if (reserved === null) {
        throw new Error(
          "TrueForge session creation reservation was not persisted.",
        );
      }
      return reserved;
    }, "immediate");
  }

  function activate(
    incidentId: string,
    creationToken: string,
    trueForgeSessionId: string,
    now: string,
  ): TrueForgeSessionBinding | null {
    return database.transaction(() => {
      const update = database.run(
        `
          UPDATE trueforge_session_bindings
          SET
            state = 'ACTIVE',
            trueforge_session_id = @trueForgeSessionId,
            creation_token = NULL,
            updated_at = @now
          WHERE incident_id = @incidentId
            AND state = 'CREATING'
            AND trueforge_session_id IS NULL
            AND creation_token = @creationToken
        `,
        {
          incidentId,
          creationToken,
          trueForgeSessionId,
          now,
        },
      );

      if (update.changes !== 1) {
        return null;
      }

      const active = getByIncidentId(incidentId);
      if (active === null || active.state !== "ACTIVE") {
        throw new Error("TrueForge session activation was not persisted.");
      }
      return active;
    }, "immediate");
  }

  function markCreationUncertain(
    incidentId: string,
    creationToken: string,
    now: string,
  ): boolean {
    return database.transaction(() => {
      const update = database.run(
        `
          UPDATE trueforge_session_bindings
          SET
            state = 'CREATION_UNCERTAIN',
            trueforge_session_id = NULL,
            creation_token = NULL,
            updated_at = @now
          WHERE incident_id = @incidentId
            AND state = 'CREATING'
            AND creation_token = @creationToken
        `,
        {
          incidentId,
          creationToken,
          now,
        },
      );
      return update.changes === 1;
    }, "immediate");
  }

  function markStaleCreationUncertain(
    incidentId: string,
    creationToken: string,
    expectedCreatedAt: string,
    staleBefore: string,
    now: string,
  ): boolean {
    return database.transaction(() => {
      const update = database.run(
        `
          UPDATE trueforge_session_bindings
          SET
            state = 'CREATION_UNCERTAIN',
            trueforge_session_id = NULL,
            creation_token = NULL,
            updated_at = @now
          WHERE incident_id = @incidentId
            AND state = 'CREATING'
            AND creation_token = @creationToken
            AND created_at = @expectedCreatedAt
            AND created_at <= @staleBefore
        `,
        {
          incidentId,
          creationToken,
          expectedCreatedAt,
          staleBefore,
          now,
        },
      );
      return update.changes === 1;
    }, "immediate");
  }

  function releaseCreation(
    incidentId: string,
    creationToken: string,
  ): boolean {
    return database.transaction(() => {
      const deletion = database.run(
        `
          DELETE FROM trueforge_session_bindings
          WHERE incident_id = @incidentId
            AND state = 'CREATING'
            AND creation_token = @creationToken
        `,
        { incidentId, creationToken },
      );
      return deletion.changes === 1;
    }, "immediate");
  }

  function updateCoordinatorSpecVersion(
    incidentId: string,
    trueForgeSessionId: string,
    expectedVersion: string,
    nextVersion: string,
    now: string,
  ): TrueForgeSessionBinding | null {
    return database.transaction(() => {
      const update = database.run(
        `
          UPDATE trueforge_session_bindings
          SET
            coordinator_spec_version = @nextVersion,
            updated_at = @now
          WHERE incident_id = @incidentId
            AND state = 'ACTIVE'
            AND trueforge_session_id = @trueForgeSessionId
            AND coordinator_spec_version = @expectedVersion
        `,
        {
          incidentId,
          trueForgeSessionId,
          expectedVersion,
          nextVersion,
          now,
        },
      );

      if (update.changes !== 1) {
        return null;
      }

      const updated = getByIncidentId(incidentId);
      if (updated === null || updated.state !== "ACTIVE") {
        throw new Error(
          "TrueForge Coordinator spec version update was not persisted.",
        );
      }
      return updated;
    }, "immediate");
  }

  function markLost(
    incidentId: string,
    trueForgeSessionId: string,
    now: string,
  ): TrueForgeSessionBinding | null {
    return database.transaction(() => {
      const update = database.run(
        `
          UPDATE trueforge_session_bindings
          SET
            state = 'LOST',
            updated_at = @now
          WHERE incident_id = @incidentId
            AND state = 'ACTIVE'
            AND trueforge_session_id = @trueForgeSessionId
        `,
        {
          incidentId,
          trueForgeSessionId,
          now,
        },
      );

      if (update.changes !== 1) {
        return null;
      }

      const lost = getByIncidentId(incidentId);
      if (lost === null || lost.state !== "LOST") {
        throw new Error("TrueForge lost-session state was not persisted.");
      }
      return lost;
    }, "immediate");
  }

  return {
    getByIncidentId,
    reserveCreation,
    activate,
    markCreationUncertain,
    markStaleCreationUncertain,
    releaseCreation,
    updateCoordinatorSpecVersion,
    markLost,
  };
}

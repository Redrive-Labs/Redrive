import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

type SqliteValue = bigint | Buffer | null | number | string;
type SqliteParameters =
  | readonly SqliteValue[]
  | Record<string, SqliteValue>;
type SqliteTransactionMode = "deferred" | "immediate";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface Migration {
  version: number;
  sql?: string;
  apply?: (database: SqliteDatabase) => void;
}

const trueforgeSessionBindingsTableSql = `
  CREATE TABLE trueforge_session_bindings (
    incident_id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('CREATING', 'CREATION_UNCERTAIN', 'ACTIVE', 'LOST')
    ),
    trueforge_session_id TEXT UNIQUE,
    creation_token TEXT,
    coordinator_spec_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'CREATING'
        AND trueforge_session_id IS NULL
        AND creation_token IS NOT NULL)
      OR (state = 'CREATION_UNCERTAIN'
        AND trueforge_session_id IS NULL)
      OR (state IN ('ACTIVE', 'LOST')
        AND trueforge_session_id IS NOT NULL
        AND creation_token IS NULL)
    ),
    FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE
  );
`;

const incidentWorkflowEventsTableSql = `
  CREATE TABLE incident_workflow_events (
    id TEXT PRIMARY KEY NOT NULL,
    incident_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'PROVIDER_INVESTIGATION_STARTED',
      'PROVIDER_INVESTIGATOR_STARTED',
      'PROVIDER_EVIDENCE_CAPTURED',
      'PROVIDER_EVIDENCE_REOBSERVED',
      'PROVIDER_OBSERVATION_CONFLICT',
      'PROVIDER_INVESTIGATION_FAILED'
    )),
    trueforge_session_id TEXT,
    turn_id TEXT,
    provider_investigator_thread_id TEXT,
    trueforge_event_id TEXT UNIQUE,
    tool_call_id TEXT,
    occurred_at TEXT NOT NULL,
    details_json TEXT NOT NULL,
    FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE
  );

  CREATE INDEX incident_workflow_events_incident_idx
    ON incident_workflow_events (incident_id, occurred_at, id);
`;

const receiverConnectorTablesSql = `
  CREATE TABLE receiver_connections (
    id TEXT PRIMARY KEY NOT NULL,
    application_connection_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (
      state IN (
        'WAITING_FOR_RECEIVER',
        'VERIFYING',
        'READY',
        'UNHEALTHY'
      )
    ),
    enrollment_token_hash TEXT,
    enrollment_expires_at TEXT,
    enrollment_consumed_at TEXT,
    connector_id TEXT UNIQUE,
    connector_secret_hash TEXT,
    protocol_version TEXT,
    capabilities_json TEXT,
    enrolled_at TEXT,
    last_seen_at TEXT,
    last_health_status TEXT CHECK (
      last_health_status IS NULL OR last_health_status IN ('HEALTHY', 'UNHEALTHY')
    ),
    last_health_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (application_connection_id)
      REFERENCES application_connections (id)
      ON DELETE CASCADE
  );

  CREATE INDEX receiver_connections_state_idx
    ON receiver_connections (state, updated_at, id);

  CREATE TABLE receiver_read_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    receiver_connection_id TEXT NOT NULL,
    capability TEXT NOT NULL CHECK (
      capability IN ('business_state:v1', 'health:v1')
    ),
    input_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('QUEUED', 'LEASED', 'SUCCEEDED', 'FAILED', 'EXPIRED')
    ),
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    leased_connector_id TEXT,
    lease_expires_at TEXT,
    deadline_at TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (receiver_connection_id)
      REFERENCES receiver_connections (id)
      ON DELETE CASCADE
  );

  CREATE INDEX receiver_read_jobs_queue_idx
    ON receiver_read_jobs (
      receiver_connection_id,
      state,
      deadline_at,
      created_at,
      id
    );
`;

const receiverObservationsTableSql = `
  CREATE TABLE receiver_observations (
    id TEXT PRIMARY KEY NOT NULL,
    incident_id TEXT NOT NULL,
    application_connection_id TEXT NOT NULL,
    delivery_guid TEXT NOT NULL,
    capability TEXT NOT NULL CHECK (capability = 'business_state:v1'),
    tool TEXT NOT NULL CHECK (tool = 'get_business_state'),
    mcp_server_name TEXT NOT NULL,
    mutation_count INTEGER NOT NULL CHECK (mutation_count >= 0),
    business_state TEXT NOT NULL CHECK (
      business_state IN ('ABSENT', 'EXACTLY_ONE', 'MULTIPLE')
    ),
    observed_at TEXT NOT NULL,
    trueforge_session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    receiver_investigator_thread_id TEXT NOT NULL,
    thread_created_event_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_call_event_id TEXT NOT NULL,
    tool_response_event_id TEXT NOT NULL,
    tool_response_created_at TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (trueforge_session_id, turn_id),
    FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE,
    FOREIGN KEY (application_connection_id)
      REFERENCES application_connections (id)
      ON DELETE RESTRICT,
    UNIQUE (trueforge_session_id, tool_response_event_id)
  );

  CREATE INDEX receiver_observations_incident_idx
    ON receiver_observations (incident_id, created_at, id);
  CREATE INDEX receiver_observations_delivery_idx
    ON receiver_observations (delivery_guid);
`;

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE incidents (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        external_delivery_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'OPEN'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX incidents_created_at_idx
        ON incidents (created_at DESC, id DESC);
    `,
  },
  {
    version: 2,
    // This fails atomically when a legacy database contains duplicate
    // delivery identities. The migration transaction preserves those rows and
    // leaves version 2 unapplied instead of silently choosing one incident.
    sql: `
      CREATE UNIQUE INDEX incidents_delivery_identity_idx
        ON incidents (provider, repository_id, external_delivery_id);
    `,
  },
  {
    version: 3,
    sql: `
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
    `,
  },
  {
    version: 4,
    sql: trueforgeSessionBindingsTableSql,
  },
  {
    version: 5,
    // Version 4 was briefly shipped with a malformed table definition. Keep
    // the recorded version intact and normalize that table in a forward,
    // transactional migration instead of stranding those databases.
    apply: repairTrueForgeSessionBindings,
  },
  {
    version: 6,
    sql: incidentWorkflowEventsTableSql,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE github_app_registrations (
        id TEXT PRIMARY KEY NOT NULL,
        github_app_id TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_login TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('User', 'Organization')),
        private_key_ref TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE github_manifest_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        target_type TEXT NOT NULL CHECK (target_type IN ('personal', 'organization')),
        owner_login TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('PENDING', 'EXCHANGING', 'COMPLETED', 'RECOVERY_REQUIRED')
        ),
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        app_registration_id TEXT,
        remote_github_app_id TEXT,
        remote_slug TEXT,
        recovery_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (app_registration_id)
          REFERENCES github_app_registrations (id)
          ON DELETE RESTRICT,
        CHECK (
          (target_type = 'organization' AND owner_login IS NOT NULL)
          OR (target_type = 'personal' AND owner_login IS NULL)
        )
      );

      CREATE TABLE github_installations (
        installation_id TEXT PRIMARY KEY NOT NULL,
        app_registration_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
        repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
        last_verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (app_registration_id)
          REFERENCES github_app_registrations (id)
          ON DELETE RESTRICT
      );

      CREATE TABLE github_installation_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        state_hash TEXT NOT NULL UNIQUE,
        app_registration_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('PENDING', 'VERIFYING', 'COMPLETED', 'RECOVERY_REQUIRED')
        ),
        expires_at TEXT NOT NULL,
        claimed_at TEXT,
        installation_id TEXT,
        recovery_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (app_registration_id)
          REFERENCES github_app_registrations (id)
          ON DELETE RESTRICT,
        FOREIGN KEY (installation_id)
          REFERENCES github_installations (installation_id)
          ON DELETE RESTRICT
      );

      CREATE TABLE application_connections (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL CHECK (provider = 'github'),
        github_installation_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_full_name TEXT NOT NULL,
        webhook_id TEXT NOT NULL,
        webhook_target_display TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'READY'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (github_installation_id)
          REFERENCES github_installations (installation_id)
          ON DELETE RESTRICT,
        UNIQUE (provider, repository_id, webhook_id)
      );

      ALTER TABLE incidents
        ADD COLUMN application_connection_id TEXT
        REFERENCES application_connections (id)
        ON DELETE SET NULL;

      CREATE INDEX github_manifest_attempts_status_idx
        ON github_manifest_attempts (status, expires_at);
      CREATE INDEX github_installation_attempts_status_idx
        ON github_installation_attempts (status, expires_at);
      CREATE INDEX github_installations_app_idx
        ON github_installations (app_registration_id);
      CREATE INDEX application_connections_installation_idx
        ON application_connections (github_installation_id);
      CREATE INDEX incidents_application_connection_idx
        ON incidents (application_connection_id);
    `,
  },
  {
    version: 8,
    // Conversion checkpoints are nullable so historical attempts remain
    // readable. No historical row is rewritten or inferred.
    sql: `
      ALTER TABLE github_manifest_attempts
        ADD COLUMN remote_owner_id TEXT;
      ALTER TABLE github_manifest_attempts
        ADD COLUMN remote_owner_login TEXT;
      ALTER TABLE github_manifest_attempts
        ADD COLUMN remote_owner_type TEXT;
      ALTER TABLE github_manifest_attempts
        ADD COLUMN private_key_sha256 TEXT;
    `,
  },
  {
    version: 9,
    sql: receiverConnectorTablesSql,
  },
  {
    version: 10,
    sql: receiverObservationsTableSql,
  },
  {
    version: 11,
    apply: migrateM27BProvenanceConstraints,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE recovery_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        incident_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
          state IN (
            'SESSION_CREATING',
            'SESSION_UNCERTAIN',
            'READY',
            'RUNNING',
            'REPAIR_VERIFIED',
            'FAILED',
            'SESSION_LOST'
          )
        ),
        creation_token TEXT,
        trueforge_session_id TEXT UNIQUE,
        recovery_spec_version TEXT NOT NULL,
        source_repository_full_name TEXT NOT NULL,
        original_revision TEXT NOT NULL,
        provider_status_code INTEGER NOT NULL,
        receiver_pre_count INTEGER NOT NULL CHECK (receiver_pre_count >= 0),
        delivery_guid TEXT NOT NULL,
        trueforge_turn_id TEXT,
        result_json TEXT,
        patch_text TEXT,
        patch_sha256 TEXT,
        reproduction_pre_count INTEGER CHECK (reproduction_pre_count IS NULL OR reproduction_pre_count >= 0),
        reproduction_http_status INTEGER,
        reproduction_post_count INTEGER CHECK (reproduction_post_count IS NULL OR reproduction_post_count >= 0),
        verification_pre_count INTEGER CHECK (verification_pre_count IS NULL OR verification_pre_count >= 0),
        verification_http_status INTEGER,
        verification_post_count INTEGER CHECK (verification_post_count IS NULL OR verification_post_count >= 0),
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        CHECK (
          (state = 'SESSION_CREATING'
            AND trueforge_session_id IS NULL
            AND creation_token IS NOT NULL)
          OR (state = 'SESSION_UNCERTAIN'
            AND trueforge_session_id IS NULL)
          OR (state = 'SESSION_LOST'
            AND trueforge_session_id IS NOT NULL)
          OR (state IN ('READY', 'RUNNING', 'REPAIR_VERIFIED', 'FAILED'))
        ),
        FOREIGN KEY (incident_id) REFERENCES incidents (id) ON DELETE CASCADE
      );

      CREATE INDEX recovery_attempts_state_idx
        ON recovery_attempts (state, updated_at, id);
    `,
  },
];

export class SqliteDatabase {
  private isClosed = false;

  constructor(
    private readonly connection: BetterSqlite3.Database,
    readonly databasePath: string,
  ) {}

  get isOpen(): boolean {
    return !this.isClosed && this.connection.open;
  }

  exec(sql: string): void {
    this.assertOpen();
    this.connection.exec(sql);
  }

  get<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqliteParameters | null,
  ): Row | undefined {
    this.assertOpen();
    const statement = this.connection.prepare(sql);

    if (parameters === undefined || parameters === null) {
      return statement.get() as Row | undefined;
    }

    return statement.get(parameters) as Row | undefined;
  }

  all<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqliteParameters | null,
  ): Row[] {
    this.assertOpen();
    const statement = this.connection.prepare(sql);

    if (parameters === undefined || parameters === null) {
      return statement.all() as Row[];
    }

    return statement.all(parameters) as Row[];
  }

  run(
    sql: string,
    parameters?: SqliteParameters | null,
  ): BetterSqlite3.RunResult {
    this.assertOpen();
    const statement = this.connection.prepare(sql);

    if (parameters === undefined || parameters === null) {
      return statement.run();
    }

    return statement.run(parameters);
  }

  transaction<T>(
    operation: () => T,
    mode: SqliteTransactionMode = "deferred",
  ): T {
    this.assertOpen();
    const transaction = this.connection.transaction(operation);

    return mode === "immediate"
      ? transaction.immediate()
      : transaction();
  }

  pragma(
    statement: string,
    options?: BetterSqlite3.PragmaOptions,
  ): unknown {
    this.assertOpen();
    return this.connection.pragma(statement, options);
  }

  close(): void {
    if (this.isClosed) {
      return;
    }

    this.connection.close();
    this.isClosed = true;
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw new Error("The SQLite database is closed.");
    }
  }
}

const trueforgeSessionBindingColumns = [
  "incident_id",
  "state",
  "trueforge_session_id",
  "creation_token",
  "coordinator_spec_version",
  "created_at",
  "updated_at",
] as const;

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hasTable(database: SqliteDatabase, tableName: string): boolean {
  return (
    database.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName],
    ) !== undefined
  );
}

function repairTrueForgeSessionBindings(database: SqliteDatabase): void {
  const tableName = "trueforge_session_bindings";
  if (!hasTable(database, tableName)) {
    database.exec(trueforgeSessionBindingsTableSql);
    return;
  }

  const legacyColumns = new Set(
    database
      .all<{ name: string }>(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`)
      .map((column) => column.name.toLowerCase()),
  );
  const requiredLegacyColumns = [
    "incident_id",
    "state",
    "created_at",
    "updated_at",
  ];
  const missingColumns = requiredLegacyColumns.filter(
    (column) => !legacyColumns.has(column),
  );

  if (missingColumns.length > 0) {
    throw new Error(
      `Cannot safely repair trueforge_session_bindings; missing columns: ${missingColumns.join(", ")}.`,
    );
  }

  if (!legacyColumns.has("coordinator_spec_version")) {
    const legacyRowCount = database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(tableName)}`,
    )?.count;

    if (legacyRowCount !== 0) {
      throw new Error(
        "Cannot safely repair trueforge_session_bindings; coordinator_spec_version is missing from a nonempty legacy table.",
      );
    }
  }

  const legacyTableName = "trueforge_session_bindings_v4_legacy";
  if (hasTable(database, legacyTableName)) {
    throw new Error(
      "Cannot safely repair trueforge_session_bindings; a legacy repair table already exists.",
    );
  }

  database.exec(
    `ALTER TABLE ${quoteSqlIdentifier(tableName)} RENAME TO ${quoteSqlIdentifier(legacyTableName)};`,
  );
  database.exec(trueforgeSessionBindingsTableSql);

  const sourceExpressions = trueforgeSessionBindingColumns.map((column) =>
    legacyColumns.has(column) ? quoteSqlIdentifier(column) : "NULL",
  );
  database.exec(`
    INSERT INTO ${quoteSqlIdentifier(tableName)} (
      ${trueforgeSessionBindingColumns.map(quoteSqlIdentifier).join(", ")}
    )
    SELECT ${sourceExpressions.join(", ")}
    FROM ${quoteSqlIdentifier(legacyTableName)};
  `);
  database.exec(`DROP TABLE ${quoteSqlIdentifier(legacyTableName)};`);
}

function migrateM27BProvenanceConstraints(database: SqliteDatabase): void {
  database.exec(`
    ALTER TABLE provider_evidence
      ADD COLUMN application_connection_id TEXT
      REFERENCES application_connections (id)
      ON DELETE RESTRICT;
    CREATE INDEX provider_evidence_application_connection_idx
      ON provider_evidence (application_connection_id);
    UPDATE provider_evidence
    SET application_connection_id = (
      SELECT application_connection_id
      FROM incidents
      WHERE incidents.id = provider_evidence.incident_id
    )
    WHERE provider_evidence.application_connection_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM incidents
        WHERE incidents.id = provider_evidence.incident_id
          AND incidents.application_connection_id IS NOT NULL
      );
  `);

  // Migration 10 briefly made tool_response_event_id globally unique. Rebuild
  // the small append-only table so the identity is correctly scoped to a
  // TrueForge session while preserving every existing observation.
  const tableName = "receiver_observations";
  const legacyTableName = "receiver_observations_v10_legacy";
  if (hasTable(database, legacyTableName)) {
    throw new Error(
      "Cannot safely migrate receiver observations; a legacy migration table already exists.",
    );
  }

  database.exec(`
    DROP INDEX IF EXISTS receiver_observations_incident_idx;
    DROP INDEX IF EXISTS receiver_observations_delivery_idx;
    ALTER TABLE ${quoteSqlIdentifier(tableName)}
      RENAME TO ${quoteSqlIdentifier(legacyTableName)};
  `);
  database.exec(receiverObservationsTableSql);
  database.exec(`
    INSERT INTO ${quoteSqlIdentifier(tableName)} (
      id,
      incident_id,
      application_connection_id,
      delivery_guid,
      capability,
      tool,
      mcp_server_name,
      mutation_count,
      business_state,
      observed_at,
      trueforge_session_id,
      turn_id,
      receiver_investigator_thread_id,
      thread_created_event_id,
      tool_call_id,
      tool_call_event_id,
      tool_response_event_id,
      tool_response_created_at,
      observation_json,
      created_at
    )
    SELECT
      id,
      incident_id,
      application_connection_id,
      delivery_guid,
      capability,
      tool,
      mcp_server_name,
      mutation_count,
      business_state,
      observed_at,
      trueforge_session_id,
      turn_id,
      receiver_investigator_thread_id,
      thread_created_event_id,
      tool_call_id,
      tool_call_event_id,
      tool_response_event_id,
      tool_response_created_at,
      observation_json,
      created_at
    FROM ${quoteSqlIdentifier(legacyTableName)};
    DROP TABLE ${quoteSqlIdentifier(legacyTableName)};
  `);
}

export function initializeDatabase(database: SqliteDatabase): void {
  // BEGIN IMMEDIATE obtains SQLite's write reservation before any migration
  // state is read. Every opener therefore re-checks state after waiting for
  // the previous opener to commit.
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of migrations) {
      const applied = database.get<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = ?",
        [migration.version],
      );

      if (applied !== undefined) {
        continue;
      }

      if (migration.apply !== undefined) {
        migration.apply(database);
      } else if (migration.sql !== undefined) {
        database.exec(migration.sql);
      } else {
        throw new Error(`Migration ${migration.version} has no operation.`);
      }
      database.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [migration.version, new Date().toISOString()],
      );
    }
  }, "immediate");
}

export function openDatabase(databasePath: string): SqliteDatabase {
  if (databasePath.trim().length === 0) {
    throw new Error("A SQLite database path is required.");
  }

  const resolvedDatabasePath =
    databasePath === ":memory:"
      ? databasePath
      : path.resolve(databasePath);

  if (resolvedDatabasePath !== ":memory:") {
    mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  }

  const connection = new BetterSqlite3(resolvedDatabasePath, {
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  const database = new SqliteDatabase(connection, resolvedDatabasePath);

  try {
    // WAL lets readers continue while another process/thread holds the write
    // lock; timeout lets SQLite wait for that short-lived writer lock.
    database.pragma("journal_mode = WAL");
    // This is connection-local and keeps future relational migrations safe.
    database.pragma("foreign_keys = ON");
    initializeDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

interface ConfiguredDatabaseState {
  databasePath: string;
  database: SqliteDatabase;
}

interface RedriveGlobalState {
  __redriveConfiguredDatabase?: ConfiguredDatabaseState;
}

const redriveGlobalState = globalThis as typeof globalThis &
  RedriveGlobalState;

function normalizeDatabasePath(databasePath: string): string {
  if (databasePath.trim().length === 0) {
    throw new Error("A SQLite database path is required.");
  }

  return databasePath === ":memory:"
    ? databasePath
    : path.resolve(databasePath);
}

/**
 * The application uses one native handle for its configured path. Keeping the
 * state on globalThis prevents Next.js development re-evaluation from opening
 * another handle for the same process and path.
 */
export function getConfiguredDatabase(
  databasePath: string,
): SqliteDatabase {
  const normalizedDatabasePath = normalizeDatabasePath(databasePath);
  const current = redriveGlobalState.__redriveConfiguredDatabase;

  if (
    current?.database.isOpen &&
    current.databasePath === normalizedDatabasePath
  ) {
    return current.database;
  }

  if (current !== undefined) {
    current.database.close();
  }

  const database = openDatabase(normalizedDatabasePath);
  redriveGlobalState.__redriveConfiguredDatabase = {
    databasePath: normalizedDatabasePath,
    database,
  };

  return database;
}

export function closeConfiguredDatabase(databasePath?: string): void {
  const current = redriveGlobalState.__redriveConfiguredDatabase;

  if (current === undefined) {
    return;
  }

  if (
    databasePath !== undefined &&
    normalizeDatabasePath(databasePath) !== current.databasePath
  ) {
    return;
  }

  current.database.close();
  redriveGlobalState.__redriveConfiguredDatabase = undefined;
}

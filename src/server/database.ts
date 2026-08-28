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

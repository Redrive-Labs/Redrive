import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

type SqliteValue = bigint | Buffer | null | number | string;
type SqliteParameters =
  | readonly SqliteValue[]
  | Record<string, SqliteValue>;

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface Migration {
  version: number;
  sql: string;
}

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

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    return this.connection.transaction(operation)();
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

export function initializeDatabase(database: SqliteDatabase): void {
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

    database.transaction(() => {
      database.exec(migration.sql);
      database.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [migration.version, new Date().toISOString()],
      );
    });
  }
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

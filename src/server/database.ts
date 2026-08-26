import initSqlJs, {
  type Database as SqlJsDatabase,
  type Statement,
} from "sql.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type SqliteValue = number | string | Uint8Array | null;
type SqliteParameters =
  | SqliteValue[]
  | Record<string, SqliteValue>
  | null;

let sqlJsPromise: ReturnType<typeof initSqlJs> | undefined;

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

async function loadSqlJs() {
  sqlJsPromise ??= initSqlJs({
    locateFile: (file) =>
      path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
  });

  return sqlJsPromise;
}

export class SqliteDatabase {
  private isClosed = false;

  constructor(
    private readonly connection: SqlJsDatabase,
    private readonly databasePath: string,
  ) {}

  exec(sql: string, parameters?: SqliteParameters) {
    return this.connection.exec(sql, parameters);
  }

  prepare(sql: string): Statement {
    return this.connection.prepare(sql);
  }

  run(sql: string, parameters?: SqliteParameters): void {
    this.connection.run(sql, parameters);
  }

  close(): void {
    if (this.isClosed) {
      return;
    }

    try {
      this.persist();
    } finally {
      this.connection.close();
      this.isClosed = true;
    }
  }

  persist(): void {
    if (this.databasePath === ":memory:") {
      return;
    }

    writeFileSync(this.databasePath, this.connection.export());
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
    const applied = database.exec(
      "SELECT 1 FROM schema_migrations WHERE version = ?",
      [migration.version],
    );

    if (applied.length > 0) {
      continue;
    }

    database.exec("BEGIN");

    try {
      database.exec(migration.sql);
      database.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [migration.version, new Date().toISOString()],
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export async function openDatabase(
  databasePath: string,
): Promise<SqliteDatabase> {
  if (databasePath.trim().length === 0) {
    throw new Error("A SQLite database path is required.");
  }

  if (databasePath !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const SqlJs = await loadSqlJs();
  const databaseData =
    databasePath !== ":memory:" && existsSync(databasePath)
      ? new Uint8Array(readFileSync(databasePath))
      : undefined;
  const database = new SqliteDatabase(
    new SqlJs.Database(databaseData),
    databasePath,
  );

  try {
    database.exec("PRAGMA foreign_keys = ON");
    initializeDatabase(database);
    database.persist();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

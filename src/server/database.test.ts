import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeConfiguredDatabase,
  getConfiguredDatabase,
  initializeDatabase,
  openDatabase,
  type SqliteDatabase,
} from "@/server/database";

const concurrentWriterSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  const Database = require("better-sqlite3");

  let database;

  try {
    database = new Database(workerData.databasePath, { timeout: 5000 });
    const result = database.prepare(\`
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
    \`).run(workerData);

    parentPort.postMessage({
      ok: true,
      changes: result.changes,
      externalDeliveryId: workerData.externalDeliveryId,
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: error && typeof error === "object" && "code" in error
        ? error.code
        : undefined,
    });
  } finally {
    if (database?.open) {
      database.close();
    }
  }
`;

interface ConcurrentWriterResult {
  ok: boolean;
  changes?: number;
  externalDeliveryId?: string;
  error?: string;
  code?: string;
}

interface DatabaseOpenerResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

function runConcurrentWriter(
  databasePath: string,
  index: number,
): Promise<ConcurrentWriterResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(concurrentWriterSource, {
      eval: true,
      workerData: {
        databasePath,
        id: `concurrent-incident-${index}`,
        provider: "concurrency-test",
        externalDeliveryId: `concurrent-delivery-${index}`,
        repositoryId: "test/receiver",
        status: "OPEN",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    worker.once("message", (message: ConcurrentWriterResult) => {
      resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Concurrent writer exited with code ${code}.`));
      }
    });
  });
}

function compileDatabaseModule(
  databaseModulePath: string,
  outputDirectory: string,
): string {
  const source = readFileSync(databaseModulePath, "utf8");
  const compiled = transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ModuleKind.CommonJS,
      target: ScriptTarget.ES2022,
    },
  });
  const compiledModulePath = path.join(
    outputDirectory,
    ".database-race.cjs",
  );

  writeFileSync(compiledModulePath, compiled.outputText);
  return compiledModulePath;
}

function runIndependentDatabaseOpener(
  compiledModulePath: string,
  databasePath: string,
): Promise<DatabaseOpenerResult> {
  const source = `
    const { openDatabase } = require(process.argv[1]);
    const database = openDatabase(process.argv[2]);

    try {
      process.stdout.write(JSON.stringify({
        migrationVersions: database
          .all("SELECT version FROM schema_migrations ORDER BY version")
          .map((row) => row.version),
        incidentCount: database
          .get("SELECT COUNT(*) AS count FROM incidents")
          .count,
      }));
    } finally {
      database.close();
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      source,
      compiledModulePath,
      databasePath,
    ], {
      env: {
        ...process.env,
        NODE_PATH: path.join(process.cwd(), "node_modules"),
        NODE_NO_WARNINGS: "1",
      },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });
}

describe("native SQLite persistence", () => {
  let testDirectory: string;
  let databasePath: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    testDirectory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-database-test-"),
    );
    databasePath = path.join(testDirectory, "incidents.sqlite");
    database = openDatabase(databasePath);
  });

  afterEach(() => {
    database.close();

    const resolvedDirectory = path.resolve(testDirectory);
    const temporaryRoot = path.resolve(os.tmpdir());
    const isIsolatedTestDirectory =
      path.dirname(resolvedDirectory) === temporaryRoot &&
      path.basename(resolvedDirectory).startsWith("redrive-database-test-");

    if (!isIsolatedTestDirectory) {
      throw new Error("Refusing to remove a non-test directory.");
    }

    rmSync(resolvedDirectory, { recursive: true, force: false });
  });

  it("uses a test database path separate from the development database", () => {
    const developmentDatabasePath = path.resolve(
      process.cwd(),
      ".local",
      "redrive.sqlite",
    );

    expect(database.databasePath).toBe(path.resolve(databasePath));
    expect(database.databasePath).not.toBe(developmentDatabasePath);
    expect(existsSync(database.databasePath)).toBe(true);
  });

  it("reuses one configured handle until it is explicitly closed", () => {
    const configuredDatabase = getConfiguredDatabase(databasePath);

    expect(getConfiguredDatabase(databasePath)).toBe(configuredDatabase);

    closeConfiguredDatabase(databasePath);
    expect(configuredDatabase.isOpen).toBe(false);
  });

  it("applies deterministic SQLite pragmas", () => {
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("rolls back every statement when a transaction fails", () => {
    database.exec(`
      CREATE TABLE rollback_probe (
        id TEXT PRIMARY KEY NOT NULL
      );
    `);

    expect(() => {
      database.transaction(() => {
        database.run("INSERT INTO rollback_probe (id) VALUES (?)", [
          "first",
        ]);
        database.run("INSERT INTO rollback_probe (id) VALUES (?)", [
          "second",
        ]);
        database.run("INSERT INTO rollback_probe (id) VALUES (?)", [
          "first",
        ]);
      });
    }).toThrow();

    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rollback_probe",
      )?.count,
    ).toBe(0);
  });

  it("is safe to reopen an already-migrated database", () => {
    database.close();
    database = openDatabase(databasePath);
    initializeDatabase(database);

    expect(
      database.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      ),
    ).toEqual([{ version: 1 }]);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM incidents",
      )?.count,
    ).toBe(0);
  });

  it("serializes migration initialization across independent processes", async () => {
    const freshDatabasePath = path.join(
      testDirectory,
      "fresh-shared.sqlite",
    );
    expect(existsSync(freshDatabasePath)).toBe(false);

    const compiledModulePath = compileDatabaseModule(
      path.join(process.cwd(), "src", "server", "database.ts"),
      testDirectory,
    );
    const openerCount = 8;

    const results = await Promise.all(
      Array.from({ length: openerCount }, () =>
        runIndependentDatabaseOpener(
          compiledModulePath,
          freshDatabasePath,
        ),
      ),
    );

    expect(
      results.map((result) => ({
        code: result.code,
        signal: result.signal,
      })),
    ).toEqual(
      Array.from({ length: openerCount }, () => ({
        code: 0,
        signal: null,
      })),
    );
    expect(
      results.map((result) => JSON.parse(result.stdout)),
    ).toEqual(
      Array.from({ length: openerCount }, () => ({
        migrationVersions: [1],
        incidentCount: 0,
      })),
    );

    const verificationDatabase = openDatabase(freshDatabasePath);
    try {
      expect(
        verificationDatabase.all<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        ),
      ).toEqual([{ version: 1 }]);
      expect(
        verificationDatabase.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      verificationDatabase.close();
    }
  });

  it("preserves all writes from concurrent native SQLite writers", async () => {
    const writerCount = 20;
    const results = await Promise.all(
      Array.from({ length: writerCount }, (_, index) =>
        runConcurrentWriter(databasePath, index),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.every((result) => result.changes === 1)).toBe(true);

    const rows = database.all<{ external_delivery_id: string }>(
      "SELECT external_delivery_id FROM incidents ORDER BY external_delivery_id",
    );
    const externalDeliveryIds = rows.map(
      (row) => row.external_delivery_id,
    );

    expect(rows).toHaveLength(writerCount);
    expect(new Set(externalDeliveryIds).size).toBe(writerCount);
    expect(externalDeliveryIds).toEqual(
      Array.from(
        { length: writerCount },
        (_, index) => `concurrent-delivery-${index}`,
      ).sort(),
    );
  });
});

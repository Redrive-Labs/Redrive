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
import BetterSqlite3 from "better-sqlite3";
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

const concurrentDuplicateWriterSource = `
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
      ON CONFLICT (provider, repository_id, external_delivery_id) DO NOTHING
    \`).run(workerData);
    const row = database.prepare(\`
      SELECT id
      FROM incidents
      WHERE provider = @provider
        AND repository_id = @repositoryId
        AND external_delivery_id = @externalDeliveryId
    \`).get(workerData);

    parentPort.postMessage({
      ok: row !== undefined,
      changes: result.changes,
      id: row?.id,
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
  id?: string;
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

function runConcurrentDuplicateWriter(
  databasePath: string,
  index: number,
): Promise<ConcurrentWriterResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(concurrentDuplicateWriterSource, {
      eval: true,
      workerData: {
        databasePath,
        id: `duplicate-incident-${index}`,
        provider: "concurrency-test",
        externalDeliveryId: "concurrent-shared-delivery",
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
        reject(new Error(`Concurrent duplicate writer exited with code ${code}.`));
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


function installRecordedMalformedV4BindingTable(
  database: SqliteDatabase,
): void {
  database.exec("DROP TABLE IF EXISTS incident_workflow_events");
  database.exec("DROP TABLE trueforge_session_bindings");
  // Keep M2.6A migration 7 recorded while replaying the M2.5 v4-v6
  // repair sequence against a database that already has the new schema.
  database.run("DELETE FROM schema_migrations WHERE version BETWEEN ? AND ?", [4, 6]);
  database.exec(`
    CREATE TABLE trueforge_session_bindings (
      incident_id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN ('CREATING', 'CREATION_UNCERTAIN', 'ACTIVE', 'LOST')
      ),
      trueforge_session_id TEXT UNIQUE,
      creation_token TEXT,
      T NULL,
      updated_at TEXT N coordinator_spec_version TEXT NOT NULL,
      created_at TEXT NOOT NULL,
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
  `);
  database.run(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    [4, "2026-01-01T00:00:00.000Z"],
  );
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

  it("creates the approved TrueForge binding schema and constraints on a fresh database", () => {
    const columns = database.all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>("PRAGMA table_info('trueforge_session_bindings')");

    expect(
      columns.map(({ name, type, notnull, pk }) => ({
        name,
        type,
        notnull,
        pk,
      })),
    ).toEqual([
      { name: "incident_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      { name: "trueforge_session_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "creation_token", type: "TEXT", notnull: 0, pk: 0 },
      {
        name: "coordinator_spec_version",
        type: "TEXT",
        notnull: 1,
        pk: 0,
      },
      { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    ]);

    expect(
      database.all<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>("PRAGMA foreign_key_list('trueforge_session_bindings')").map(
        ({ table, from, to, on_delete }) => ({ table, from, to, on_delete }),
      ),
    ).toEqual([
      {
        table: "incidents",
        from: "incident_id",
        to: "id",
        on_delete: "CASCADE",
      },
    ]);

    const insertIncident = (id: string) => {
      database.run(
        `
          INSERT INTO incidents (
            id,
            provider,
            external_delivery_id,
            repository_id,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          "github",
          `delivery-${id}`,
          "example/receiver",
          "OPEN",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ],
      );
    };
    const insertBinding = (
      incidentId: string,
      state: string,
      trueForgeSessionId: string | null,
      creationToken: string | null,
    ) => {
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          incidentId,
          state,
          trueForgeSessionId,
          creationToken,
          "v1",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ],
      );
    };

    insertIncident("binding-creating");
    insertBinding("binding-creating", "CREATING", null, "token-1");
    expect(() =>
      insertBinding("binding-creating", "CREATING", null, "token-2"),
    ).toThrow();

    insertIncident("binding-uncertain");
    insertBinding("binding-uncertain", "CREATION_UNCERTAIN", null, null);
    insertIncident("binding-active");
    insertBinding("binding-active", "ACTIVE", "session-1", null);
    insertIncident("binding-lost");
    insertBinding("binding-lost", "LOST", "session-2", null);

    insertIncident("binding-duplicate-session");
    expect(() =>
      insertBinding("binding-duplicate-session", "ACTIVE", "session-1", null),
    ).toThrow();

    insertIncident("binding-invalid-state");
    expect(() =>
      insertBinding("binding-invalid-state", "UNKNOWN", null, null),
    ).toThrow();

    insertIncident("binding-invalid-creating");
    expect(() =>
      insertBinding("binding-invalid-creating", "CREATING", "session-3", "token-3"),
    ).toThrow();

    insertIncident("binding-invalid-active");
    expect(() =>
      insertBinding("binding-invalid-active", "ACTIVE", null, null),
    ).toThrow();

    expect(() =>
      insertBinding("missing-incident", "CREATING", null, "token-4"),
    ).toThrow();
  });

  it("repairs an empty table from the recorded malformed v4 schema", () => {
    installRecordedMalformedV4BindingTable(database);

    initializeDatabase(database);

    expect(
      database.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      ),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 }, { version: 8 },
    ]);
    expect(
      database.all<{ name: string }>(
        "PRAGMA table_info('trueforge_session_bindings')",
      ).map(({ name }) => name),
    ).toEqual([
      "incident_id",
      "state",
      "trueforge_session_id",
      "creation_token",
      "coordinator_spec_version",
      "created_at",
      "updated_at",
    ]);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM trueforge_session_bindings",
      )?.count,
    ).toBe(0);
  });

  it("fails closed for nonempty malformed v4 data without losing rows", () => {
    const incidentId = "legacy-binding-incident";
    database.run(
      `
        INSERT INTO incidents (
          id,
          provider,
          external_delivery_id,
          repository_id,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        incidentId,
        "github",
        "legacy-binding-delivery",
        "example/receiver",
        "OPEN",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );
    installRecordedMalformedV4BindingTable(database);
    database.run(
      `
        INSERT INTO trueforge_session_bindings (
          incident_id,
          state,
          trueforge_session_id,
          creation_token,
          updated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        incidentId,
        "ACTIVE",
        "legacy-session",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );

    const legacyColumns = database.all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>("PRAGMA table_info('trueforge_session_bindings')");
    const legacyRows = database.all(
      "SELECT * FROM trueforge_session_bindings",
    );

    expect(() => initializeDatabase(database)).toThrow(
      "coordinator_spec_version is missing from a nonempty legacy table",
    );

    expect(
      database.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      ),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 7 }, { version: 8 },
    ]);
    expect(
      database.all<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>("PRAGMA table_info('trueforge_session_bindings')"),
    ).toEqual(legacyColumns);
    expect(
      database.all("SELECT * FROM trueforge_session_bindings"),
    ).toEqual(legacyRows);
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

  it("fails closed without deleting duplicate legacy incidents", () => {
    database.exec("DROP INDEX incidents_delivery_identity_idx");
    database.run("DELETE FROM schema_migrations WHERE version = ?", [2]);

    for (const id of ["legacy-incident-a", "legacy-incident-b"]) {
      database.run(
        `
          INSERT INTO incidents (
            id,
            provider,
            external_delivery_id,
            repository_id,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          "github",
          "legacy-duplicate-delivery",
          "example/receiver",
          "OPEN",
          "2025-01-01T00:00:00.000Z",
          "2025-01-01T00:00:00.000Z",
        ],
      );
    }

    expect(() => openDatabase(databasePath)).toThrow();
    expect(
      database.all<{ id: string }>(
        "SELECT id FROM incidents ORDER BY id",
      ),
    ).toEqual([
      { id: "legacy-incident-a" },
      { id: "legacy-incident-b" },
    ]);
    expect(
      database.get<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = ?",
        [2],
      ),
    ).toBeUndefined();
  });

  it("is safe to reopen an already-migrated database", () => {
    database.close();
    database = openDatabase(databasePath);
    initializeDatabase(database);

    expect(
      database.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      ),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 }, { version: 8 },
    ]);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM incidents",
      )?.count,
    ).toBe(0);
  });

  it("upgrades a populated migration-6 M2.5 database without rewriting its durable rows", () => {
    const legacyPath = path.join(testDirectory, "m2-5-populated.sqlite");
    const legacy = new BetterSqlite3(legacyPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
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
      CREATE UNIQUE INDEX incidents_delivery_identity_idx
        ON incidents (provider, repository_id, external_delivery_id);
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
      INSERT INTO incidents
        (id, provider, external_delivery_id, repository_id, status, created_at, updated_at)
      VALUES
        ('legacy-incident', 'github', 'legacy-delivery', 'octocat/receiver', 'OPEN', '2026-01-01', '2026-01-01');
      INSERT INTO provider_evidence
        (incident_id, schema_version, provider, provider_delivery_id, delivery_guid,
         outcome_status, status_code, delivered_at, canonical_payload_sha256,
         evidence_json, captured_at)
      VALUES
        ('legacy-incident', 1, 'github', 'legacy-delivery', 'legacy-guid',
         'Invalid HTTP Response: 500', 500, '2026-01-01T00:00:00.000Z', 'hash-1',
         '{"provider":"github","status_code":500}', '2026-01-01T00:01:00.000Z');
      INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token,
         coordinator_spec_version, created_at, updated_at)
      VALUES
        ('legacy-incident', 'ACTIVE', 'session-1', NULL, 'v2', '2026-01-01', '2026-01-01');
      INSERT INTO incident_workflow_events
        (id, incident_id, event_type, trueforge_session_id, turn_id,
         provider_investigator_thread_id, trueforge_event_id, tool_call_id,
         occurred_at, details_json)
      VALUES
        ('workflow-1', 'legacy-incident', 'PROVIDER_EVIDENCE_CAPTURED', 'session-1',
         'turn-1', 'provider-thread-1', 'trueforge-event-1', 'tool-call-1',
         '2026-01-01T00:02:00.000Z', '{"providerDeliveryId":"legacy-delivery"}');
      INSERT INTO schema_migrations (version, applied_at) VALUES
        (1, '2026-01-01'), (2, '2026-01-01'), (3, '2026-01-01'),
        (4, '2026-01-01'), (5, '2026-01-01'), (6, '2026-01-01');
    `);
    const before = {
      incident: legacy.prepare("SELECT * FROM incidents").get() as Record<string, unknown>,
      evidence: legacy.prepare("SELECT * FROM provider_evidence").get() as Record<string, unknown>,
      binding: legacy.prepare("SELECT * FROM trueforge_session_bindings").get() as Record<string, unknown>,
      workflow: legacy.prepare("SELECT * FROM incident_workflow_events").get() as Record<string, unknown>,
    };
    legacy.close();

    const upgraded = openDatabase(legacyPath);
    try {
      expect(upgraded.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )).toEqual([
        { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 },
        { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 },
      ]);
      expect(upgraded.get("SELECT * FROM incidents")).toEqual({
        ...before.incident,
        application_connection_id: null,
      });
      expect(upgraded.get("SELECT * FROM provider_evidence")).toEqual(before.evidence);
      expect(upgraded.get("SELECT * FROM trueforge_session_bindings")).toEqual(before.binding);
      expect(upgraded.get("SELECT * FROM incident_workflow_events")).toEqual(before.workflow);
    } finally {
      upgraded.close();
    }
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
        migrationVersions: [1, 2, 3, 4, 5, 6, 7, 8],
        incidentCount: 0,
      })),
    );

    const verificationDatabase = openDatabase(freshDatabasePath);
    try {
      expect(
        verificationDatabase.all<{ version: number }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        ),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 }, { version: 8 },
      ]);
      expect(
        verificationDatabase.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      verificationDatabase.close();
    }
  });

  it("converges concurrent duplicate writers from independent connections", async () => {
    const writerCount = 10;
    const results = await Promise.all(
      Array.from({ length: writerCount }, (_, index) =>
        runConcurrentDuplicateWriter(databasePath, index),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.changes === 1)).toHaveLength(1);
    expect(
      results.every(
        (result) => result.changes === 0 || result.changes === 1,
      ),
    ).toBe(true);

    const ids = results.map((result) => result.id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toEqual(expect.any(String));
    expect(
      database.get<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM incidents
          WHERE provider = ?
            AND repository_id = ?
            AND external_delivery_id = ?
        `,
        [
          "concurrency-test",
          "test/receiver",
          "concurrent-shared-delivery",
        ],
      )?.count,
    ).toBe(1);
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

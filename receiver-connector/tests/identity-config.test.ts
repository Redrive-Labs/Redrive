import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  connectorIdentityPath,
  loadOrCreateIdentity,
  markEnrollmentAcknowledged,
} from "../src/identity.js";

const filesystemTestState = vi.hoisted(() => ({ failRename: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (filesystemTestState.failRename) throw new Error("replacement failed");
      return actual.renameSync(...args);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  filesystemTestState.failRename = false;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-connector-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function environment(stateDir: string, token?: string): Record<string, string> {
  return {
    REDRIVE_URL: "https://redrive.test:4317",
    ...(token === undefined ? {} : { REDRIVE_ENROLLMENT_TOKEN: token }),
    REDRIVE_OBSERVER_DATABASE_URL: "postgresql://127.0.0.1:5434/receiver",
    REDRIVE_RECEIVER_HEALTH_URL: "http://127.0.0.1:3000/health",
    REDRIVE_CONNECTOR_STATE_DIR: stateDir,
  };
}

describe("receiver connector configuration and identity", () => {
  it("accepts a remote HTTPS Redrive origin and keeps enrollment optional", () => {
    const config = loadConfig(environment(temporaryDirectory()));
    expect(config.redriveUrl).toBe("https://redrive.test:4317");
    expect(config.enrollmentToken).toBeUndefined();
  });

  it.each([
    "http://localhost:4317",
    "http://127.0.0.1:4317",
    "http://[::1]:4317",
  ])("accepts local HTTP Redrive origin %s", (redriveUrl) => {
    expect(loadConfig({ ...environment(temporaryDirectory()), REDRIVE_URL: redriveUrl }).redriveUrl)
      .toBe(redriveUrl);
  });

  it.each([
    "http://redrive.test:4317",
    "https://user@redrive.test:4317",
    "https://user:password@redrive.test:4317",
    "https://redrive.test:4317/path",
    "https://redrive.test:4317?query=value",
    "https://redrive.test:4317#fragment",
  ])("rejects unsafe or non-origin Redrive URL %s", (redriveUrl) => {
    expect(() => loadConfig({ ...environment(temporaryDirectory()), REDRIVE_URL: redriveUrl }))
      .toThrowError(/REDRIVE_URL/);
  });

  it("persists a high-entropy identity before returning it and uses restrictive permissions", () => {
    const stateDir = temporaryDirectory();
    const first = loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });
    const state = JSON.parse(readFileSync(first.identityPath, "utf8")) as Record<string, unknown>;

    expect(first.created).toBe(true);
    expect(first.enrollmentAcknowledged).toBe(false);
    expect(state).toEqual({
      schemaVersion: 2,
      serverOrigin: "http://redrive.test:4317",
      connectorId: "connector-id",
      connectorSecret: "connector-secret",
      enrollmentAcknowledged: false,
    });
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(first.identityPath).mode & 0o777).toBe(0o600);
  });

  it("reuses the exact persisted identity on restart without an enrollment token", () => {
    const stateDir = temporaryDirectory();
    const first = loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });
    const second = loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
      generator: {
        connectorId: () => "should-not-be-used",
        connectorSecret: () => "should-not-be-used",
      },
    });

    expect(second.created).toBe(false);
    expect(second.enrollmentAcknowledged).toBe(false);
    expect(second.identity).toEqual(first.identity);
  });

  it("fails closed for malformed state and a server-origin mismatch", () => {
    const stateDir = temporaryDirectory();
    const identityPath = connectorIdentityPath(stateDir);
    loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });
    writeFileSync(identityPath, "{not-json", "utf8");
    expect(() => loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
    })).toThrowError(/malformed/i);

    writeFileSync(identityPath, JSON.stringify({
      schemaVersion: 1,
      serverOrigin: "http://another-redrive.test:4317",
      connectorId: "connector-id",
      connectorSecret: "connector-secret",
    }), "utf8");
    expect(() => loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
    })).toThrowError(/another server origin/i);
  });

  it("does not persist the enrollment token or log the connector secret", () => {
    const stateDir = temporaryDirectory();
    const secret = "connector-secret-that-must-not-be-logged";
    const token = "bootstrap-token-that-must-not-be-persisted";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const config = loadConfig(environment(stateDir, token));
    const identity = loadOrCreateIdentity({
      stateDir: config.connectorStateDir,
      serverOrigin: config.redriveUrl,
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => secret,
      },
    });

    expect(readFileSync(identity.identityPath, "utf8")).not.toContain(token);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(secret));
  });

  it("repairs existing permissions without changing identity contents", () => {
    const stateDir = temporaryDirectory();
    const first = loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });
    chmodSync(first.identityPath, 0o644);
    const second = loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
    });
    expect(second.identity).toEqual(first.identity);
    expect(statSync(first.identityPath).mode & 0o777).toBe(0o600);
  });

  it("preserves the previous identity when atomic replacement fails", () => {
    const stateDir = temporaryDirectory();
    const first = loadOrCreateIdentity({
      stateDir,
      serverOrigin: "http://redrive.test:4317",
      generator: {
        connectorId: () => "connector-id",
        connectorSecret: () => "connector-secret",
      },
    });
    const previousContents = readFileSync(first.identityPath, "utf8");
    filesystemTestState.failRename = true;

    expect(() => markEnrollmentAcknowledged(first)).toThrowError(/persisted/i);
    expect(readFileSync(first.identityPath, "utf8")).toBe(previousContents);
  });
});

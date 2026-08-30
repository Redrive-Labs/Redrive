import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  buildGithubAppManifest,
  claimInstallationAttempt,
  claimManifestAttempt,
  completeManifestAttempt,
  createInstallationAttempt,
  createManifestAttempt,
  getGithubAppRegistration,
  markManifestAttemptRecovery,
  INSTALLATION_CLAIM_STALE_AFTER_MS,
  MANIFEST_ATTEMPT_TTL_MS,
  MANIFEST_CLAIM_STALE_AFTER_MS,
  parseManifestConversion,
  recordManifestConversionCheckpoint,
} from "@/server/github/github-app-service";
import { manifestPrivateKeyReference } from "@/server/infrastructure/secret-store";
import { openDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { GithubIntegrationStateError } from "@/domain/github-integration";

describe("GitHub App manifest state machine", () => {
  const resources: Array<{ directory: string; database: SqliteDatabase }> = [];
  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function fixture(): { directory: string; database: SqliteDatabase } {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-app-test-"));
    const database = openDatabase(path.join(directory, "records.sqlite"));
    const resource = { directory, database };
    resources.push(resource);
    return resource;
  }

  it("builds the exact minimum private-app manifest", () => {
    expect(buildGithubAppManifest("https://redrive.example")).toEqual(
      expect.objectContaining({
        url: "https://redrive.example",
        hook_attributes: {
          url: "https://redrive.example/api/integrations/github/app-webhook-disabled",
          active: false,
        },
        redirect_url: "https://redrive.example/api/integrations/github/app-manifest/callback",
        setup_url: "https://redrive.example/api/integrations/github/install/callback",
        setup_on_update: true,
        public: false,
        default_permissions: { contents: "read", repository_hooks: "write" },
        default_events: [],
        request_oauth_on_install: false,
      }),
    );
    const manifest = buildGithubAppManifest("https://redrive.example");
    expect(Object.keys(manifest.default_permissions)).toEqual(["contents", "repository_hooks"]);
  });

  it("stores only a hash, expires within one hour, and claims once", () => {
    const { database } = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = createManifestAttempt(
      database,
      { targetType: "personal" },
      "https://redrive.example",
      now,
    );
    expect(created.state).not.toBe(created.attempt.id);
    expect(created.attempt.expiresAt).toBe(
      new Date(now.getTime() + MANIFEST_ATTEMPT_TTL_MS).toISOString(),
    );
    expect(
      database.get<{ state_hash: string }>(
        "SELECT state_hash FROM github_manifest_attempts WHERE id = ?",
        [created.attempt.id],
      )?.state_hash,
    ).not.toBe(created.state);

    expect(claimManifestAttempt(database, created.state, now).kind).toBe("claimed");
    expect(() => claimManifestAttempt(database, created.state, now)).toThrow(
      GithubIntegrationStateError,
    );
  });

  it("allows only one claimant when two local requests race the same state", async () => {
    const { database } = fixture();
    const created = createManifestAttempt(database, { targetType: "personal" }, "https://redrive.example");
    const results = await Promise.all([
      Promise.resolve().then(() => {
        try { return claimManifestAttempt(database, created.state); } catch (error) { return error; }
      }),
      Promise.resolve().then(() => {
        try { return claimManifestAttempt(database, created.state); } catch (error) { return error; }
      }),
    ]);
    expect(results.filter((result) => !(result instanceof Error))).toHaveLength(1);
    expect(results.filter((result) => result instanceof GithubIntegrationStateError)).toHaveLength(1);
    expect(database.get<{ status: string }>("SELECT status FROM github_manifest_attempts WHERE id = ?", [created.attempt.id])?.status).toBe("EXCHANGING");
  });

  it("allows only one claimant across independent SQLite connections", async () => {
    const { directory, database } = fixture();
    const created = createManifestAttempt(
      database,
      { targetType: "personal" },
      "https://redrive.example",
    );
    const secondDatabase = openDatabase(path.join(directory, "records.sqlite"));
    try {
      const results = await Promise.all([
        Promise.resolve().then(() => {
          try {
            return claimManifestAttempt(database, created.state);
          } catch (error) {
            return error;
          }
        }),
        Promise.resolve().then(() => {
          try {
            return claimManifestAttempt(secondDatabase, created.state);
          } catch (error) {
            return error;
          }
        }),
      ]);

      expect(results.filter((result) => !(result instanceof Error))).toHaveLength(1);
      expect(results.filter((result) => result instanceof GithubIntegrationStateError)).toHaveLength(1);
      expect(
        secondDatabase.get<{ status: string }>(
          "SELECT status FROM github_manifest_attempts WHERE id = ?",
          [created.attempt.id],
        ),
      ).toEqual({ status: "EXCHANGING" });
    } finally {
      secondDatabase.close();
    }
  });

  it("marks an expired pending state as recovery-required rather than retrying it", () => {
    const { database } = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = createManifestAttempt(database, { targetType: "personal" }, "https://redrive.example", now);
    expect(() => claimManifestAttempt(database, created.state, new Date(now.getTime() + MANIFEST_ATTEMPT_TTL_MS + 1))).toThrow("expired");
    expect(database.get<{ status: string }>("SELECT status FROM github_manifest_attempts WHERE id = ?", [created.attempt.id])?.status).toBe("RECOVERY_REQUIRED");
    expect(claimManifestAttempt(database, created.state, now).kind).toBe("recovery");
  });

  it("moves an orphaned exchange claim to recovery instead of retrying conversion", () => {
    const { database } = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = createManifestAttempt(database, { targetType: "personal" }, "https://redrive.example", now);
    expect(claimManifestAttempt(database, created.state, now).kind).toBe("claimed");

    const stale = claimManifestAttempt(
      database,
      created.state,
      new Date(now.getTime() + MANIFEST_CLAIM_STALE_AFTER_MS + 1),
    );
    expect(stale.kind).toBe("recovery");
    expect(database.get<{ status: string }>("SELECT status FROM github_manifest_attempts WHERE id = ?", [created.attempt.id])?.status).toBe("RECOVERY_REQUIRED");
  });

  it("prevents a stale manifest worker from overwriting recovered state", () => {
    const { directory, database } = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = createManifestAttempt(
      database,
      { targetType: "personal" },
      "https://redrive.example",
      now,
    );
    expect(claimManifestAttempt(database, created.state, now).kind).toBe("claimed");
    const recoveryDatabase = openDatabase(path.join(directory, "records.sqlite"));
    try {
      expect(
        claimManifestAttempt(
          recoveryDatabase,
          created.state,
          new Date(now.getTime() + MANIFEST_CLAIM_STALE_AFTER_MS + 1),
        ).kind,
      ).toBe("recovery");
      markManifestAttemptRecovery(
        recoveryDatabase,
        created.attempt.id,
        "stale worker must not overwrite newer recovery state",
      );
      expect(
        recoveryDatabase.get<{ recovery_reason: string }>(
          "SELECT recovery_reason FROM github_manifest_attempts WHERE id = ?",
          [created.attempt.id],
        )?.recovery_reason,
      ).toBe("Manifest conversion claim became stale; manual recovery is required.");

      expect(() => completeManifestAttempt(database, created.attempt.id)).toThrow();
      expect(
        recoveryDatabase.get<{
          status: string;
          remote_github_app_id: string | null;
          remote_slug: string | null;
        }>(
          "SELECT status, remote_github_app_id, remote_slug FROM github_manifest_attempts WHERE id = ?",
          [created.attempt.id],
        ),
      ).toEqual({
        status: "RECOVERY_REQUIRED",
        remote_github_app_id: null,
        remote_slug: null,
      });
      expect(
        recoveryDatabase.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM github_app_registrations",
        )?.count,
      ).toBe(0);
    } finally {
      recoveryDatabase.close();
    }
  });

  it("parses oversized app and owner identifiers without numeric coercion", () => {
    const conversion = parseManifestConversion({
      app_id: "900719925474099312345678901234567890",
      slug: "redrive-recovery",
      owner: { id: "9007199254740993", login: "octocat", type: "User" },
      pem: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      client_secret: "must-not-be-used",
      webhook_secret: "must-not-be-used",
    });
    expect(conversion.githubAppId).toBe("900719925474099312345678901234567890");
    expect(conversion.ownerId).toBe("9007199254740993");
    expect(conversion.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("persists an App registration and never writes the PEM to its row", () => {
    const { database } = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const created = createManifestAttempt(database, { targetType: "organization", ownerLogin: "acme" }, "https://redrive.example", now);
    const claim = claimManifestAttempt(database, created.state, now);
    if (claim.kind !== "claimed") throw new Error("fixture was not claimed");
    recordManifestConversionCheckpoint(database, claim.attempt.id, {
      githubAppId: "900719925474099312345678901234567890",
      slug: "redrive-recovery",
      ownerId: "9007199254740993",
      ownerLogin: "acme",
      ownerType: "Organization",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    }, now);
    const registration = completeManifestAttempt(database, claim.attempt.id, now);
    expect(registration).toMatchObject({
      githubAppId: "900719925474099312345678901234567890",
      ownerId: "9007199254740993",
      privateKeyRef: manifestPrivateKeyReference(claim.attempt.id),
    });
    expect(getGithubAppRegistration(database, registration.id)).toEqual(registration);
    expect(JSON.stringify(database.all("SELECT * FROM github_app_registrations"))).not.toContain("BEGIN PRIVATE KEY");
    const install = createInstallationAttempt(database, registration, now);
    expect(install.githubInstallationUrl).toMatch(/^https:\/\/github\.com\/apps\/redrive-recovery\/installations\/new\?state=/);
    expect(claimInstallationAttempt(database, install.state, now).kind).toBe("claimed");
    expect(claimInstallationAttempt(
      database,
      install.state,
      new Date(now.getTime() + INSTALLATION_CLAIM_STALE_AFTER_MS + 1),
    ).kind).toBe("claimed");
  });

  it("does not retry an explicitly marked uncertain conversion", () => {
    const { database } = fixture();
    const created = createManifestAttempt(database, { targetType: "personal" }, "https://redrive.example");
    const claim = claimManifestAttempt(database, created.state);
    expect(claim.kind).toBe("claimed");
    markManifestAttemptRecovery(database, created.attempt.id, "uncertain outcome");
    expect(database.get<{ status: string; recovery_reason: string }>("SELECT status, recovery_reason FROM github_manifest_attempts WHERE id = ?", [created.attempt.id])).toEqual({ status: "RECOVERY_REQUIRED", recovery_reason: "uncertain outcome" });
    expect(() => claimManifestAttempt(database, created.state)).not.toThrow();
    expect(claimManifestAttempt(database, created.state).kind).toBe("recovery");
  });
});

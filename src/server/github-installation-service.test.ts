import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createInstallationAttempt } from "@/server/github-app-service";
import {
  GithubInstallationVerificationError,
  verifyAndPersistGithubInstallation,
} from "@/server/github-installation-service";
import { GithubRestError, type GithubApi } from "@/server/github-rest";
import type { SecretStore } from "@/server/secret-store";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

class MemorySecretStore implements SecretStore {
  readPrivateKey(): string { return privateKey; }
  putPrivateKey(): string { return "unused"; }
  putPrivateKeyForManifestAttempt(): string { return "unused"; }
}

describe("GitHub installation verification", () => {
  const resources: Array<{ directory: string; database: SqliteDatabase }> = [];
  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-installation-test-"));
    const database = openDatabase(path.join(directory, "records.sqlite"));
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["registration-1", "900719925474099312345678901234567893", "redrive-recovery", "900719925474099312345678901234567899", "octocat", "User", "key-ref", "2026-01-01", "2026-01-01"],
    );
    const registration = {
      id: "registration-1",
      githubAppId: "900719925474099312345678901234567893",
      slug: "redrive-recovery",
      ownerId: "900719925474099312345678901234567899",
      ownerLogin: "octocat",
      ownerType: "User" as const,
      privateKeyRef: "key-ref",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    const resource = { directory, database };
    resources.push(resource);
    return { ...resource, registration };
  }

  it("verifies app ownership, persists the installation, and makes retries idempotent", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00Z"));
    const api = {
      getInstallation: vi.fn(async () => ({
        id: "900719925474099312345678901234567892",
        app_id: registration.githubAppId,
        account: { id: "900719925474099312345678901234567899", login: "octocat", type: "User" },
        repository_selection: "selected",
      })),
    } as unknown as GithubApi;
    const options = { database, api, secretStore: new MemorySecretStore(), state: created.state, installationId: "900719925474099312345678901234567892", now: new Date("2026-01-01T00:01:00Z") };
    const first = await verifyAndPersistGithubInstallation(options);
    const second = await verifyAndPersistGithubInstallation(options);
    expect(first.repeated).toBe(false);
    expect(second.repeated).toBe(true);
    expect(api.getInstallation).toHaveBeenCalledTimes(1);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_installations")?.count).toBe(1);
    expect(database.get<{ installation_id: string }>("SELECT installation_id FROM github_installations")?.installation_id).toBe(options.installationId);
  });

  it("allows only one verifier across independent SQLite connections", async () => {
    const { directory, database, registration } = fixture();
    const created = createInstallationAttempt(
      database,
      registration,
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const secondDatabase = openDatabase(path.join(directory, "records.sqlite"));
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const api = {
      getInstallation: vi.fn(async () => {
        await verificationGate;
        return {
          id: "900719925474099312345678901234567892",
          app_id: registration.githubAppId,
          account: {
            id: "900719925474099312345678901234567899",
            login: "octocat",
            type: "User",
          },
          repository_selection: "selected",
        };
      }),
    } as unknown as GithubApi;
    const options = {
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
      now: new Date("2026-01-01T00:01:00.000Z"),
    };

    const first = verifyAndPersistGithubInstallation({
      ...options,
      database,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(api.getInstallation).toHaveBeenCalledTimes(1);

    const second = verifyAndPersistGithubInstallation({
      ...options,
      database: secondDatabase,
    });
    const secondResult = await Promise.allSettled([second]);
    releaseVerification();
    const firstResult = await Promise.allSettled([first]);

    expect(firstResult[0].status).toBe("fulfilled");
    expect(secondResult[0].status).toBe("rejected");
    if (secondResult[0].status === "rejected") {
      expect(secondResult[0].reason).toBeInstanceOf(GithubInstallationVerificationError);
      expect((secondResult[0].reason as GithubInstallationVerificationError).code).toBe("ALREADY_CLAIMED");
    }
    expect(api.getInstallation).toHaveBeenCalledTimes(1);
    expect(
      secondDatabase.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM github_installations",
      )?.count,
    ).toBe(1);
    expect(
      secondDatabase.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM github_app_registrations",
      )?.count,
    ).toBe(1);
    expect(
      secondDatabase.get<{ status: string }>(
        "SELECT status FROM github_installation_attempts WHERE id = ?",
        [created.attempt.id],
      )?.status,
    ).toBe("COMPLETED");
    secondDatabase.close();
  });

  it("rejects an installation on a different account even when the App ID matches", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = { getInstallation: vi.fn(async () => ({
      id: "900719925474099312345678901234567892",
      app_id: registration.githubAppId,
      account: { id: "different-account", login: "other-owner", type: "User" },
      repository_selection: "selected",
    })) } as unknown as GithubApi;
    await expect(verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
    })).rejects.toThrow("could not be verified");
    expect(database.get<{ status: string }>("SELECT status FROM github_installation_attempts WHERE id = ?", [created.attempt.id])?.status).toBe("RECOVERY_REQUIRED");
  });

  it("rejects a remote installation belonging to another App and marks recovery", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = { getInstallation: vi.fn(async () => ({
      id: "900719925474099312345678901234567892",
      app_id: "wrong-app",
      account: { id: "1", login: "octocat", type: "User" },
      repository_selection: "selected",
    })) } as unknown as GithubApi;
    await expect(verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
    })).rejects.toThrow("could not be verified");
    expect(database.get<{ status: string }>("SELECT status FROM github_installation_attempts WHERE id = ?", [created.attempt.id])?.status).toBe("RECOVERY_REQUIRED");
  });

  it("returns a transient network failure to pending instead of poisoning the attempt", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00.000Z"));
    const api = {
      getInstallation: vi.fn(async () => {
        throw new GithubRestError("NETWORK", "GitHub REST request failed.");
      }),
    } as unknown as GithubApi;

    await expect(verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
      now: new Date("2026-01-01T00:01:00.000Z"),
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(database.get<{ status: string; claimed_at: string | null; recovery_reason: string | null }>(
      "SELECT status, claimed_at, recovery_reason FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )).toEqual({ status: "PENDING", claimed_at: null, recovery_reason: null });
  });

  it("returns a GitHub 5xx to pending for a later callback retry", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = {
      getInstallation: vi.fn(async () => {
        throw new GithubRestError("HTTP", "GitHub REST request failed with HTTP 503.", 503);
      }),
    } as unknown as GithubApi;

    await expect(verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("PENDING");
  });

  it("reclaims the same state-bound attempt after a transient failure and completes it", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const installationId = "900719925474099312345678901234567892";
    const api = {
      getInstallation: vi.fn()
        .mockRejectedValueOnce(new GithubRestError("TIMEOUT", "GitHub REST request timed out."))
        .mockResolvedValueOnce({
          id: installationId,
          app_id: registration.githubAppId,
          account: { id: registration.ownerId, login: registration.ownerLogin, type: registration.ownerType },
          repository_selection: "selected",
        }),
    } as unknown as GithubApi;
    const options = {
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
    };

    await expect(verifyAndPersistGithubInstallation(options)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const result = await verifyAndPersistGithubInstallation(options);

    expect(result.repeated).toBe(false);
    expect(result.installation.installationId).toBe(installationId);
    expect(api.getInstallation).toHaveBeenCalledTimes(2);
    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("COMPLETED");
  });

  it("keeps malformed authoritative installation responses fail-closed", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = {
      getInstallation: vi.fn(async () => ({
        id: "900719925474099312345678901234567892",
        app_id: registration.githubAppId,
      })),
    } as unknown as GithubApi;

    await expect(verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
    })).rejects.toMatchObject({ code: "REMOTE_INVALID" });
    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("RECOVERY_REQUIRED");
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_installations")?.count).toBe(0);
  });
});

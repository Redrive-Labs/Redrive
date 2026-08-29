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
import { GithubApi, GithubRestError } from "@/server/github-rest";
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

  function responseApi(
    status: number,
    headers: Record<string, string> = {},
    body = "{}",
  ): GithubApi {
    return new GithubApi({
      fetchImplementation: vi.fn(async () => new Response(body, { status, headers })),
    });
  }

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

  it("returns a GitHub 429 to pending for a later callback retry", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = responseApi(429);

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

  it("returns a header-confirmed rate-limited 403 to pending", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = responseApi(403, {
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1893456000",
    });

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

  it("accepts Retry-After as rate-limit evidence for a 403", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = responseApi(403, { "Retry-After": "30" });

    await expect(verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
    })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      retryAfterSeconds: 30,
      message: "GitHub installation verification is temporarily unavailable; retry the callback. Retry after approximately 30 seconds.",
    });

    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("PENDING");
  });

  it("keeps an ordinary 403 fail-closed", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = responseApi(403, {
      "Retry-After": "foo Jan 1 2030",
      "X-RateLimit-Remaining": "1",
      "X-RateLimit-Reset": "1893456000",
    });

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
    )?.status).toBe("RECOVERY_REQUIRED");
  });

  it.each([400, 401, 404, 422])("keeps HTTP %s fail-closed", async (status) => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const api = responseApi(status);

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
    )?.status).toBe("RECOVERY_REQUIRED");
  });

  it("releases the same state-bound attempt after rate limiting and completes on a later callback", async () => {
    const { database, registration } = fixture();
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const created = createInstallationAttempt(database, registration, startedAt);
    const installationId = "900719925474099312345678901234567892";
    const success = {
      id: installationId,
      app_id: registration.githubAppId,
      account: {
        id: registration.ownerId,
        login: registration.ownerLogin,
        type: registration.ownerType,
      },
      repository_selection: "selected",
    };
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 403,
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1893456000",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success), {
        status: 200,
        headers: { "content-type": "application/vnd.github+json" },
      }));
    const api = new GithubApi({ fetchImplementation });
    const firstOptions = {
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
      now: new Date("2026-01-01T00:01:00.000Z"),
    };

    await expect(verifyAndPersistGithubInstallation(firstOptions))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(database.get<{
      status: string;
      app_registration_id: string;
      expires_at: string;
      installation_id: string | null;
      claimed_at: string | null;
      recovery_reason: string | null;
    }>(
      `SELECT status, app_registration_id, expires_at, installation_id,
              claimed_at, recovery_reason
         FROM github_installation_attempts WHERE id = ?`,
      [created.attempt.id],
    )).toEqual({
      status: "PENDING",
      app_registration_id: registration.id,
      expires_at: created.attempt.expiresAt,
      installation_id: null,
      claimed_at: null,
      recovery_reason: null,
    });

    const result = await verifyAndPersistGithubInstallation({
      ...firstOptions,
      now: new Date("2026-01-01T00:02:00.000Z"),
    });

    expect(result.repeated).toBe(false);
    expect(result.installation.installationId).toBe(installationId);
    expect(result.installation.appRegistrationId).toBe(registration.id);
    expect(result.installation.accountId).toBe(registration.ownerId);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(database.get<{ status: string; installation_id: string }>(
      "SELECT status, installation_id FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )).toEqual({ status: "COMPLETED", installation_id: installationId });
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

  it("reclaims a stale VERIFYING attempt with a null claim timestamp", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00Z"));
    database.run(
      "UPDATE github_installation_attempts SET status = ?, claimed_at = NULL WHERE id = ?",
      ["VERIFYING", created.attempt.id],
    );
    const installationId = "900719925474099312345678901234567892";
    const api = { getInstallation: vi.fn(async () => ({
      id: installationId,
      app_id: registration.githubAppId,
      account: { id: registration.ownerId, login: registration.ownerLogin, type: registration.ownerType },
      repository_selection: "selected",
    })) } as unknown as GithubApi;

    const result = await verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
      now: new Date("2026-01-01T00:01:00Z"),
    });
    expect(result.repeated).toBe(false);
    expect(result.installation.appRegistrationId).toBe(registration.id);
    expect(api.getInstallation).toHaveBeenCalledTimes(1);
    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("COMPLETED");
  });

  it("allows a later callback to complete a stale unexpired VERIFYING attempt", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00Z"));
    database.run(
      "UPDATE github_installation_attempts SET status = ?, claimed_at = ? WHERE id = ?",
      ["VERIFYING", "2026-01-01T00:00:00Z", created.attempt.id],
    );
    const installationId = "900719925474099312345678901234567892";
    const api = { getInstallation: vi.fn(async () => ({
      id: installationId,
      app_id: registration.githubAppId,
      account: { id: registration.ownerId, login: registration.ownerLogin, type: registration.ownerType },
      repository_selection: "selected",
    })) } as unknown as GithubApi;

    const result = await verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
      now: new Date("2026-01-01T00:06:00Z"),
    });
    expect(result.installation.installationId).toBe(installationId);
    expect(database.get<{ app_registration_id: string; status: string }>(
      "SELECT app_registration_id, status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )).toEqual({ app_registration_id: registration.id, status: "COMPLETED" });
  });

  it("does not double-complete concurrent callbacks after stale reclaim", async () => {
    const { directory, database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00Z"));
    database.run(
      "UPDATE github_installation_attempts SET status = ?, claimed_at = ? WHERE id = ?",
      ["VERIFYING", "2026-01-01T00:00:00Z", created.attempt.id],
    );
    const secondDatabase = openDatabase(path.join(directory, "records.sqlite"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const installationId = "900719925474099312345678901234567892";
    const api = { getInstallation: vi.fn(async () => {
      await gate;
      return {
        id: installationId,
        app_id: registration.githubAppId,
        account: { id: registration.ownerId, login: registration.ownerLogin, type: registration.ownerType },
        repository_selection: "selected",
      };
    }) } as unknown as GithubApi;
    const options = {
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
      now: new Date("2026-01-01T00:06:00Z"),
    };
    const first = verifyAndPersistGithubInstallation({ ...options, database });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = verifyAndPersistGithubInstallation({ ...options, database: secondDatabase });
    const secondResult = await Promise.allSettled([second]);
    release();
    const firstResult = await Promise.allSettled([first]);
    expect(firstResult[0].status).toBe("fulfilled");
    expect(secondResult[0].status).toBe("rejected");
    expect(api.getInstallation).toHaveBeenCalledTimes(1);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_installations")?.count).toBe(1);
    secondDatabase.close();
  });

  it("does not make an expired stale VERIFYING attempt indefinitely retryable", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00Z"));
    database.run(
      "UPDATE github_installation_attempts SET status = ?, claimed_at = ? WHERE id = ?",
      ["VERIFYING", "2026-01-01T00:00:00Z", created.attempt.id],
    );
    const options = {
      database,
      api: responseApi(200),
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId: "900719925474099312345678901234567892",
      now: new Date("2026-01-01T00:31:00Z"),
    };
    await expect(verifyAndPersistGithubInstallation(options)).rejects.toMatchObject({ code: "EXPIRED_STATE" });
    await expect(verifyAndPersistGithubInstallation(options)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("RECOVERY_REQUIRED");
  });

  it("keeps credential failures fail-closed", async () => {
    const { database, registration } = fixture();
    const created = createInstallationAttempt(database, registration);
    const secretStore = new MemorySecretStore();
    secretStore.readPrivateKey = () => { throw new Error("credential unavailable"); };
    await expect(verifyAndPersistGithubInstallation({
      database,
      api: responseApi(200),
      secretStore,
      state: created.state,
      installationId: "900719925474099312345678901234567892",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(database.get<{ status: string }>(
      "SELECT status FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )?.status).toBe("RECOVERY_REQUIRED");
  });


  it("fences a delayed stale worker from releasing or recovery-marking the new claim", async () => {
    const { directory, database, registration } = fixture();
    const created = createInstallationAttempt(database, registration, new Date("2026-01-01T00:00:00Z"));
    const secondDatabase = openDatabase(path.join(directory, "records.sqlite"));
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const installationId = "900719925474099312345678901234567892";
    let calls = 0;
    const api = {
      getInstallation: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          await oldGate;
          throw new GithubRestError("NETWORK", "old worker delayed");
        }
        return {
          id: installationId,
          app_id: registration.githubAppId,
          account: { id: registration.ownerId, login: registration.ownerLogin, type: registration.ownerType },
          repository_selection: "selected",
        };
      }),
    } as unknown as GithubApi;
    const oldWorker = verifyAndPersistGithubInstallation({
      database,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const newWorker = verifyAndPersistGithubInstallation({
      database: secondDatabase,
      api,
      secretStore: new MemorySecretStore(),
      state: created.state,
      installationId,
      now: new Date("2026-01-01T00:06:00Z"),
    });
    await expect(newWorker).resolves.toMatchObject({ repeated: false });
    releaseOld();
    await expect(oldWorker).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(database.get<{ status: string; recovery_reason: string | null }>(
      "SELECT status, recovery_reason FROM github_installation_attempts WHERE id = ?",
      [created.attempt.id],
    )).toEqual({ status: "COMPLETED", recovery_reason: null });
    expect(api.getInstallation).toHaveBeenCalledTimes(2);
    secondDatabase.close();
  });

});

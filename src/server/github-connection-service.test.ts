import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import {
  createGithubInstallationAccessService,
  parseGithubInstallation,
  parseGithubWebhook,
} from "@/server/github-connection-service";
import type { GithubApi } from "@/server/github-rest";
import type { SecretStore } from "@/server/secret-store";

const REPOSITORY_ID = "900719925474099312345678901234567890";
const WEBHOOK_ID = "900719925474099312345678901234567891";
const INSTALLATION_ID = "900719925474099312345678901234567892";
const APP_ID = "900719925474099312345678901234567893";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

class MemorySecretStore implements SecretStore {
  readPrivateKey(): string {
    return privateKey;
  }
  putPrivateKey(): string {
    return "unused";
  }
  putPrivateKeyForManifestAttempt(): string {
    return "unused";
  }
}

describe("GitHub installation repository and webhook boundary", () => {
  const resources: Array<{ directory: string; database: SqliteDatabase }> = [];
  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-connection-test-"));
    const database = openDatabase(path.join(directory, "records.sqlite"));
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["registration-1", APP_ID, "redrive-recovery", "9007199254740994", "octocat", "User", "key-ref", "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT INTO github_installations
        (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [INSTALLATION_ID, "registration-1", "9007199254740995", "octocat", "User", "selected", "2026-01-01", "2026-01-01", "2026-01-01"],
    );
    const resource = { directory, database };
    resources.push(resource);
    return resource;
  }

  function apiFixture() {
    return {
      createInstallationToken: vi.fn(async () => ({ token: "installation-token", expires_at: "2026-01-01T00:10:00Z" })),
      listInstallationRepositories: vi.fn(async () => [
        { id: REPOSITORY_ID, full_name: "octocat/receiver", private: true, default_branch: "main" },
      ]),
      listRepositoryHooks: vi.fn(async () => [
        { id: WEBHOOK_ID, name: "web", active: true, events: ["push"], config: { url: "https://receiver.example/webhooks/github?token=secret" } },
      ]),
      getRepositoryHook: vi.fn(async () => ({
        id: WEBHOOK_ID,
        name: "web",
        active: true,
        events: ["push"],
        config: { url: "https://receiver.example/webhooks/github?token=secret" },
      })),
    } as unknown as GithubApi;
  }

  it("keeps installation, repository, and webhook IDs exact", () => {
    expect(parseGithubInstallation(
      {
        id: INSTALLATION_ID,
        app_id: APP_ID,
        account: { id: "9007199254740993", login: "octocat", type: "User" },
        repository_selection: "selected",
      },
      INSTALLATION_ID,
      APP_ID,
    )).toMatchObject({ installationId: INSTALLATION_ID, accountId: "9007199254740993" });
    expect(parseGithubWebhook({
      id: WEBHOOK_ID,
      name: "web",
      active: true,
      events: [],
      config: { url: "https://receiver.example/path?token=secret#fragment" },
    }).targetDisplay).toBe("https://receiver.example/path");
  });

  it("discovers installation repositories, re-verifies the repository and sanitizes the hook", async () => {
    const { database } = fixture();
    const api = apiFixture();
    const service = createGithubInstallationAccessService({ database, api, secretStore: new MemorySecretStore() });
    await expect(service.listRepositories(INSTALLATION_ID)).resolves.toEqual([
      { id: REPOSITORY_ID, fullName: "octocat/receiver", private: true, defaultBranch: "main" },
    ]);
    const hooks = await service.listWebhooks(INSTALLATION_ID, REPOSITORY_ID);
    expect(hooks.repository.fullName).toBe("octocat/receiver");
    expect(hooks.webhooks).toEqual([expect.objectContaining({ id: WEBHOOK_ID, targetDisplay: "https://receiver.example/webhooks/github" })]);
    expect(api.createInstallationToken).toHaveBeenCalledWith(INSTALLATION_ID, expect.any(String), [REPOSITORY_ID]);
  });

  it("accepts only an installation-accessible repository and re-fetches the authoritative hook", async () => {
    const { database } = fixture();
    const api = apiFixture();
    const service = createGithubInstallationAccessService({ database, api, secretStore: new MemorySecretStore() });
    const first = await service.createConnection({
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      webhookId: WEBHOOK_ID,
    });
    expect(first.created).toBe(true);
    expect(first.connection).toMatchObject({
      provider: "github",
      repositoryId: REPOSITORY_ID,
      repositoryFullName: "octocat/receiver",
      webhookId: WEBHOOK_ID,
      webhookTargetDisplay: "https://receiver.example/webhooks/github",
      state: "READY",
    });
    const duplicate = await service.createConnection({ installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, webhookId: WEBHOOK_ID });
    expect(duplicate).toEqual({ connection: first.connection, created: false });
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM application_connections")?.count).toBe(1);
    expect(JSON.stringify(database.all("SELECT * FROM application_connections"))).not.toContain("token=secret");

    (api.listInstallationRepositories as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "different-repository", full_name: "octocat/other", private: true, default_branch: "main" },
    ]);
    await expect(service.createConnection({ installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, webhookId: WEBHOOK_ID })).rejects.toThrow("not accessible");
  });

  it("rejects a spoofed app ID during installation parsing", () => {
    expect(() => parseGithubInstallation(
      { id: INSTALLATION_ID, app_id: "wrong-app", account: { id: "1", login: "octocat", type: "User" }, repository_selection: "selected" },
      INSTALLATION_ID,
      APP_ID,
    )).toThrow("different App");
  });
});

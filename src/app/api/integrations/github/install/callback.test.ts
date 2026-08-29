import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeConfiguredDatabase, openDatabase } from "@/server/database";
import { createInstallationAttempt } from "@/server/github-app-service";
import { FilesystemSecretStore } from "@/server/secret-store";
import { GET } from "./callback/route";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("GitHub installation callback route", () => {
  let directory: string;
  let databasePath: string;
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-install-route-test-"));
    databasePath = path.join(directory, "records.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
    process.env.REDRIVE_SECRET_DIR = path.join(directory, "secrets");
    process.env.REDRIVE_PUBLIC_URL = "https://redrive.example";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeConfiguredDatabase(databasePath);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  function createAttempt() {
    const database = openDatabase(databasePath);
    const privateKeyRef = new FilesystemSecretStore(path.join(directory, "secrets")).putPrivateKey(privateKey);
    const registration = {
      id: "registration-1",
      githubAppId: "9007199254740993123",
      slug: "redrive-recovery",
      ownerId: "9007199254740993125",
      ownerLogin: "octocat",
      ownerType: "User" as const,
      privateKeyRef,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    };
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type, private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [registration.id, registration.githubAppId, registration.slug, registration.ownerId, registration.ownerLogin, registration.ownerType, registration.privateKeyRef, registration.createdAt, registration.updatedAt],
    );
    const attempt = createInstallationAttempt(database, registration);
    database.close();
    return attempt;
  }

  it("validates the state-bound App, persists a valid installation, and does not repeat verification", async () => {
    const attempt = createAttempt();
    const api = vi.fn(async () => new Response(
      `{"id":9007199254740993124,"app_id":9007199254740993123,"account":{"id":9007199254740993125,"login":"octocat","type":"User"},"repository_selection":"selected"}`,
      { status: 200, headers: { "content-type": "application/vnd.github+json" } },
    ));
    vi.stubGlobal("fetch", api);
    const url = new URL("https://attacker.invalid/api/integrations/github/install/callback");
    url.searchParams.set("state", attempt.state);
    url.searchParams.set("installation_id", "9007199254740993124");
    url.searchParams.set("setup_action", "install");
    const first = await GET(new Request(url, { headers: { accept: "application/json" } }));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      installation: {
        installationId: "9007199254740993124",
        accountId: "9007199254740993125",
        accountLogin: "octocat",
      },
      repeated: false,
    });
    const second = await GET(new Request(url, { headers: { accept: "application/json" } }));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ repeated: true });
    expect(api).toHaveBeenCalledTimes(1);
    const database = openDatabase(databasePath);
    try {
      expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_installations")?.count).toBe(1);
      expect(database.get<{ installation_id: string; account_id: string }>(
        "SELECT installation_id, account_id FROM github_installations",
      )).toEqual({
        installation_id: "9007199254740993124",
        account_id: "9007199254740993125",
      });
    } finally { database.close(); }
  });

  it("rejects a spoofed installation ID before local persistence", async () => {
    const attempt = createAttempt();
    const api = vi.fn(async () => new Response(JSON.stringify({
      id: "different-installation",
      app_id: "9007199254740993123",
      account: { id: "1", login: "octocat", type: "User" },
      repository_selection: "selected",
    }), { status: 200, headers: { "content-type": "application/vnd.github+json" } }));
    vi.stubGlobal("fetch", api);
    const url = new URL("https://redrive.example/api/integrations/github/install/callback");
    url.searchParams.set("state", attempt.state);
    url.searchParams.set("installation_id", "9007199254740993124");
    const response = await GET(new Request(url, { headers: { accept: "application/json" } }));
    expect(response.status).toBe(503);
    const database = openDatabase(databasePath);
    try {
      expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_installations")?.count).toBe(0);
      expect(database.get<{ status: string }>("SELECT status FROM github_installation_attempts WHERE id = ?", [attempt.attempt.id])?.status).toBe("RECOVERY_REQUIRED");
    } finally { database.close(); }
  });
});

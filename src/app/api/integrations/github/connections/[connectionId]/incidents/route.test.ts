import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeConfiguredDatabase, openDatabase } from "@/server/infrastructure/database";
import { FilesystemSecretStore } from "@/server/infrastructure/secret-store";
import { POST } from "./route";
import { GET as listDeliveries } from "../deliveries/route";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const REPOSITORY_ID = "900719925474099312345678901234567890";
const WEBHOOK_ID = "900719925474099312345678901234567891";
const DELIVERY_ID = "900719925474099312345678901234567892";
const INSTALLATION_ID = "900719925474099312345678901234567893";

function githubResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/vnd.github+json" },
  });
}

describe("connection-scoped incident route", () => {
  let directory: string;
  let databasePath: string;
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-connection-incident-route-test-"),
    );
    databasePath = path.join(directory, "records.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
    process.env.REDRIVE_SECRET_DIR = path.join(directory, "secrets");
    process.env.REDRIVE_PUBLIC_URL = "https://redrive.example";

    const database = openDatabase(databasePath);
    const privateKeyRef = new FilesystemSecretStore(
      path.join(directory, "secrets"),
    ).putPrivateKey(privateKey);
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "registration-1",
        "900719925474099312345678901234567894",
        "redrive",
        "900719925474099312345678901234567895",
        "octocat",
        "User",
        privateKeyRef,
        "2026-01-01",
        "2026-01-01",
      ],
    );
    database.run(
      `INSERT INTO github_installations
        (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        INSTALLATION_ID,
        "registration-1",
        "900719925474099312345678901234567895",
        "octocat",
        "User",
        "selected",
        "2026-01-01",
        "2026-01-01",
        "2026-01-01",
      ],
    );
    database.run(
      `INSERT INTO application_connections
        (id, provider, github_installation_id, repository_id,
         repository_full_name, webhook_id, webhook_target_display, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "connection-1",
        "github",
        INSTALLATION_ID,
        REPOSITORY_ID,
        "octocat/receiver",
        WEBHOOK_ID,
        "https://receiver.example/webhook",
        "READY",
        "2026-01-01",
        "2026-01-01",
      ],
    );
    database.close();
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

  function stubGithub(deliveryBody: string, deliveryStatus = 200) {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        return githubResponse('{"token":"temporary-installation-token"}', 201);
      }
      if (url.includes("/installation/repositories?")) {
        return githubResponse(
          `{"repositories":[{"id":${REPOSITORY_ID},"full_name":"octocat/receiver","private":true,"default_branch":"main"}]}`,
        );
      }
      if (url.endsWith(`/repos/octocat/receiver/hooks/${WEBHOOK_ID}`)) {
        return githubResponse(
          `{"id":${WEBHOOK_ID},"name":"web","active":true,"events":["push"],"config":{"url":"https://receiver.example/webhook?token=secret"}}`,
        );
      }
      if (url.endsWith(`/repos/octocat/receiver/hooks/${WEBHOOK_ID}/deliveries?per_page=100`)) {
        return githubResponse(`[${deliveryBody}]`);
      }
      if (
        url.endsWith(
          `/repos/octocat/receiver/hooks/${WEBHOOK_ID}/deliveries/${DELIVERY_ID}`,
        )
      ) {
        return githubResponse(deliveryBody, deliveryStatus);
      }
      throw new Error(`unexpected GitHub URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchImplementation);
    return fetchImplementation;
  }

  async function post(deliveryId = DELIVERY_ID): Promise<Response> {
    return POST(
      new Request(
        "https://redrive.example/api/integrations/github/connections/connection-1/incidents",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deliveryId }),
        },
      ),
      { params: Promise.resolve({ connectionId: "connection-1" }) },
    );
  }

  const failedDelivery = `{"id":${DELIVERY_ID},"guid":"failed-guid","status":"Failed","status_code":500,"delivered_at":"2026-01-01T00:00:00Z","event":"push","redelivery":false}`;
  const successfulDelivery = `{"id":${DELIVERY_ID},"guid":"success-guid","status":"OK","status_code":200,"delivered_at":"2026-01-01T00:00:00Z","event":"push","redelivery":false}`;

  it("preserves an unsafe delivery ID through the delivery discovery endpoint", async () => {
    const fetchImplementation = stubGithub(failedDelivery);
    const response = await listDeliveries(
      new Request("https://redrive.example/api/integrations/github/connections/connection-1/deliveries"),
      { params: Promise.resolve({ connectionId: "connection-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deliveries: [{
        id: DELIVERY_ID,
        guid: "failed-guid",
        status: "Failed",
        statusCode: 500,
        deliveredAt: "2026-01-01T00:00:00Z",
        event: "push",
        redelivery: false,
      }],
    });
    expect(fetchImplementation).toHaveBeenCalled();
  });

  it("rejects a nonexistent delivery before creating an incident", async () => {
    const fetchImplementation = stubGithub("{\"message\":\"Not Found\"}", 404);

    const response = await post();

    expect(response.status).toBe(404);
    expect(fetchImplementation).toHaveBeenCalled();
    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects a successful delivery as not being a verified failure", async () => {
    const fetchImplementation = stubGithub(successfulDelivery);

    const response = await post();

    expect(response.status).toBe(502);
    expect(fetchImplementation).toHaveBeenCalled();
    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("creates and reuses only after authoritative failed-delivery verification", async () => {
    const fetchImplementation = stubGithub(failedDelivery);

    const first = await post();
    const duplicate = await post();

    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    const firstBody = await first.json();
    await expect(duplicate.json()).resolves.toEqual(firstBody);
    expect(fetchImplementation.mock.calls.some(([input]) =>
      String(input).includes(`/hooks/${WEBHOOK_ID}/deliveries/${DELIVERY_ID}`),
    )).toBe(true);

    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
      ).toBe(1);
      expect(
        database.get<{
          provider: string;
          repository_id: string;
          external_delivery_id: string;
          application_connection_id: string;
        }>(
          `SELECT provider, repository_id, external_delivery_id,
                  application_connection_id
             FROM incidents`,
        ),
      ).toEqual({
        provider: "github",
        repository_id: REPOSITORY_ID,
        external_delivery_id: DELIVERY_ID,
        application_connection_id: "connection-1",
      });
    } finally {
      database.close();
    }
  });

  it("rejects a legacy identity collision instead of returning the wrong incident", async () => {
    stubGithub(failedDelivery);
    const database = openDatabase(databasePath);
    try {
      database.run(
        `INSERT INTO incidents
          (id, provider, external_delivery_id, repository_id, status,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          "legacy-collision",
          "github",
          DELIVERY_ID,
          REPOSITORY_ID,
          "OPEN",
          "2026-01-01",
          "2026-01-01",
        ],
      );
    } finally {
      database.close();
    }

    const response = await post();

    expect(response.status).toBe(409);
    const persisted = openDatabase(databasePath);
    try {
      expect(
        persisted.get<{ count: number }>("SELECT COUNT(*) AS count FROM incidents")?.count,
      ).toBe(1);
      expect(
        persisted.get<{ application_connection_id: string | null }>(
          "SELECT application_connection_id FROM incidents WHERE id = ?",
          ["legacy-collision"],
        )?.application_connection_id,
      ).toBeNull();
    } finally {
      persisted.close();
    }
  });

  it("preserves idempotency for concurrent duplicate failed-delivery creation", async () => {
    stubGithub(failedDelivery);

    const responses = await Promise.all([post(), post()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
  });
});

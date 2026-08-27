import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeConfiguredDatabase,
  openDatabase,
} from "@/server/database";
import {
  MAX_INCIDENT_REQUEST_BODY_BYTES,
  POST,
} from "./route";
import {
  GET as GETProviderEvidence,
  POST as POSTProviderEvidence,
} from "./[incidentId]/provider-evidence/route";

describe("incident route", () => {
  let testDirectory: string;
  let databasePath: string;
  const originalDatabasePath = process.env.REDRIVE_DATABASE_PATH;
  const originalMcpUrl = process.env.REDRIVE_GITHUB_MCP_URL;
  const originalMcpToken = process.env.REDRIVE_GITHUB_MCP_TOKEN;
  const originalHookId = process.env.REDRIVE_GITHUB_HOOK_ID;
  const originalHookIds = process.env.REDRIVE_GITHUB_HOOK_IDS;

  beforeEach(() => {
    testDirectory = mkdtempSync(
      path.join(os.tmpdir(), "redrive-route-test-"),
    );
    databasePath = path.join(testDirectory, "incidents.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
    delete process.env.REDRIVE_GITHUB_MCP_URL;
    delete process.env.REDRIVE_GITHUB_MCP_TOKEN;
    delete process.env.REDRIVE_GITHUB_HOOK_ID;
    delete process.env.REDRIVE_GITHUB_HOOK_IDS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeConfiguredDatabase(databasePath);

    if (originalDatabasePath === undefined) {
      delete process.env.REDRIVE_DATABASE_PATH;
    } else {
      process.env.REDRIVE_DATABASE_PATH = originalDatabasePath;
    }

    for (const [key, value] of [
      ["REDRIVE_GITHUB_MCP_URL", originalMcpUrl],
      ["REDRIVE_GITHUB_MCP_TOKEN", originalMcpToken],
      ["REDRIVE_GITHUB_HOOK_ID", originalHookId],
      ["REDRIVE_GITHUB_HOOK_IDS", originalHookIds],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    const resolvedDirectory = path.resolve(testDirectory);
    const temporaryRoot = path.resolve(os.tmpdir());
    const isIsolatedTestDirectory =
      path.dirname(resolvedDirectory) === temporaryRoot &&
      path.basename(resolvedDirectory).startsWith("redrive-route-test-");

    if (!isIsolatedTestDirectory) {
      throw new Error("Refusing to remove a non-test directory.");
    }

    rmSync(resolvedDirectory, { recursive: true, force: false });
  });

  it("persists a native browser form submission and redirects to the homepage", async () => {
    const externalDeliveryId = "900719925474099312345678901234567890";
    const form = new URLSearchParams({
      provider: "github",
      externalDeliveryId,
      repositoryId: "Redrive-Labs/redrive-demo-receiver",
    });

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/");

    const duplicateResponse = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(duplicateResponse.status).toBe(303);
    expect(duplicateResponse.headers.get("location")).toBe("http://localhost/");

    const database = await openDatabase(databasePath);
    try {
      const rows = database.all<{
        provider: string;
        external_delivery_id: string;
        repository_id: string;
        status: string;
      }>(
        "SELECT provider, external_delivery_id, repository_id, status FROM incidents",
      );

      expect(rows).toEqual([
        {
          provider: "github",
          external_delivery_id: externalDeliveryId,
          repository_id: "Redrive-Labs/redrive-demo-receiver",
          status: "OPEN",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("decodes percent-encoded Unicode and plus-separated form values", async () => {
    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body:
          "provider=github+ops" +
          "&externalDeliveryId=%E9%85%8D%E9%80%81-%F0%9F%9A%9A+001" +
          "&repositoryId=example%2Freceiver",
      }),
    );

    expect(response.status).toBe(303);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.all<{
          provider: string;
          external_delivery_id: string;
          repository_id: string;
        }>(
          "SELECT provider, external_delivery_id, repository_id FROM incidents",
        ),
      ).toEqual([
        {
          provider: "github ops",
          external_delivery_id: "配送-🚚 001",
          repository_id: "example/receiver",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("returns a 400 for invalid form input without creating a row", async () => {
    const form = new URLSearchParams({
      provider: "github",
      externalDeliveryId: "",
      repositoryId: "Redrive-Labs/redrive-demo-receiver",
    });

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(400);

    const database = await openDatabase(databasePath);
    try {
      const row = database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM incidents",
      );

      expect(row?.count).toBe(0);
    } finally {
      database.close();
    }
  });

  it("returns 201 for first JSON creation and 200 for a duplicate", async () => {
    const requestBody = JSON.stringify({
      provider: "github",
      externalDeliveryId: "json-delivery-001",
      repositoryId: "example/receiver",
    });
    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }),
    );

    expect(response.status).toBe(201);
    const firstResult = await response.json();
    expect(firstResult).toMatchObject({
      incident: {
        provider: "github",
        externalDeliveryId: "json-delivery-001",
        repositoryId: "example/receiver",
        status: "OPEN",
      },
    });

    const duplicateResponse = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }),
    );

    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toEqual(firstResult);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects malformed UTF-8 JSON before validation or persistence", async () => {
    const malformedBody = Uint8Array.from([
      0x7b, 0x22, 0x70, 0x72, 0x6f, 0x76, 0x69, 0x64, 0x65, 0x72,
      0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
    ]);

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: malformedBody as unknown as BodyInit,
      }),
    );

    expect(response.status).toBe(400);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects malformed UTF-8 in URL-encoded forms", async () => {
    const malformedBody = Uint8Array.from([
      ...new TextEncoder().encode("provider=github&externalDeliveryId="),
      0xc3,
      0x28,
      ...new TextEncoder().encode("&repositoryId=example%2Freceiver"),
    ]);

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: malformedBody as unknown as BodyInit,
      }),
    );

    expect(response.status).toBe(400);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("accepts Unicode input encoded as valid UTF-8", async () => {
    const input = {
      provider: "github-日本語",
      externalDeliveryId: "配送-🚚-001",
      repositoryId: "例/receiver",
    };
    const body = new TextEncoder().encode(JSON.stringify(input));

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: body as unknown as BodyInit,
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      incident: input,
    });
  });

  it("rejects percent-encoded malformed UTF-8 in URL-encoded forms", async () => {
    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body:
          "provider=github" +
          "&externalDeliveryId=%C3%28" +
          "&repositoryId=example%2Freceiver",
      }),
    );

    expect(response.status).toBe(400);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects an oversized JSON body without creating a row", async () => {
    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          externalDeliveryId: "x".repeat(
            MAX_INCIDENT_REQUEST_BODY_BYTES,
          ),
          repositoryId: "example/receiver",
        }),
      }),
    );

    expect(response.status).toBe(413);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects an oversized native form body without creating a row", async () => {
    const form = new URLSearchParams({
      provider: "github",
      externalDeliveryId: "x".repeat(
        MAX_INCIDENT_REQUEST_BODY_BYTES,
      ),
      repositoryId: "example/receiver",
    });

    const response = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
      }),
    );

    expect(response.status).toBe(413);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM incidents",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });
  it("returns not found before attempting provider configuration for a missing incident", async () => {
    const response = await GETProviderEvidence(
      new Request("http://localhost/api/incidents/missing/provider-evidence"),
      { params: Promise.resolve({ incidentId: "missing" }) },
    );

    expect(response.status).toBe(404);
  });

  it("POST captures provider evidence and GET returns the persisted snapshot", async () => {
    process.env.REDRIVE_GITHUB_MCP_URL = "https://mcp.example.test/mcp";
    process.env.REDRIVE_GITHUB_HOOK_ID = "670245925";
    const providerDeliveryId = "900719925474099312345678901234567890";
    const deliveryGuid = "guid-route-001";
    const toolResult = {
      full: {
        http_status: 200,
        body: {
          id: providerDeliveryId,
          guid: deliveryGuid,
          event: "push",
          status: "Invalid HTTP Response: 500",
          status_code: 500,
          delivered_at: "2026-08-25T09:56:40.78Z",
          redelivery: false,
          repository_id: 1345932290,
          request: {
            headers: { "X-GitHub-Delivery": deliveryGuid },
            payload: {
              repository: {
                id: 1345932290,
                full_name: "example/receiver",
              },
            },
          },
          response: { headers: {}, payload: "receiver failed" },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(toolResult) }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const createResponse = await POST(new Request("http://localhost/api/incidents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        externalDeliveryId: providerDeliveryId,
        repositoryId: "example/receiver",
      }),
    }));
    const { incident } = await createResponse.json() as { incident: { id: string } };
    const context = { params: Promise.resolve({ incidentId: incident.id }) };

    const captureResponse = await POSTProviderEvidence(
      new Request(`http://localhost/api/incidents/${incident.id}/provider-evidence`, {
        method: "POST",
      }),
      context,
    );
    expect(captureResponse.status).toBe(200);
    const captured = await captureResponse.json();
    expect(captured).toMatchObject({
      evidence: { providerDeliveryId, deliveryGuid },
    });

    const readResponse = await GETProviderEvidence(
      new Request(`http://localhost/api/incidents/${incident.id}/provider-evidence`),
      context,
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toEqual(captured);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("GET reads persisted state without requiring or contacting MCP", async () => {
    const createResponse = await POST(
      new Request("http://localhost/api/incidents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: "github",
          externalDeliveryId: "delivery-for-inspection",
          repositoryId: "example/receiver",
        }),
      }),
    );
    const { incident } = (await createResponse.json()) as {
      incident: { id: string };
    };

    const response = await GETProviderEvidence(
      new Request(
        `http://localhost/api/incidents/${incident.id}/provider-evidence`,
      ),
      { params: Promise.resolve({ incidentId: incident.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ evidence: null });

    const captureResponse = await POSTProviderEvidence(
      new Request(
        `http://localhost/api/incidents/${incident.id}/provider-evidence`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ incidentId: incident.id }) },
    );
    expect(captureResponse.status).toBe(503);

    const database = await openDatabase(databasePath);
    try {
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM provider_evidence",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});

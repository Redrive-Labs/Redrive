import { describe, expect, it } from "vitest";
import {
  computeProviderPayloadSha256,
  type ProviderEvidence,
} from "./provider-evidence";
import {
  GithubDeliveryNormalizationError,
  normalizeGithubWebhookDelivery,
} from "@/server/github-provider-evidence";
import type { GithubWebhookDeliveryLookup } from "@/server/github-mcp";

const lookup: GithubWebhookDeliveryLookup = {
  repositoryId: "example/receiver",
  deliveryId: "900719925474099312345678901234567890",
};

function makeResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: lookup.deliveryId,
    guid: "guid-001",
    event: "push",
    status: "Invalid HTTP Response: 500",
    status_code: 500,
    delivered_at: "2026-08-25T09:56:40.78Z",
    redelivery: false,
    repository_id: 1345932290,
    request: {
      headers: {
        "X-Github-Delivery": "guid-001",
        "X-Github-Event": "push",
      },
      payload: {
        repository: {
          id: 1345932290,
          full_name: "example/receiver",
        },
        ref: "refs/heads/main",
      },
    },
    response: {
      headers: {
        "content-type": "text/plain",
      },
      payload: "receiver failed",
    },
    ignoredBodyField: "ignored",
    ...overrides,
  };

  return {
    id: lookup.deliveryId,
    guid: "guid-001",
    event: "push",
    status_code: 500,
    delivered_at: "2026-08-25T09:56:40.78Z",
    redelivery: false,
    duration: 0.21,
    ignoredRootField: "ignored",
    full: {
      http_status: 200,
      body,
    },
  };
}

describe("GitHub provider evidence normalizer", () => {
  it("normalizes the proven MCP wrapper and maps response.payload to response.body", () => {
    const evidence = normalizeGithubWebhookDelivery(
      makeResult(),
      lookup,
      "2026-08-25T10:00:00.000Z",
    );

    const expected: ProviderEvidence = {
      schemaVersion: 1,
      provider: "github",
      repositoryId: lookup.repositoryId,
      deliveryId: lookup.deliveryId,
      event: "push",
      deliveredAt: "2026-08-25T09:56:40.78Z",
      outcome: {
        status: "Invalid HTTP Response: 500",
        statusCode: 500,
      },
      request: {
        headers: {
          "X-Github-Delivery": "guid-001",
          "X-Github-Event": "push",
        },
        payload: {
          repository: {
            id: 1345932290,
            full_name: "example/receiver",
          },
          ref: "refs/heads/main",
        },
        payloadSha256: computeProviderPayloadSha256({
          repository: {
            id: 1345932290,
            full_name: "example/receiver",
          },
          ref: "refs/heads/main",
        }),
      },
      response: {
        headers: {
          "content-type": "text/plain",
        },
        body: "receiver failed",
      },
      redelivery: false,
      capturedAt: "2026-08-25T10:00:00.000Z",
    };

    expect(evidence).toEqual(expected);
    expect(evidence).not.toHaveProperty("ignoredRootField");
    expect(evidence).not.toHaveProperty("full");
  });

  it("matches the proven numeric GitHub delivery ID without stringifying a rounded number", () => {
    const spikeLookup: GithubWebhookDeliveryLookup = {
      repositoryId: "example/receiver",
      deliveryId: "3838953010386436096",
    };
    const result = makeResult();
    const body = (result.full as { body: Record<string, unknown> }).body;
    body.id = Number(spikeLookup.deliveryId);
    body.guid = "other-guid";
    body.request = {
      headers: { "X-Github-Delivery": "other-guid" },
      payload: { repository: { full_name: "example/receiver" } },
    };

    expect(
      normalizeGithubWebhookDelivery(result, spikeLookup),
    ).toMatchObject({ deliveryId: spikeLookup.deliveryId });
  });

  it("rejects a malformed status code", () => {
    expect(() =>
      normalizeGithubWebhookDelivery(
        makeResult({ status_code: "500" }),
        lookup,
      ),
    ).toThrow(GithubDeliveryNormalizationError);
  });

  it("rejects a delivery ID that does not match the lookup", () => {
    expect(() =>
      normalizeGithubWebhookDelivery(
        makeResult({ id: "different-delivery" }),
        lookup,
      ),
    ).toThrow("does not match the incident delivery ID");
  });

  it("rejects a repository identity that does not match the lookup", () => {
    expect(() =>
      normalizeGithubWebhookDelivery(
        makeResult({
          request: {
            headers: {
              "X-Github-Delivery": "guid-001",
            },
            payload: {
              repository: {
                id: 1345932290,
                full_name: "other/receiver",
              },
            },
          },
        }),
        lookup,
      ),
    ).toThrow("does not match the incident repository ID");
  });
});

describe("provider payload hashing", () => {
  it("is deterministic for equivalent captured payloads", () => {
    const first = computeProviderPayloadSha256({
      z: ["last", { b: true, a: 1 }],
      a: "first",
    });
    const second = computeProviderPayloadSha256({
      a: "first",
      z: ["last", { a: 1, b: true }],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("hashes a string payload representation exactly", () => {
    expect(computeProviderPayloadSha256("{\"b\":2,\"a\":1}"))
      .toBe("3fb75453225c732a76b7899ea2096dda1455189c89817239732182f73fe5a09f");
  });
});

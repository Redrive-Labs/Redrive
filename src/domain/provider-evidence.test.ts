import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeCanonicalProviderPayloadSha256,
  parseProviderEvidence,
  type ProviderEvidence,
} from "./provider-evidence";
import {
  GithubDeliveryNormalizationError,
  normalizeGithubWebhookDelivery,
} from "@/server/github/github-provider-evidence";
import type { GithubWebhookDeliveryLookup } from "@/server/github/github-mcp";

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
      headers: { "content-type": "text/plain" },
      payload: "receiver failed",
    },
    ignoredBodyField: "ignored",
    ...overrides,
  };

  return {
    duration: 0.21,
    ignoredRootField: "ignored",
    full: { http_status: 200, body },
  };
}

function normalize(
  result = makeResult(),
  requested = lookup,
): ProviderEvidence {
  return normalizeGithubWebhookDelivery(
    result,
    requested,
    "2026-08-25T10:00:00.000Z",
  );
}

describe("GitHub provider evidence normalizer", () => {
  it("keeps the provider attempt ID and logical delivery GUID separate", () => {
    const evidence = normalize();

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      provider: "github",
      repositoryId: lookup.repositoryId,
      providerDeliveryId: lookup.deliveryId,
      deliveryGuid: "guid-001",
      event: "push",
      outcome: { statusCode: 500 },
      response: { body: "receiver failed" },
    });
    expect(evidence.request.canonicalPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence).not.toHaveProperty("deliveryId");
    expect(evidence).not.toHaveProperty("ignoredRootField");
    expect(evidence).not.toHaveProperty("full");
  });

  it("represents later provider attempts with the same logical GUID", () => {
    const firstLookup = { ...lookup, deliveryId: "123" };
    const secondLookup = { ...lookup, deliveryId: "456" };
    const first = normalize(makeResult({ id: "123", guid: "abc", request: {
      headers: { "x-github-delivery": "abc" },
      payload: {
        repository: { id: 1345932290, full_name: lookup.repositoryId },
      },
    } }), firstLookup);
    const second = normalize(makeResult({ id: "456", guid: "abc", request: {
      headers: { "X-GITHUB-DELIVERY": "abc" },
      payload: {
        repository: { id: 1345932290, full_name: lookup.repositoryId },
      },
    } }), secondLookup);

    expect([first.providerDeliveryId, second.providerDeliveryId]).toEqual(["123", "456"]);
    expect([first.deliveryGuid, second.deliveryGuid]).toEqual(["abc", "abc"]);
  });

  it("preserves a provider attempt ID beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(normalize().providerDeliveryId).toBe(lookup.deliveryId);
    expect(() => normalize(makeResult({ id: Number(lookup.deliveryId) }))).toThrow(
      "safe integer",
    );
  });

  it("matches X-GitHub-Delivery case-insensitively", () => {
    const result = makeResult();
    const body = (result.full as { body: Record<string, unknown> }).body;
    body.request = {
      headers: { "x-GITHUB-delivery": "guid-001" },
      payload: {
        repository: { id: 1345932290, full_name: lookup.repositoryId },
      },
    };

    expect(normalize(result).deliveryGuid).toBe("guid-001");
  });

  it("rejects contradictory GUID and header evidence", () => {
    expect(() => normalize(makeResult({ guid: "different-guid" }))).toThrow(
      "does not match the delivery GUID",
    );
  });

  it("rejects a malformed status code", () => {
    expect(() => normalize(makeResult({ status_code: "500" }))).toThrow(
      GithubDeliveryNormalizationError,
    );
  });

  it("rejects a provider attempt ID that does not match the lookup", () => {
    expect(() => normalize(makeResult({ id: "different-delivery" }))).toThrow(
      "does not match the incident delivery ID",
    );
  });

  it("rejects any contradictory repository identity", () => {
    expect(() => normalize(makeResult({
      repositoryFullName: lookup.repositoryId,
      request: {
        headers: { "X-GitHub-Delivery": "guid-001" },
        payload: {
          repository: { id: 1345932290, full_name: "other/receiver" },
        },
      },
    }))).toThrow("does not match the incident repository ID");
  });

  it("rejects unproved delivery response aliases and wrapper status", () => {
    const aliasedResponse = makeResult({
      response: { headers: {}, body: "receiver failed" },
    });
    expect(() => normalize(aliasedResponse)).toThrow(
      "response payload is required",
    );

    const badWrapper = makeResult();
    (badWrapper.full as Record<string, unknown>).http_status = 201;
    expect(() => normalize(badWrapper)).toThrow(
      "full.http_status must be 200",
    );
  });

  it("revalidates GUID/header agreement in normalized stored JSON", () => {
    const evidence = normalize();
    expect(() => parseProviderEvidence({
      ...evidence,
      deliveryGuid: "tampered-guid",
    })).toThrow("must match X-GitHub-Delivery");
  });
});

describe("provider payload hashing", () => {
  it("is deterministic for equivalent captured JSON", () => {
    const first = computeCanonicalProviderPayloadSha256({
      z: ["last", { b: true, a: 1 }],
      a: "first",
    });
    const second = computeCanonicalProviderPayloadSha256({
      a: "first",
      z: ["last", { a: 1, b: true }],
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not claim to hash original request-body bytes", () => {
    const firstRaw = '{"b":2,"a":1}';
    const secondRaw = '{"a":1,"b":2}';
    expect(createHash("sha256").update(firstRaw).digest("hex")).not.toBe(
      createHash("sha256").update(secondRaw).digest("hex"),
    );
    expect(computeCanonicalProviderPayloadSha256(JSON.parse(firstRaw))).toBe(
      computeCanonicalProviderPayloadSha256(JSON.parse(secondRaw)),
    );
  });

  it("hashes a string as a canonical JSON string value", () => {
    const payload = '{"b":2,"a":1}';
    expect(computeCanonicalProviderPayloadSha256(payload)).toBe(
      createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    );
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseRecoveryResultJson,
  RECOVERY_PATCH_MAX_BYTES,
  RecoveryResultValidationError,
} from "@/domain/recovery-result";

const expected = {
  sourceRepositoryFullName: "Redrive-Labs/redrive-demo-receiver",
  originalRevision: "5bfadf93d5233e4e6cfe0fdb19ad1b78328a5d79",
  deliveryGuid: "acab6534-a25a-11f1-8324-8fdf05b88a6b",
  providerStatusCode: 500,
  receiverMutationCount: 1,
};

function validArtifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "redrive.recovery.v1",
    result: "REPAIR_VERIFIED",
    sourceRepositoryFullName: expected.sourceRepositoryFullName,
    originalRevision: expected.originalRevision,
    deliveryGuid: expected.deliveryGuid,
    reproduction: { preCount: 0, httpStatus: 500, postCount: 1 },
    verification: { preCount: 1, httpStatus: 201, postCount: 1 },
    changedFiles: ["src/downstream.ts", "src/events.ts", "migrations/12.sql"],
    patch: "diff --git a/src/events.ts b/src/events.ts\n",
    validation: {
      testsPassed: true,
      typecheckPassed: true,
      buildPassed: true,
      diffCheckPassed: true,
    },
    notes: { postgresVersion: "PostgreSQL 15.19" },
    ...overrides,
  };
}

describe("strict recovery result validation", () => {
  it("accepts the exact verified artifact contract", () => {
    const text = JSON.stringify(validArtifact());

    expect(parseRecoveryResultJson(text, expected)).toEqual(validArtifact());
  });

  it.each([
    ["schemaVersion", { schemaVersion: "wrong" }],
    ["result", { result: "READY" }],
    ["repository", { sourceRepositoryFullName: "other/repo" }],
    ["revision", { originalRevision: "other-revision" }],
    ["delivery GUID", { deliveryGuid: "other-guid" }],
    ["reproduction", { reproduction: { preCount: 1, httpStatus: 500, postCount: 1 } }],
    ["verification count", { verification: { preCount: 1, httpStatus: 201, postCount: 2 } }],
    ["verification status", { verification: { preCount: 1, httpStatus: 500, postCount: 1 } }],
    ["changed files", { changedFiles: [] }],
    ["validation flags", { validation: { ...validArtifact().validation, buildPassed: false } }],
    ["missing patch", { patch: "" }],
  ] as const)("rejects an invalid %s", (_label, override) => {
    expect(() =>
      parseRecoveryResultJson(JSON.stringify(validArtifact(override)), expected),
    ).toThrow(RecoveryResultValidationError);
  });

  it("rejects unexpected fields and malformed JSON", () => {
    expect(() =>
      parseRecoveryResultJson(
        JSON.stringify({ ...validArtifact(), unexpected: true }),
        expected,
      ),
    ).toThrow(RecoveryResultValidationError);
    expect(() => parseRecoveryResultJson("not-json", expected)).toThrow(
      RecoveryResultValidationError,
    );
  });

  it("rejects a patch larger than the bounded limit", () => {
    const patch = "x".repeat(RECOVERY_PATCH_MAX_BYTES + 1);
    expect(() =>
      parseRecoveryResultJson(JSON.stringify(validArtifact({ patch })), expected),
    ).toThrow("exceeds");
  });

  it("keeps the patch unchanged for Redrive's host-side SHA-256", () => {
    const artifact = parseRecoveryResultJson(
      JSON.stringify(validArtifact()),
      expected,
    );
    expect(
      createHash("sha256").update(artifact.patch, "utf8").digest("hex"),
    ).toBe("d076da9a31f5d0f3d32d24606f849c08eb791840df909ce913d6e98132d3127c");
  });
});

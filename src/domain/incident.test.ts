import { describe, expect, it } from "vitest";
import {
  INCIDENT_INPUT_LIMITS,
  IncidentValidationError,
  parseCreateIncidentInput,
} from "./incident";

const overLimitCases = [
  ["provider", INCIDENT_INPUT_LIMITS.provider],
  ["externalDeliveryId", INCIDENT_INPUT_LIMITS.externalDeliveryId],
  ["repositoryId", INCIDENT_INPUT_LIMITS.repositoryId],
] as const;

describe("incident input limits", () => {
  it.each(overLimitCases)(
    "rejects an over-limit %s",
    (field, maxLength) => {
      const error = (() => {
        try {
          parseCreateIncidentInput({
            provider: "github",
            externalDeliveryId: "delivery-001",
            repositoryId: "example/receiver",
            [field]: "x".repeat(maxLength + 1),
          });
        } catch (caughtError) {
          return caughtError;
        }

        return null;
      })();

      expect(error).toBeInstanceOf(IncidentValidationError);
      expect((error as IncidentValidationError).issues[field]).toBe(
        `Must be at most ${maxLength} characters.`,
      );
    },
  );
});

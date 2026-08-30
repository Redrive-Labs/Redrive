import { describe, expect, it, vi } from "vitest";
import {
  createCapabilityDispatcher,
  dispatchCapabilityJob,
} from "../src/dispatcher.js";
import {
  parseCapabilityJob,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  type CapabilityJob,
} from "../src/model.js";

const OBSERVED_AT = "2026-08-29T12:00:00.000Z";

describe("capability dispatcher and job model", () => {
  it("dispatches business_state:v1 to the business adapter", async () => {
    const businessState = {
      observe: vi.fn(async () => ({
        schemaVersion: 1 as const,
        deliveryGuid: "delivery-guid",
        mutationCount: 1,
        businessState: "EXACTLY_ONE" as const,
        observedAt: OBSERVED_AT,
      })),
      close: vi.fn(async () => undefined),
    };
    const health = {
      observe: vi.fn(),
    };
    const dispatcher = createCapabilityDispatcher({ businessState, health });

    await expect(dispatcher({
      jobId: "business-job",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      leaseGeneration: 4,
      input: { deliveryGuid: "delivery-guid" },
    })).resolves.toMatchObject({ businessState: "EXACTLY_ONE" });
    expect(businessState.observe).toHaveBeenCalledWith({ deliveryGuid: "delivery-guid" });
    expect(health.observe).not.toHaveBeenCalled();
  });

  it("dispatches health:v1 to the health adapter", async () => {
    const health = {
      observe: vi.fn(async () => ({
        schemaVersion: 1 as const,
        healthStatus: "HEALTHY" as const,
        observedAt: OBSERVED_AT,
      })),
    };
    const dispatcher = createCapabilityDispatcher({
      businessState: {
        observe: vi.fn(),
        close: vi.fn(async () => undefined),
      },
      health,
    });

    await expect(dispatchCapabilityJob({
      jobId: "health-job",
      capability: RECEIVER_CAPABILITY_HEALTH,
      leaseGeneration: 5,
      input: {},
    }, {
      businessState: {
        observe: vi.fn(),
        close: vi.fn(async () => undefined),
      },
      health,
    })).resolves.toMatchObject({ healthStatus: "HEALTHY" });
    expect(health.observe).toHaveBeenCalledWith({});
  });

  it("fails safely for unknown capabilities and unexpected fields", async () => {
    const dispatcher = createCapabilityDispatcher({
      businessState: {
        observe: vi.fn(),
        close: vi.fn(async () => undefined),
      },
      health: { observe: vi.fn() },
    });
    await expect(dispatcher({
      capability: "logs:v1",
      jobId: "unknown-job",
      leaseGeneration: 1,
      input: {},
    } as unknown as CapabilityJob)).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    expect(() => parseCapabilityJob({
      capability: RECEIVER_CAPABILITY_HEALTH,
      jobId: "health-job",
      leaseGeneration: 1,
      input: { unexpected: true },
    })).toThrowError(/unexpected field/i);
  });
});

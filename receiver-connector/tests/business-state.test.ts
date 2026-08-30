import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSINESS_STATE_QUERY,
  createBusinessStateAdapter,
  type BusinessStateQueryClient,
} from "../src/business-state.js";
import { ObservationError } from "../src/errors.js";

const OBSERVED_AT = new Date("2026-08-29T12:00:00.000Z");

afterEach(() => vi.restoreAllMocks());

function clientReturning(mutationCount: unknown): BusinessStateQueryClient & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async () => ({ rows: [{ mutation_count: mutationCount }] })),
  } as unknown as BusinessStateQueryClient & { query: ReturnType<typeof vi.fn> };
}

async function observeCount(mutationCount: unknown) {
  const client = clientReturning(mutationCount);
  const adapter = createBusinessStateAdapter({
    client,
    clock: () => OBSERVED_AT,
  });
  const result = await adapter.observe({ deliveryGuid: "delivery-guid" });
  return { client, result };
}

describe("business_state:v1 adapter", () => {
  it.each([
    ["0", 0, "ABSENT"],
    ["1", 1, "EXACTLY_ONE"],
    ["2", 2, "MULTIPLE"],
    ["99", 99, "MULTIPLE"],
  ])("normalizes count %s", async (rawCount, mutationCount, businessState) => {
    const { result } = await observeCount(rawCount);
    expect(result).toEqual({
      schemaVersion: 1,
      deliveryGuid: "delivery-guid",
      mutationCount,
      businessState,
      observedAt: OBSERVED_AT.toISOString(),
    });
  });

  it("uses the fixed parameterized query and keeps an injection-shaped GUID inert", async () => {
    const client = clientReturning("0");
    const adapter = createBusinessStateAdapter({ client, clock: () => OBSERVED_AT });
    const deliveryGuid = "guid' ; DELETE FROM business_events; --";
    await adapter.observe({ deliveryGuid });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith({
      text: BUSINESS_STATE_QUERY,
      values: [deliveryGuid],
      query_timeout: 5_000,
    });
    expect(BUSINESS_STATE_QUERY).toBe(
      "SELECT COUNT(*)::text AS mutation_count FROM business_events WHERE external_ref = $1",
    );
  });

  it.each(["-1", "01", "1.5", "9007199254740992", "not-a-count", 1, null])(
    "rejects invalid count %s",
    async (mutationCount) => {
      await expect(observeCount(mutationCount)).rejects.toMatchObject({
        code: "INVALID_DATABASE_RESULT",
      });
    },
  );

  it("sanitizes database failures and does not issue a mutation", async () => {
    const requests: Array<{ text: string }> = [];
    const query = vi.fn(async (request: { text: string }) => {
      requests.push(request);
      throw new Error("password=super-secret host=private-db");
    });
    const client = { query } as unknown as BusinessStateQueryClient;
    const adapter = createBusinessStateAdapter({ client, clock: () => OBSERVED_AT });

    await expect(adapter.observe({ deliveryGuid: "delivery-guid" })).rejects.toMatchObject({
      code: "DATABASE_ERROR",
      message: "The business-state observation failed.",
      retryable: true,
    });
    await expect(adapter.observe({ deliveryGuid: "delivery-guid" })).rejects.not.toThrow(
      "super-secret",
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(requests.every((request) => !/INSERT|UPDATE|DELETE/i.test(request.text))).toBe(true);
  });

  it("maps bounded query timeouts to a typed retryable observation error", async () => {
    const query = vi.fn(async () => {
      const error = new Error("query timeout");
      throw error;
    });
    const adapter = createBusinessStateAdapter({
      client: { query } as unknown as BusinessStateQueryClient,
      clock: () => OBSERVED_AT,
    });

    await expect(adapter.observe({ deliveryGuid: "delivery-guid" })).rejects.toEqual(
      expect.objectContaining<Partial<ObservationError>>({
        code: "DATABASE_TIMEOUT",
        retryable: true,
      }),
    );
  });
});

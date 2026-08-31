import { describe, expect, it } from "vitest";
import { boundedPoll } from "@/server/receiver/receiver-bounded-poll";

describe("receiver bounded polling", () => {
  it("runs short polls until work appears", async () => {
    let now = 0;
    let attempts = 0;
    const events: string[] = [];
    const result = await boundedPoll({
      deadlineMs: 1_000,
      intervalMs: 100,
      clock: () => now,
      poll: () => {
        attempts += 1;
        events.push(`poll-${attempts}`);
        return attempts === 3 ? { jobId: "job-1" } : undefined;
      },
      sleep: async (milliseconds) => {
        events.push(`sleep-${milliseconds}`);
        now += milliseconds;
        return true;
      },
    });

    expect(result).toEqual({ jobId: "job-1" });
    expect(events).toEqual(["poll-1", "sleep-100", "poll-2", "sleep-100", "poll-3"]);
  });

  it("bounds no-work waits and leaves the wait between database attempts", async () => {
    let now = 0;
    const events: string[] = [];
    const result = await boundedPoll({
      deadlineMs: 600,
      intervalMs: 250,
      clock: () => now,
      poll: () => {
        events.push("short-db-attempt");
        return undefined;
      },
      sleep: async (milliseconds) => {
        events.push("timer");
        now += milliseconds;
        return true;
      },
    });

    expect(result).toBeNull();
    expect(now).toBe(600);
    expect(events).toEqual([
      "short-db-attempt",
      "timer",
      "short-db-attempt",
      "timer",
      "short-db-attempt",
      "timer",
      "short-db-attempt",
    ]);
  });

  it("stops without another poll when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    await expect(
      boundedPoll({
        deadlineMs: 20_000,
        intervalMs: 250,
        signal: controller.signal,
        poll: () => {
          attempts += 1;
          return undefined;
        },
      }),
    ).resolves.toBeNull();
    expect(attempts).toBe(0);
  });
});

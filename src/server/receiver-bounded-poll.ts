export const RECEIVER_CONNECTOR_LONG_POLL_MAX_MS = 20_000;
export const RECEIVER_CONNECTOR_LONG_POLL_INTERVAL_MS = 250;
export const RECEIVER_MCP_WAIT_MAX_MS = 25_000;
export const RECEIVER_MCP_WAIT_INTERVAL_MS = 250;

export interface BoundedPollOptions<T> {
  deadlineMs: number;
  intervalMs: number;
  poll: () => T | undefined | Promise<T | undefined>;
  clock?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<boolean>;
  signal?: AbortSignal;
}

async function sleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(true), milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      finish(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls only through the supplied short operation. The wait itself owns no
 * database transaction and can be interrupted by the HTTP request signal.
 */
export async function boundedPoll<T>({
  deadlineMs,
  intervalMs,
  poll,
  clock = () => Date.now(),
  sleep: wait = sleep,
  signal,
}: BoundedPollOptions<T>): Promise<T | null> {
  const boundedDeadlineMs = Math.max(0, deadlineMs);
  const startedAt = clock();
  const deadlineAt = startedAt + boundedDeadlineMs;

  while (true) {
    if (signal?.aborted) return null;
    const value = await poll();
    if (value !== undefined) return value;

    const remainingMs = deadlineAt - clock();
    if (remainingMs <= 0) return null;
    const didSleep = await wait(
      Math.min(Math.max(1, intervalMs), remainingMs),
      signal,
    );
    if (!didSleep) return null;
  }
}

import { ConfigurationError, ObservationError } from "./errors.js";
import {
  CONNECTOR_SCHEMA_VERSION,
  parseHealthInput,
  type HealthInput,
  type HealthResult,
} from "./model.js";

export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000 as const;
export const DEFAULT_HEALTH_MAX_RESPONSE_BYTES = 64 * 1024;

export interface HealthAdapter {
  observe(input: HealthInput): Promise<HealthResult>;
}

export interface HealthAdapterOptions {
  readonly healthUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clock?: () => Date;
}

function validateHealthUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(
      "The configured receiver health URL is invalid.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin === "null"
  ) {
    throw new ConfigurationError(
      "The configured receiver health URL is invalid.",
    );
  }
  return url.href;
}

function validPositiveBound(value: number | undefined, fallback: number, maximum: number): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > maximum) {
    throw new ConfigurationError(
      "The health observation bounds are invalid.",
    );
  }
  return bound;
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new ObservationError(
      "HEALTH_RESPONSE_TOO_LARGE",
      "The receiver health response exceeded the size limit.",
      false,
    );
  }

  if (response.body === null || response.body === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new ObservationError(
        "HEALTH_RESPONSE_TOO_LARGE",
        "The receiver health response exceeded the size limit.",
        false,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        throw new ObservationError(
          "HEALTH_RESPONSE_TOO_LARGE",
          "The receiver health response exceeded the size limit.",
          false,
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ObservationError(
      "HEALTH_MALFORMED_JSON",
      "The receiver health response was not valid UTF-8 JSON.",
      false,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseHealthPayload(value: unknown): { status: string; database: string } {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    typeof value.database !== "string" ||
    value.status.trim().length === 0 ||
    value.database.trim().length === 0
  ) {
    throw new ObservationError(
      "HEALTH_INVALID_RESPONSE",
      "The receiver health response did not contain the expected fields.",
      false,
    );
  }
  return { status: value.status, database: value.database };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createHealthAdapter(options: HealthAdapterOptions): HealthAdapter {
  const healthUrl = validateHealthUrl(options.healthUrl);
  const timeoutMs = validPositiveBound(
    options.timeoutMs,
    DEFAULT_HEALTH_TIMEOUT_MS,
    120_000,
  );
  const maxResponseBytes = validPositiveBound(
    options.maxResponseBytes,
    DEFAULT_HEALTH_MAX_RESPONSE_BYTES,
    4 * 1024 * 1024,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());

  return {
    async observe(input: HealthInput): Promise<HealthResult> {
      parseHealthInput(input);
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(
            new ObservationError(
              "HEALTH_TIMEOUT",
              "The receiver health observation timed out.",
              true,
            ),
          );
        }, timeoutMs);
      });

      try {
        const response = await Promise.race([
          fetchImpl(healthUrl, {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new ObservationError(
            "HEALTH_REDIRECT",
            "The receiver health endpoint returned a redirect.",
            false,
          );
        }
        const body = await Promise.race([
          readBoundedBody(response, maxResponseBytes),
          timeoutPromise,
        ]);
        let payload: unknown;
        try {
          payload = JSON.parse(body) as unknown;
        } catch {
          throw new ObservationError(
            "HEALTH_MALFORMED_JSON",
            "The receiver health response was not valid JSON.",
            false,
          );
        }
        const parsed = parseHealthPayload(payload);
        const healthy = parsed.status === "ok" && parsed.database === "ok";
        const successfulHttpStatus = response.status >= 200 && response.status < 300;
        if (healthy && !response.ok && !successfulHttpStatus) {
          throw new ObservationError(
            "HEALTH_HTTP_ERROR",
            "The receiver health endpoint returned an unexpected HTTP status.",
            true,
          );
        }
        const observedAt = clock();
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
          throw new ObservationError(
            "HEALTH_INVALID_RESPONSE",
            "The health observation clock is invalid.",
            false,
          );
        }
        return {
          schemaVersion: CONNECTOR_SCHEMA_VERSION,
          healthStatus: healthy ? "HEALTHY" : "UNHEALTHY",
          observedAt: observedAt.toISOString(),
        };
      } catch (error) {
        if (error instanceof ObservationError) throw error;
        if (timedOut || controller.signal.aborted || isAbortError(error)) {
          throw new ObservationError(
            "HEALTH_TIMEOUT",
            "The receiver health observation timed out.",
            true,
          );
        }
        throw new ObservationError(
          "HEALTH_TRANSPORT_ERROR",
          "The receiver health endpoint could not be reached.",
          true,
        );
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    },
  };
}

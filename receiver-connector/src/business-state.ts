import { Pool } from "pg";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { ConfigurationError, ObservationError } from "./errors.js";
import {
  CONNECTOR_SCHEMA_VERSION,
  parseBusinessStateInput,
  type BusinessStateInput,
  type BusinessStateResult,
  type ReceiverBusinessState,
} from "./model.js";

export const BUSINESS_STATE_QUERY =
  "SELECT COUNT(*)::text AS mutation_count FROM business_events WHERE external_ref = $1" as const;

export const DEFAULT_DATABASE_QUERY_TIMEOUT_MS = 5_000 as const;

export interface BusinessStateQueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    config: QueryConfig,
  ): Promise<QueryResult<R>>;
}

export interface BusinessStateAdapter {
  observe(input: BusinessStateInput): Promise<BusinessStateResult>;
  close(): Promise<void>;
}

export interface BusinessStateAdapterOptions {
  readonly databaseUrl?: string;
  readonly client?: BusinessStateQueryClient;
  readonly queryTimeoutMs?: number;
  readonly clock?: () => Date;
}

function isTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  if (
    candidate.code === "57014" ||
    candidate.code === "ETIMEDOUT" ||
    candidate.name === "QueryTimeoutError"
  ) {
    return true;
  }
  return typeof candidate.message === "string" && /timeout/i.test(candidate.message);
}

function parseMutationCount(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new ObservationError(
      "INVALID_DATABASE_RESULT",
      "The business-state observation returned an invalid mutation count.",
      false,
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ObservationError(
      "INVALID_DATABASE_RESULT",
      "The business-state observation returned an invalid mutation count.",
      false,
    );
  }
  return count;
}

function businessStateForCount(mutationCount: number): ReceiverBusinessState {
  if (mutationCount === 0) return "ABSENT";
  if (mutationCount === 1) return "EXACTLY_ONE";
  return "MULTIPLE";
}

function validTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DATABASE_QUERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new ConfigurationError(
      "The database query timeout is invalid.",
    );
  }
  return timeout;
}

export function createBusinessStateAdapter(
  options: BusinessStateAdapterOptions,
): BusinessStateAdapter {
  const queryTimeoutMs = validTimeout(options.queryTimeoutMs);
  if (
    options.client === undefined &&
    (options.databaseUrl === undefined ||
      options.databaseUrl.trim().length === 0 ||
      options.databaseUrl.length > 8192 ||
      /[\u0000-\u001f\u007f]/.test(options.databaseUrl))
  ) {
    throw new ConfigurationError(
      "A local observer database URL is required for business-state observation.",
    );
  }
  const ownedPool = options.client === undefined;
  const client = options.client ?? new Pool({
    connectionString: options.databaseUrl,
    max: 1,
  });
  const clock = options.clock ?? (() => new Date());

  return {
    async observe(input: BusinessStateInput): Promise<BusinessStateResult> {
      const normalizedInput = parseBusinessStateInput(input);
      let result: QueryResult<{ mutation_count: unknown }>;
      try {
        result = await client.query<{ mutation_count: unknown }>({
          text: BUSINESS_STATE_QUERY,
          values: [normalizedInput.deliveryGuid],
          query_timeout: queryTimeoutMs,
        } as QueryConfig & { query_timeout: number });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new ObservationError(
            "DATABASE_TIMEOUT",
            "The business-state observation timed out.",
            true,
          );
        }
        throw new ObservationError(
          "DATABASE_ERROR",
          "The business-state observation failed.",
          true,
        );
      }

      if (!Array.isArray(result.rows) || result.rows.length !== 1) {
        throw new ObservationError(
          "INVALID_DATABASE_RESULT",
          "The business-state observation returned an invalid result.",
          false,
        );
      }
      const mutationCount = parseMutationCount(result.rows[0].mutation_count);
      const observedAt = clock();
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
        throw new ObservationError(
          "INVALID_DATABASE_RESULT",
          "The business-state observation clock is invalid.",
          false,
        );
      }
      return {
        schemaVersion: CONNECTOR_SCHEMA_VERSION,
        deliveryGuid: normalizedInput.deliveryGuid,
        mutationCount,
        businessState: businessStateForCount(mutationCount),
        observedAt: observedAt.toISOString(),
      };
    },

    async close(): Promise<void> {
      if (ownedPool) {
        await (client as Pool).end();
      }
    },
  };
}

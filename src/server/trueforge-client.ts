import {
  TrueForge as TrueForgeSdk,
  TrueForgeError,
} from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";


export const TRUEFORGE_SDK_VERSION = "0.1.4-rc.0" as const;
export const TRUEFORGE_DEFAULT_URL = "http://localhost:8790" as const;
export const TRUEFORGE_REQUEST_TIMEOUT_SECONDS = 15;

export type TrueForgeSessionCreateResult =
  | string
  | {
      id: string;
    };

export interface TrueForgeSessionClient {
  createSession(
    spec: TrueForgeApi.AgentSpec,
  ): Promise<TrueForgeSessionCreateResult>;
  getSession(sessionId: string): Promise<unknown>;
}

export interface TrueForgeTurnClient {
  updateSession(
    sessionId: string,
    spec: TrueForgeApi.AgentSpec,
  ): Promise<void>;
  createTurnStream(
    sessionId: string,
    request: TrueForgeApi.CreateTurnSessionsStreamRequest,
  ): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>>;
}

export type TrueForgeIncidentClient = TrueForgeSessionClient &
  TrueForgeTurnClient;

export class TrueForgeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrueForgeConfigurationError";
  }
}

export type TrueForgeCreateFailureKind = "DEFINITIVE" | "AMBIGUOUS";

export class TrueForgeSessionCreateError extends Error {
  readonly kind: TrueForgeCreateFailureKind;
  readonly statusCode: number | undefined;

  constructor(
    kind: TrueForgeCreateFailureKind,
    message: string,
    options?: ErrorOptions & { statusCode?: number },
  ) {
    super(message, options);
    this.name = "TrueForgeSessionCreateError";
    this.kind = kind;
    this.statusCode = options?.statusCode;
  }
}

export class TrueForgeSessionNotFoundError extends Error {
  constructor(sessionId: string, options?: ErrorOptions) {
    super(`TrueForge session ${sessionId} was not found.`, options);
    this.name = "TrueForgeSessionNotFoundError";
  }
}

export class TrueForgeSessionLookupError extends Error {
  readonly statusCode: number | undefined;

  constructor(
    sessionId: string,
    message: string,
    options?: ErrorOptions & { statusCode?: number },
  ) {
    super(`TrueForge session ${sessionId} could not be read: ${message}`, options);
    this.name = "TrueForgeSessionLookupError";
    this.statusCode = options?.statusCode;
  }
}

export class TrueForgeSessionUpdateError extends Error {
  readonly statusCode: number | undefined;

  constructor(
    sessionId: string,
    message: string,
    options?: ErrorOptions & { statusCode?: number },
  ) {
    super(`TrueForge session ${sessionId} could not be updated: ${message}`, options);
    this.name = "TrueForgeSessionUpdateError";
    this.statusCode = options?.statusCode;
  }
}

export class TrueForgeTurnCreateError extends Error {
  readonly statusCode: number | undefined;

  constructor(
    sessionId: string,
    message: string,
    options?: ErrorOptions & { statusCode?: number },
  ) {
    super(`TrueForge turn for session ${sessionId} could not be created: ${message}`, options);
    this.name = "TrueForgeTurnCreateError";
    this.statusCode = options?.statusCode;
  }
}

function readStatusCode(error: unknown): number | undefined {
  return error instanceof TrueForgeError ? error.statusCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSessionId(response: unknown): string {
  const data = isRecord(response) ? response.data : undefined;
  const id = isRecord(data) ? data.id : undefined;

  if (typeof id !== "string" || id.length === 0) {
    throw new TrueForgeSessionCreateError(
      "AMBIGUOUS",
      "TrueForge returned a session response without a valid ID.",
    );
  }

  return id;
}

const DEFINITIVE_SESSION_CREATE_STATUS_CODES = new Set([400, 404, 422]);

function createFailureKind(
  statusCode: number | undefined,
): TrueForgeCreateFailureKind {
  // The installed SDK maps only these session-create responses to its
  // endpoint-declared errors. Every other status, including 499, is an
  // ambiguous POST outcome because the server may have created the session
  // before the response was observed.
  return statusCode !== undefined &&
    DEFINITIVE_SESSION_CREATE_STATUS_CODES.has(statusCode)
    ? "DEFINITIVE"
    : "AMBIGUOUS";
}

function createErrorFromUnknown(error: unknown): TrueForgeSessionCreateError {
  if (error instanceof TrueForgeSessionCreateError) {
    return error;
  }

  const statusCode = readStatusCode(error);
  const message =
    error instanceof Error ? error.message : "TrueForge session creation failed.";

  return new TrueForgeSessionCreateError(
    createFailureKind(statusCode),
    message,
    {
      cause: error,
      statusCode,
    },
  );
}

function lookupErrorFromUnknown(
  sessionId: string,
  error: unknown,
): TrueForgeSessionLookupError | TrueForgeSessionNotFoundError {
  const statusCode = readStatusCode(error);
  if (statusCode === 404) {
    return new TrueForgeSessionNotFoundError(sessionId, { cause: error });
  }

  const message =
    error instanceof Error ? error.message : "TrueForge session lookup failed.";
  return new TrueForgeSessionLookupError(sessionId, message, {
    cause: error,
    statusCode,
  });
}

function sessionUpdateErrorFromUnknown(
  sessionId: string,
  error: unknown,
): TrueForgeSessionUpdateError {
  const statusCode = readStatusCode(error);
  const message =
    error instanceof Error ? error.message : "TrueForge session update failed.";
  return new TrueForgeSessionUpdateError(sessionId, message, {
    cause: error,
    statusCode,
  });
}

function turnCreateErrorFromUnknown(
  sessionId: string,
  error: unknown,
): TrueForgeTurnCreateError {
  const statusCode = readStatusCode(error);
  const message =
    error instanceof Error ? error.message : "TrueForge turn creation failed.";
  return new TrueForgeTurnCreateError(sessionId, message, {
    cause: error,
    statusCode,
  });
}

export interface TrueForgeClientOptions {
  baseUrl: string;
  token?: string;
  timeoutInSeconds?: number;
}

/**
 * Adapt the bounded TrueForge operations used by the incident spine.
 * Automatic SDK retries are disabled because a retried POST could create a
 * second remote session or turn after an ambiguous response.
 */
export function createTrueForgeClient(
  sdk: TrueForgeSdk,
): TrueForgeIncidentClient {
  return {
    async createSession(spec) {
      try {
        const response = await sdk.sessions.create(
          { agent: { spec } },
          { maxRetries: 0 },
        );
        return readSessionId(response);
      } catch (error) {
        throw createErrorFromUnknown(error);
      }
    },

    async getSession(sessionId) {
      try {
        return await sdk.sessions.get(sessionId, { maxRetries: 0 });
      } catch (error) {
        throw lookupErrorFromUnknown(sessionId, error);
      }
    },

    async updateSession(sessionId, spec) {
      try {
        await sdk.sessions.update(
          sessionId,
          { agent: { spec } },
          { maxRetries: 0 },
        );
      } catch (error) {
        throw sessionUpdateErrorFromUnknown(sessionId, error);
      }
    },

    async createTurnStream(sessionId, request) {
      try {
        return await sdk.sessions.createTurnStream(
          sessionId,
          request,
          { maxRetries: 0 },
        );
      } catch (error) {
        throw turnCreateErrorFromUnknown(sessionId, error);
      }
    },
  };
}

export function getTrueForgeClientOptions(
  environment: NodeJS.ProcessEnv = process.env,
): TrueForgeClientOptions {
  const configuredUrl = environment.REDRIVE_TRUEFORGE_URL;
  if (configuredUrl !== undefined && configuredUrl.trim().length === 0) {
    throw new TrueForgeConfigurationError(
      "REDRIVE_TRUEFORGE_URL must not be empty.",
    );
  }
  const baseUrl =
    configuredUrl === undefined ? TRUEFORGE_DEFAULT_URL : configuredUrl.trim();

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new TrueForgeConfigurationError(
      "REDRIVE_TRUEFORGE_URL must be a valid HTTP(S) URL.",
    );
  }

  const token = environment.REDRIVE_TRUEFORGE_TOKEN;
  return {
    baseUrl,
    ...(token === undefined || token.length === 0 ? {} : { token }),
    timeoutInSeconds: TRUEFORGE_REQUEST_TIMEOUT_SECONDS,
  };
}

export function createConfiguredTrueForgeClient(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): TrueForgeIncidentClient {
  const options = getTrueForgeClientOptions(environment);
  const sdk = new TrueForgeSdk({
    baseUrl: options.baseUrl,
    ...(options.token === undefined ? {} : { token: options.token }),
    fetch: fetchImplementation,
    timeoutInSeconds: options.timeoutInSeconds,
    maxRetries: 0,
  });

  return createTrueForgeClient(sdk);
}


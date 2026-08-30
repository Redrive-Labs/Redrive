import {
  CapabilityValidationError,
  CONNECTOR_SCHEMA_VERSION,
  type CapabilityError,
} from "./model.js";

export type ConnectorErrorCode =
  | "CONFIGURATION_ERROR"
  | "IDENTITY_STATE_ERROR"
  | "DATABASE_TIMEOUT"
  | "DATABASE_ERROR"
  | "INVALID_DATABASE_RESULT"
  | "HEALTH_TIMEOUT"
  | "HEALTH_TRANSPORT_ERROR"
  | "HEALTH_REDIRECT"
  | "HEALTH_RESPONSE_TOO_LARGE"
  | "HEALTH_MALFORMED_JSON"
  | "HEALTH_INVALID_RESPONSE"
  | "HEALTH_HTTP_ERROR"
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_JOB"
  | "INVALID_RESULT"
  | "TRANSPORT_INTEGRATION_PENDING"
  | "TRANSPORT_TIMEOUT"
  | "TRANSPORT_AUTHENTICATION"
  | "TRANSPORT_COMPLETION_FENCED"
  | "TRANSPORT_REJECTED"
  | "TRANSPORT_MALFORMED_RESPONSE"
  | "TRANSPORT_REDIRECT"
  | "TRANSPORT_ERROR";

export type TransportErrorCode =
  | "TRANSPORT_INTEGRATION_PENDING"
  | "TRANSPORT_TIMEOUT"
  | "TRANSPORT_AUTHENTICATION"
  | "TRANSPORT_COMPLETION_FENCED"
  | "TRANSPORT_REJECTED"
  | "TRANSPORT_MALFORMED_RESPONSE"
  | "TRANSPORT_REDIRECT"
  | "TRANSPORT_ERROR";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;

  constructor(code: ConnectorErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ConfigurationError extends ConnectorError {
  constructor(message: string) {
    super("CONFIGURATION_ERROR", message, false);
    this.name = "ConfigurationError";
  }
}

export class IdentityStateError extends ConnectorError {
  constructor(message: string) {
    super("IDENTITY_STATE_ERROR", message, false);
    this.name = "IdentityStateError";
  }
}

export class ObservationError extends ConnectorError {
  constructor(
    code: Exclude<
      ConnectorErrorCode,
      | "CONFIGURATION_ERROR"
      | "IDENTITY_STATE_ERROR"
      | "TRANSPORT_INTEGRATION_PENDING"
      | "TRANSPORT_TIMEOUT"
      | "TRANSPORT_AUTHENTICATION"
      | "TRANSPORT_COMPLETION_FENCED"
      | "TRANSPORT_REJECTED"
      | "TRANSPORT_MALFORMED_RESPONSE"
      | "TRANSPORT_REDIRECT"
      | "TRANSPORT_ERROR"
    >,
    message: string,
    retryable: boolean,
  ) {
    super(code, message, retryable);
    this.name = "ObservationError";
  }
}

export class TransportError extends ConnectorError {
  constructor(code: TransportErrorCode, message: string, retryable: boolean) {
    super(code, message, retryable);
    this.name = "TransportError";
  }
}

export function toCapabilityError(
  error: unknown,
  fallbackCode: ConnectorErrorCode = "TRANSPORT_ERROR",
): CapabilityError {
  if (error instanceof ConnectorError) {
    return Object.freeze({
      schemaVersion: CONNECTOR_SCHEMA_VERSION,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    });
  }
  if (error instanceof CapabilityValidationError) {
    return Object.freeze({
      schemaVersion: CONNECTOR_SCHEMA_VERSION,
      code: error.code,
      message: error.message,
      retryable: false,
    });
  }
  return Object.freeze({
    schemaVersion: CONNECTOR_SCHEMA_VERSION,
    code: fallbackCode,
    message: "The connector could not complete the capability job.",
    retryable: true,
  });
}

export function isRetryableTransportError(error: unknown): boolean {
  if (error instanceof TransportError) return error.retryable;
  return true;
}

export function isCompletionFencedError(error: unknown): boolean {
  return error instanceof TransportError && error.code === "TRANSPORT_COMPLETION_FENCED";
}

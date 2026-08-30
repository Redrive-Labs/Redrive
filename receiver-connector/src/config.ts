import { ConfigurationError } from "./errors.js";

export interface ConnectorConfig {
  readonly redriveUrl: string;
  readonly enrollmentToken: string | undefined;
  readonly observerDatabaseUrl: string;
  readonly receiverHealthUrl: string;
  readonly connectorStateDir: string;
}

type Environment = Record<string, string | undefined>;

function requiredText(environment: Environment, name: string, maximumLength: number): string {
  const value = environment[name];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConfigurationError(`${name} must be configured.`);
  }
  return value;
}

function optionalText(environment: Environment, name: string, maximumLength: number): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConfigurationError(`${name} is invalid.`);
  }
  return value;
}

function parseOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError("REDRIVE_URL must be a valid HTTP(S) origin.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin === "null"
  ) {
    throw new ConfigurationError("REDRIVE_URL must be a valid HTTP(S) origin.");
  }
  return parsed.origin;
}

function parseHealthUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(
      "REDRIVE_RECEIVER_HEALTH_URL must be a valid HTTP(S) URL.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.origin === "null"
  ) {
    throw new ConfigurationError(
      "REDRIVE_RECEIVER_HEALTH_URL must be a valid HTTP(S) URL.",
    );
  }
  return parsed.href;
}

export function loadConfig(environment: Environment = process.env): ConnectorConfig {
  const config = {
    redriveUrl: parseOrigin(requiredText(environment, "REDRIVE_URL", 2048)),
    enrollmentToken: optionalText(environment, "REDRIVE_ENROLLMENT_TOKEN", 4096),
    observerDatabaseUrl: requiredText(
      environment,
      "REDRIVE_OBSERVER_DATABASE_URL",
      8192,
    ),
    receiverHealthUrl: parseHealthUrl(
      requiredText(environment, "REDRIVE_RECEIVER_HEALTH_URL", 4096),
    ),
    connectorStateDir: requiredText(
      environment,
      "REDRIVE_CONNECTOR_STATE_DIR",
      4096,
    ),
  } satisfies ConnectorConfig;
  return Object.freeze(config);
}

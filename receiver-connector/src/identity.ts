import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { IdentityStateError } from "./errors.js";
import {
  CONNECTOR_SCHEMA_VERSION,
  type ConnectorIdentity,
} from "./model.js";

export const CONNECTOR_IDENTITY_FILE_NAME = "identity.json" as const;
export const CONNECTOR_IDENTITY_SCHEMA_VERSION = 2 as const;

export interface IdentityGenerator {
  readonly connectorId: () => string;
  readonly connectorSecret: () => string;
}

export interface LoadOrCreateIdentityOptions {
  readonly stateDir: string;
  readonly serverOrigin: string;
  readonly generator?: IdentityGenerator;
}

export interface LoadedIdentity {
  readonly identity: ConnectorIdentity;
  readonly identityPath: string;
  readonly created: boolean;
  readonly enrollmentAcknowledged: boolean;
}

interface ParsedPersistedIdentity {
  readonly identity: ConnectorIdentity;
  readonly enrollmentAcknowledged: boolean;
}

const defaultGenerator: IdentityGenerator = {
  connectorId: () => randomUUID(),
  connectorSecret: () => randomBytes(32).toString("base64url"),
};

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IdentityStateError("Persisted connector identity is malformed.");
  }
}

function readIdentityText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 8192 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new IdentityStateError("Persisted connector identity is malformed.");
  }
  return value;
}

function parsePersistedIdentity(
  value: unknown,
  expectedServerOrigin: string,
): ParsedPersistedIdentity {
  assertObject(value);
  const schemaVersion = value.schemaVersion;
  const legacyKeys = ["schemaVersion", "serverOrigin", "connectorId", "connectorSecret"];
  const currentKeys = [
    ...legacyKeys,
    "enrollmentAcknowledged",
  ];
  const keys = schemaVersion === 1 ? legacyKeys : currentKeys;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new IdentityStateError("Persisted connector identity is malformed.");
  }
  if (
    schemaVersion !== CONNECTOR_IDENTITY_SCHEMA_VERSION &&
    schemaVersion !== CONNECTOR_SCHEMA_VERSION
  ) {
    throw new IdentityStateError("Persisted connector identity is unsupported.");
  }
  const serverOrigin = readIdentityText(value.serverOrigin);
  if (serverOrigin !== expectedServerOrigin) {
    throw new IdentityStateError("Persisted connector identity belongs to another server origin.");
  }
  const identity = Object.freeze({
    schemaVersion: CONNECTOR_SCHEMA_VERSION,
    serverOrigin,
    connectorId: readIdentityText(value.connectorId),
    connectorSecret: readIdentityText(value.connectorSecret),
  });
  if (schemaVersion === CONNECTOR_SCHEMA_VERSION) {
    return { identity, enrollmentAcknowledged: false };
  }
  if (typeof value.enrollmentAcknowledged !== "boolean") {
    throw new IdentityStateError("Persisted connector identity is malformed.");
  }
  return {
    identity,
    enrollmentAcknowledged: value.enrollmentAcknowledged,
  };
}

function serializedIdentity(
  identity: ConnectorIdentity,
  enrollmentAcknowledged: boolean,
): string {
  return `${JSON.stringify({
    schemaVersion: CONNECTOR_IDENTITY_SCHEMA_VERSION,
    serverOrigin: identity.serverOrigin,
    connectorId: identity.connectorId,
    connectorSecret: identity.connectorSecret,
    enrollmentAcknowledged,
  })}\n`;
}

function persistIdentity(
  identityPath: string,
  identity: ConnectorIdentity,
  enrollmentAcknowledged: boolean,
): void {
  const directory = path.dirname(identityPath);
  const temporaryPath = path.join(
    directory,
    `.${CONNECTOR_IDENTITY_FILE_NAME}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let replaced = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, serializedIdentity(identity, enrollmentAcknowledged), {
      encoding: "utf8",
    });
    chmodSync(temporaryPath, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, identityPath);
    replaced = true;
    fsyncDirectory(directory);
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original persistence error.
      }
    }
    if (!replaced) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
    }
    throw new IdentityStateError("Connector identity state could not be persisted.");
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncIdentityFile(identityPath: string): void {
  const descriptor = openSync(identityPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureIdentityDurable(identityPath: string): void {
  fsyncIdentityFile(identityPath);
  fsyncDirectory(path.dirname(identityPath));
}

function missingDirectoryComponents(directory: string): string[] {
  const missing: string[] = [];
  let current = path.resolve(directory);
  while (!existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing.reverse();
}

function prepareStateDirectory(stateDir: string): void {
  const createdDirectories = missingDirectoryComponents(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    for (const directory of createdDirectories) {
      fsyncDirectory(path.dirname(directory));
    }
  } catch {
    for (const directory of [...createdDirectories].reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // Preserve the original preparation error.
      }
    }
    throw new IdentityStateError("Connector state directory could not be prepared.");
  }
}

function readExistingIdentity(
  identityPath: string,
  serverOrigin: string,
): ParsedPersistedIdentity {
  let raw: string;
  try {
    raw = readFileSync(identityPath, "utf8");
    chmodSync(identityPath, 0o600);
  } catch {
    throw new IdentityStateError("Persisted connector identity could not be read.");
  }
  let parsed: ParsedPersistedIdentity;
  try {
    parsed = parsePersistedIdentity(JSON.parse(raw) as unknown, serverOrigin);
  } catch (error) {
    if (error instanceof IdentityStateError) throw error;
    throw new IdentityStateError("Persisted connector identity is malformed.");
  }
  try {
    ensureIdentityDurable(identityPath);
  } catch {
    throw new IdentityStateError("Connector identity durability could not be confirmed.");
  }
  return parsed;
}

function makeIdentity(
  serverOrigin: string,
  generator: IdentityGenerator,
): ConnectorIdentity {
  const connectorId = generator.connectorId();
  const connectorSecret = generator.connectorSecret();
  if (
    typeof connectorId !== "string" ||
    typeof connectorSecret !== "string" ||
    connectorId.trim().length === 0 ||
    connectorSecret.trim().length === 0
  ) {
    throw new IdentityStateError("Connector identity generation failed.");
  }
  return Object.freeze({
    schemaVersion: CONNECTOR_SCHEMA_VERSION,
    serverOrigin,
    connectorId,
    connectorSecret,
  });
}

export function connectorIdentityPath(stateDir: string): string {
  return path.join(stateDir, CONNECTOR_IDENTITY_FILE_NAME);
}

export function loadOrCreateIdentity(
  options: LoadOrCreateIdentityOptions,
): LoadedIdentity {
  const identityPath = connectorIdentityPath(options.stateDir);
  prepareStateDirectory(options.stateDir);

  if (existsSync(identityPath)) {
    const existing = readExistingIdentity(identityPath, options.serverOrigin);
    return {
      identity: existing.identity,
      identityPath,
      created: false,
      enrollmentAcknowledged: existing.enrollmentAcknowledged,
    };
  }

  const identity = makeIdentity(options.serverOrigin, options.generator ?? defaultGenerator);
  try {
    const descriptor = openSync(identityPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, serializedIdentity(identity, false), {
        encoding: "utf8",
      });
      chmodSync(identityPath, 0o600);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(options.stateDir);
    return {
      identity,
      identityPath,
      created: true,
      enrollmentAcknowledged: false,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readExistingIdentity(identityPath, options.serverOrigin);
      return {
        identity: existing.identity,
        identityPath,
        created: false,
        enrollmentAcknowledged: existing.enrollmentAcknowledged,
      };
    }
    throw new IdentityStateError("Connector identity could not be persisted.");
  }
}

export function markEnrollmentAcknowledged(
  loadedIdentity: LoadedIdentity,
): LoadedIdentity {
  const persisted = readExistingIdentity(
    loadedIdentity.identityPath,
    loadedIdentity.identity.serverOrigin,
  );
  if (
    persisted.identity.connectorId !== loadedIdentity.identity.connectorId ||
    persisted.identity.connectorSecret !== loadedIdentity.identity.connectorSecret
  ) {
    throw new IdentityStateError("Persisted connector identity changed unexpectedly.");
  }
  if (!persisted.enrollmentAcknowledged) {
    persistIdentity(loadedIdentity.identityPath, loadedIdentity.identity, true);
  }
  return {
    ...loadedIdentity,
    enrollmentAcknowledged: true,
  };
}

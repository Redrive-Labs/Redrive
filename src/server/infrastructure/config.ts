import { lstatSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ServerConfig {
  databasePath: string;
  /** Null keeps existing M2.5 non-integration routes usable until configured. */
  publicUrl: string | null;
  secretDir: string;
}

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

const defaultDatabasePath = path.join(
  process.cwd(),
  ".local",
  "redrive.sqlite",
);

function isPosixModeAvailable(stats: Stats): boolean {
  return process.platform !== "win32" && typeof stats.mode === "number";
}

function getTrustedProcessHome(homeDirectory?: string): string {
  let candidate = homeDirectory;
  if (candidate === undefined) {
    try {
      candidate = os.homedir();
    } catch {
      throw new ServerConfigurationError(
        "The Redrive process home directory could not be determined.",
      );
    }
  }

  const trimmed = candidate.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new ServerConfigurationError(
      "The Redrive process home directory must be an absolute path.",
    );
  }

  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new ServerConfigurationError(
      "The Redrive process home directory is not safe.",
    );
  }

  let stats: Stats;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new ServerConfigurationError(
      "The Redrive process home directory could not be inspected.",
    );
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ServerConfigurationError(
      "The Redrive process home directory is not a directory.",
    );
  }
  if (typeof process.getuid === "function" && typeof stats.uid === "number") {
    if (stats.uid !== process.getuid()) {
      throw new ServerConfigurationError(
        "The Redrive process home directory is not owned by the process user.",
      );
    }
  }
  if (isPosixModeAvailable(stats) && (stats.mode & 0o022) !== 0) {
    throw new ServerConfigurationError(
      "The Redrive process home directory is writable by group or other users.",
    );
  }

  return resolved;
}

/**
 * Resolve the default PEM location from the trusted process home, never from
 * request data. The optional home argument is a deterministic test seam.
 */
export function getDefaultSecretDirectory(homeDirectory?: string): string {
  return path.join(getTrustedProcessHome(homeDirectory), ".redrive", "secrets");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * Validate and normalize the operator-supplied public origin. This function is
 * deliberately independent of Request so callback URLs cannot be influenced
 * by Host or forwarding headers.
 */
export function validateRedrivePublicUrl(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServerConfigurationError("REDRIVE_PUBLIC_URL must not be empty.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL must be an absolute URL.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL must use HTTP or HTTPS.",
    );
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL must not contain credentials.",
    );
  }
  if (
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    value.trim().includes("?") ||
    value.trim().includes("#")
  ) {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL must not contain a query or fragment.",
    );
  }
  if (parsed.hostname.length === 0) {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL must include a hostname.",
    );
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL must use HTTPS except for loopback development hosts.",
    );
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${normalizedPath}`;
}

export function getRequiredRedrivePublicUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.REDRIVE_PUBLIC_URL;
  if (configured === undefined) {
    throw new ServerConfigurationError(
      "REDRIVE_PUBLIC_URL is required for GitHub App integration.",
    );
  }
  return validateRedrivePublicUrl(configured);
}

export function deriveRedriveUrl(publicUrl: string, routePath: string): string {
  const base = validateRedrivePublicUrl(publicUrl);
  const relativePath = routePath.replace(/^\/+/, "");
  return new URL(`${relativePath}`, `${base}/`).toString();
}

export function getServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
): ServerConfig {
  const configuredDatabasePath = environment.REDRIVE_DATABASE_PATH;
  const databasePath =
    configuredDatabasePath === undefined
      ? defaultDatabasePath
      : configuredDatabasePath;

  if (databasePath.trim().length === 0) {
    throw new ServerConfigurationError("REDRIVE_DATABASE_PATH must not be empty.");
  }

  const configuredSecretDirectory = environment.REDRIVE_SECRET_DIR;
  const secretDir =
    configuredSecretDirectory === undefined
      ? getDefaultSecretDirectory(homeDirectory)
      : configuredSecretDirectory;
  if (secretDir.trim().length === 0) {
    throw new ServerConfigurationError("REDRIVE_SECRET_DIR must not be empty.");
  }

  return {
    databasePath,
    publicUrl:
      environment.REDRIVE_PUBLIC_URL === undefined
        ? null
        : validateRedrivePublicUrl(environment.REDRIVE_PUBLIC_URL),
    secretDir: path.resolve(secretDir),
  };
}

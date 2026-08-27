import path from "node:path";

export interface ServerConfig {
  databasePath: string;
}

const defaultDatabasePath = path.join(
  process.cwd(),
  ".local",
  "redrive.sqlite",
);

export function getServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const configuredDatabasePath = environment.REDRIVE_DATABASE_PATH;

  if (configuredDatabasePath !== undefined) {
    if (configuredDatabasePath.trim().length === 0) {
      throw new Error("REDRIVE_DATABASE_PATH must not be empty.");
    }

    return { databasePath: configuredDatabasePath };
  }

  return { databasePath: defaultDatabasePath };
}

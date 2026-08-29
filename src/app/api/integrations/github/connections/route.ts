import { NextResponse } from "next/server";
import { getServerConfig, getRequiredRedrivePublicUrl } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { getInstallation, listApplicationConnections } from "@/server/github-app-service";
import { createGithubApi } from "@/server/github-rest";
import { createGithubInstallationAccessService } from "@/server/github-connection-service";
import { FilesystemSecretStore } from "@/server/secret-store";
import { githubErrorResponse, readBoundedJson } from "@/server/github-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const connections = listApplicationConnections(database).map((connection) => {
      const installation = getInstallation(database, connection.githubInstallationId);
      return {
        ...connection,
        ...(installation === null
          ? {}
          : {
              account: {
                id: installation.accountId,
                login: installation.accountLogin,
                type: installation.accountType,
              },
            }),
      };
    });
    return NextResponse.json({ connections });
  } catch (error) {
    return githubErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await readBoundedJson(request);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
    }
    const record = input as Record<string, unknown>;
    const config = getServerConfig();
    getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const service = createGithubInstallationAccessService({
      database,
      api: createGithubApi(),
      secretStore: new FilesystemSecretStore(config.secretDir),
    });
    const result = await service.createConnection({
      installationId: record.installationId,
      repositoryId: record.repositoryId,
      webhookId: record.webhookId,
    });
    return NextResponse.json(
      { connection: result.connection },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return githubErrorResponse(error);
  }
}

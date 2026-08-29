import { NextResponse } from "next/server";
import { getServerConfig, getRequiredRedrivePublicUrl } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { createGithubApi } from "@/server/github-rest";
import { createGithubInstallationAccessService } from "@/server/github-connection-service";
import { FilesystemSecretStore } from "@/server/secret-store";
import { githubErrorResponse } from "@/server/github-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const installationId = params.get("installationId");
  const repositoryId = params.get("repositoryId");
  if (installationId === null || repositoryId === null) {
    return NextResponse.json(
      { error: "installationId and repositoryId are required." },
      { status: 400 },
    );
  }
  try {
    const config = getServerConfig();
    getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const service = createGithubInstallationAccessService({
      database,
      api: createGithubApi(),
      secretStore: new FilesystemSecretStore(config.secretDir),
    });
    const result = await service.listWebhooks(installationId, repositoryId);
    return NextResponse.json({
      repository: result.repository,
      webhooks: result.webhooks,
    });
  } catch (error) {
    return githubErrorResponse(error);
  }
}

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
  const installationId = new URL(request.url).searchParams.get("installationId");
  if (installationId === null || installationId.length === 0) {
    return NextResponse.json({ error: "installationId is required." }, { status: 400 });
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
    return NextResponse.json({ repositories: await service.listRepositories(installationId) });
  } catch (error) {
    return githubErrorResponse(error);
  }
}

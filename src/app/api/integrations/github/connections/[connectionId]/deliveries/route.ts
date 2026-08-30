import { NextResponse } from "next/server";
import { getServerConfig, getRequiredRedrivePublicUrl } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { createGithubApi } from "@/server/github/github-rest";
import { createGithubDeliveryService } from "@/server/github/github-delivery-service";
import { FilesystemSecretStore } from "@/server/infrastructure/secret-store";
import { githubErrorResponse } from "@/server/github/github-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;
  try {
    const config = getServerConfig();
    getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const service = createGithubDeliveryService({
      database,
      api: createGithubApi(),
      secretStore: new FilesystemSecretStore(config.secretDir),
    });
    return NextResponse.json({ deliveries: await service.listFailedDeliveries(connectionId) });
  } catch (error) {
    return githubErrorResponse(error);
  }
}

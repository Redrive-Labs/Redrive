import { NextResponse } from "next/server";
import { getServerConfig, getRequiredRedrivePublicUrl } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { createGithubApi } from "@/server/github/github-rest";
import { createGithubDeliveryService } from "@/server/github/github-delivery-service";
import { FilesystemSecretStore } from "@/server/infrastructure/secret-store";
import { githubErrorResponse, readBoundedJson } from "@/server/github/github-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;
  try {
    const input = await readBoundedJson(request);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
    }
    const deliveryId = (input as Record<string, unknown>).deliveryId;
    const config = getServerConfig();
    getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const deliveryService = createGithubDeliveryService({
      database,
      api: createGithubApi(),
      secretStore: new FilesystemSecretStore(config.secretDir),
    });
    const creation =
      await deliveryService.createIncidentFromVerifiedConnectionDelivery(
        connectionId,
        deliveryId,
      );
    return NextResponse.json(
      { incident: creation.incident },
      { status: creation.created ? 201 : 200 },
    );
  } catch (error) {
    return githubErrorResponse(error);
  }
}

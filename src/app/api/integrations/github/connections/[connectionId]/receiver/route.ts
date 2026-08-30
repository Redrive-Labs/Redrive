import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { getApplicationConnection } from "@/server/github-connection-service";
import {
  getReceiverConnectionForApplication,
} from "@/server/receiver-connection-service";
import {
  receiverErrorResponse,
  requireOperatorSession,
  toSafeReceiverConnection,
} from "@/server/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const unauthorized = requireOperatorSession(request);
  if (unauthorized !== null) return unauthorized;

  try {
    const { connectionId } = await context.params;
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const applicationConnection = getApplicationConnection(database, connectionId);
    if (applicationConnection === null) {
      return NextResponse.json(
        { error: "Application connection was not found." },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }

    const receiverConnection = getReceiverConnectionForApplication(
      database,
      applicationConnection.id,
    );
    const githubReady = applicationConnection.state === "READY";
    const receiverReady = receiverConnection?.state === "READY";
    return NextResponse.json(
      {
        receiverConnection:
          receiverConnection === null
            ? null
            : toSafeReceiverConnection(receiverConnection),
        githubReady,
        receiverReady,
        recoveryReady: githubReady && receiverReady,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return receiverErrorResponse(error, "Receiver status could not be read.");
  }
}

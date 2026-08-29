import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { getApplicationConnection } from "@/server/github-connection-service";
import { getInstallation } from "@/server/github-app-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const { connectionId } = await context.params;
  try {
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const connection = getApplicationConnection(database, connectionId);
    if (connection === null) {
      return NextResponse.json({ error: "Application connection was not found." }, { status: 404 });
    }
    const installation = getInstallation(database, connection.githubInstallationId);
    if (installation === null) {
      return NextResponse.json({ error: "GitHub installation was not found." }, { status: 503 });
    }
    return NextResponse.json({
      connection,
      account: {
        id: installation.accountId,
        login: installation.accountLogin,
        type: installation.accountType,
      },
    });
  } catch {
    return NextResponse.json({ error: "Application connection could not be read." }, { status: 503 });
  }
}

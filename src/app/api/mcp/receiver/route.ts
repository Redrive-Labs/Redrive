import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { createReceiverConnectionService } from "@/server/receiver/receiver-connection-service";
import { createReceiverReadJobTransportService } from "@/server/receiver/receiver-read-job-service";
import { createReceiverMcpServer } from "@/server/receiver/receiver-mcp-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Redrive-owned, read-only Receiver MCP endpoint. Receiver MCP authentication
 * happens inside the server before this lazy service factory can open the
 * database or create a job service.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    return await createReceiverMcpServer({
      getServices: () => {
        const config = getServerConfig();
        const database = getConfiguredDatabase(config.databasePath);
        return {
          database,
          connections: createReceiverConnectionService({ database }),
          jobs: createReceiverReadJobTransportService({ database }),
        };
      },
      environment: process.env,
    }).handleRequest(request);
  } catch {
    return NextResponse.json(
      { error: "Receiver MCP is temporarily unavailable." },
      { status: 503 },
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "Receiver MCP accepts POST requests only." },
    { status: 405, headers: { allow: "POST" } },
  );
}

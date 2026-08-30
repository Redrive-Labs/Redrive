import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { createGithubDeliveryService } from "@/server/github/github-delivery-service";
import { createGithubApi } from "@/server/github/github-rest";
import { createGithubMcpServer } from "@/server/github/github-mcp-server";
import { FilesystemSecretStore } from "@/server/infrastructure/secret-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Redrive-owned, stateless Streamable HTTP endpoint for the production GitHub
 * MCP. The only exposed operation is the connection-bound delivery read.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    return await createGithubMcpServer({
      // Keep all database, configuration, and secret-store construction behind
      // the MCP server's authenticated tools/call boundary. An unauthenticated
      // request must not open the database or inspect local secret state.
      getDeliveryService: () => {
        const config = getServerConfig();
        const database = getConfiguredDatabase(config.databasePath);
        return createGithubDeliveryService({
          database,
          api: createGithubApi(),
          secretStore: new FilesystemSecretStore(config.secretDir),
        });
      },
      environment: process.env,
    }).handleRequest(request);
  } catch {
    // Do not serialize provider, credential, database, or request details.
    return NextResponse.json(
      { error: "GitHub MCP is temporarily unavailable." },
      { status: 503 },
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "GitHub MCP accepts POST requests only." },
    { status: 405, headers: { allow: "POST" } },
  );
}

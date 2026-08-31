import { NextResponse } from "next/server";
import { getRequiredRedrivePublicUrl, getServerConfig, ServerConfigurationError } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { createGithubApi } from "@/server/github/github-rest";
import {
  FilesystemSecretStore,
} from "@/server/infrastructure/secret-store";
import {
  GithubInstallationVerificationError,
  verifyAndPersistGithubInstallation,
} from "@/server/github/github-installation-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

function errorResponse(request: Request, message: string, status: number): Response {
  if (wantsJson(request)) return NextResponse.json({ error: message }, { status });
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GitHub installation</title></head><body><main><h1>GitHub installation needs attention</h1><p>${message}</p><p>Start a new installation attempt from Redrive.</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Validate the state before trusting or using installation_id. The ID is
  // treated as an opaque string and is verified again by GitHub REST.
  const state = url.searchParams.get("state");
  if (state === null || state.length === 0) {
    return errorResponse(request, "The GitHub installation state is required.", 400);
  }
  const installationId = url.searchParams.get("installation_id");
  if (installationId === null || installationId.length === 0) {
    return errorResponse(request, "The GitHub installation identifier is required.", 400);
  }

  let config;
  let publicUrl: string;
  try {
    config = getServerConfig();
    publicUrl = getRequiredRedrivePublicUrl();
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return errorResponse(request, error.message, 503);
    }
    return errorResponse(request, "GitHub installation is unavailable.", 503);
  }

  const database = getConfiguredDatabase(config.databasePath);
  try {
    const result = await verifyAndPersistGithubInstallation({
      database,
      api: createGithubApi(),
      secretStore: new FilesystemSecretStore(config.secretDir),
      state,
      installationId,
    });

    if (wantsJson(request)) {
      return NextResponse.json({
        installation: {
          installationId: result.installation.installationId,
          accountId: result.installation.accountId,
          accountLogin: result.installation.accountLogin,
          accountType: result.installation.accountType,
          repositorySelection: result.installation.repositorySelection,
        },
        repeated: result.repeated,
      });
    }
    const redirect = new URL(`${publicUrl}/`);
    redirect.searchParams.set(
      "githubInstallationId",
      result.installation.installationId,
    );
    return NextResponse.redirect(redirect, 303);
  } catch (error) {
    if (error instanceof GithubInstallationVerificationError) {
      const status =
        error.code === "EXPIRED_STATE"
          ? 410
          : error.code === "ALREADY_CLAIMED"
            ? 409
            : error.code === "INVALID_STATE"
              ? 400
              : 503;
      return errorResponse(request, error.message, status);
    }
    return errorResponse(request, "GitHub installation verification failed safely.", 503);
  }
}

import { NextResponse } from "next/server";
import {
  GithubIntegrationStateError,
  githubLoginsEqual,
} from "@/domain/github-integration";
import {
  claimManifestAttempt,
  completeManifestAttempt,
  createInstallationAttempt,
  getGithubAppRegistration,
  markManifestAttemptRecovery,
  parseManifestConversion,
  recordManifestConversionIdentity,
} from "@/server/github-app-service";
import {
  deriveRedriveUrl,
  getRequiredRedrivePublicUrl,
  getServerConfig,
  ServerConfigurationError,
} from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { createGithubApi, GithubRestError } from "@/server/github-rest";
import {
  FilesystemSecretStore,
  SecretStoreError,
} from "@/server/secret-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

function callbackError(
  request: Request,
  message: string,
  status: number,
): Response {
  if (wantsJson(request)) return NextResponse.json({ error: message }, { status });
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GitHub App connection</title></head><body><main><h1>GitHub App connection needs attention</h1><p>${message}</p><p>Start a new connection attempt from Redrive.</p></main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function callbackSuccess(
  request: Request,
  installationUrl: string,
  registrationId: string,
): Response {
  if (wantsJson(request)) {
    return NextResponse.json({
      registrationId,
      installationUrl,
      status: "APP_CREATED",
    });
  }
  return NextResponse.redirect(installationUrl, 303);
}

function callbackAlreadyCompleted(
  request: Request,
  registrationId: string,
  publicUrl: string,
): Response {
  const installationStartUrl = new URL(
    deriveRedriveUrl(publicUrl, "/api/integrations/github/install/start"),
  );
  installationStartUrl.searchParams.set("registrationId", registrationId);
  if (wantsJson(request)) {
    return NextResponse.json({
      registrationId,
      installationStartUrl: installationStartUrl.toString(),
      status: "APP_ALREADY_CREATED",
    });
  }
  const escapedUrl = installationStartUrl.toString().replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GitHub App already created</title></head><body><main><h1>GitHub App already created</h1><p>This callback has already been completed. Continue with the existing App installation.</p><p><a href="${escapedUrl}">Continue to GitHub installation</a></p></main></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function stateStatusResponse(request: Request, error: GithubIntegrationStateError): Response {
  if (error.code === "EXPIRED_STATE") return callbackError(request, error.message, 410);
  if (error.code === "ALREADY_CLAIMED") return callbackError(request, error.message, 409);
  return callbackError(request, error.message, 400);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // State is checked and claimed before the one-time manifest code is sent to
  // GitHub. The code is never logged or included in any response.
  const state = url.searchParams.get("state");
  if (state === null || state.length === 0) {
    return callbackError(request, "The GitHub App manifest state is required.", 400);
  }
  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) {
    return callbackError(request, "The GitHub App manifest code is required.", 400);
  }

  let config;
  let publicUrl: string;
  try {
    config = getServerConfig();
    publicUrl = getRequiredRedrivePublicUrl();
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return callbackError(request, error.message, 503);
    }
    return callbackError(request, "GitHub App connection is unavailable.", 503);
  }
  const database = getConfiguredDatabase(config.databasePath);
  let claim;
  try {
    claim = claimManifestAttempt(database, state);
  } catch (error) {
    if (error instanceof GithubIntegrationStateError) {
      return stateStatusResponse(request, error);
    }
    return callbackError(request, "The GitHub App manifest state could not be checked.", 503);
  }

  let registration;
  let manifestWasAlreadyCompleted = false;
  if (claim.kind === "completed") {
    manifestWasAlreadyCompleted = true;
    if (claim.attempt.appRegistrationId === null) {
      return callbackError(request, "The completed GitHub App attempt is incomplete.", 503);
    }
    registration = getGithubAppRegistration(database, claim.attempt.appRegistrationId);
    if (registration === null) {
      return callbackError(request, "The completed GitHub App requires recovery.", 503);
    }
  } else if (claim.kind === "recovery") {
    return callbackError(request, "The GitHub App manifest attempt requires recovery.", 503);
  } else {
    const api = createGithubApi();
    let converted: unknown;
    try {
      converted = await api.convertManifest(code);
    } catch (error) {
      markManifestAttemptRecovery(
        database,
        claim.attempt.id,
        error instanceof GithubRestError && error.code === "HTTP"
          ? "GitHub manifest conversion was rejected; remote App state is uncertain."
          : "GitHub manifest conversion outcome is uncertain.",
      );
      return callbackError(
        request,
        "GitHub App creation completed remotely but Redrive could not safely finish the conversion. Recovery is required.",
        503,
      );
    }

    let parsed;
    try {
      parsed = parseManifestConversion(converted);
      if (
        (claim.attempt.targetType === "personal" && parsed.ownerType !== "User") ||
        (claim.attempt.targetType === "organization" &&
          (parsed.ownerType !== "Organization" ||
            !githubLoginsEqual(parsed.ownerLogin, claim.attempt.ownerLogin ?? "")))
      ) {
        throw new Error("GitHub App owner did not match the state-bound target.");
      }
    } catch {
      markManifestAttemptRecovery(
        database,
        claim.attempt.id,
        "GitHub returned an unusable App conversion response.",
      );
      return callbackError(
        request,
        "GitHub created an App response that Redrive could not safely store. Recovery is required.",
        503,
      );
    }

    try {
      recordManifestConversionIdentity(
        database,
        claim.attempt.id,
        parsed.githubAppId,
        parsed.slug,
      );
    } catch {
      markManifestAttemptRecovery(
        database,
        claim.attempt.id,
        "GitHub App identity was received but local attempt state could not be updated.",
      );
      return callbackError(
        request,
        "GitHub App creation completed remotely but Redrive could not preserve its identity safely. Recovery is required.",
        503,
      );
    }

    try {
      new FilesystemSecretStore(config.secretDir).putPrivateKeyForManifestAttempt(
        claim.attempt.id,
        parsed.privateKeyPem,
      );
    } catch (error) {
      markManifestAttemptRecovery(
        database,
        claim.attempt.id,
        "Remote GitHub App identity is durably recorded, but its deterministic private-key reference was not confirmed persisted.",
      );
      if (error instanceof SecretStoreError) {
        return callbackError(
          request,
          "GitHub App creation completed remotely but its private key could not be stored. Recovery is required.",
          503,
        );
      }
      return callbackError(request, "GitHub App connection requires recovery.", 503);
    }

    try {
      registration = completeManifestAttempt(
        database,
        claim.attempt.id,
        parsed,
      );
    } catch {
      markManifestAttemptRecovery(
        database,
        claim.attempt.id,
        "Remote GitHub App identity and deterministic private-key reference were persisted, but final local registration failed.",
      );
      return callbackError(
        request,
        "GitHub App creation completed remotely but Redrive could not persist it safely. Recovery is required.",
        503,
      );
    }
  }

  if (manifestWasAlreadyCompleted) {
    return callbackAlreadyCompleted(request, registration.id, publicUrl);
  }

  try {
    const installation = createInstallationAttempt(database, registration);
    return callbackSuccess(
      request,
      installation.githubInstallationUrl,
      registration.id,
    );
  } catch {
    return callbackError(
      request,
      "The GitHub App was stored, but its installation attempt could not be started. Start a new installation attempt from Redrive.",
      503,
    );
  }
}

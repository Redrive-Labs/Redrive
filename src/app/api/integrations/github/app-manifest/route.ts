import { NextResponse } from "next/server";
import { GithubIntegrationValidationError } from "@/domain/github-integration";
import {
  createManifestAttempt,
} from "@/server/github-app-service";
import {
  getRequiredRedrivePublicUrl,
  getServerConfig,
  ServerConfigurationError,
} from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import {
  GithubRouteBodyError,
  readBoundedBody,
} from "@/server/github-route-utils";
import { MAX_MANIFEST_REQUEST_BODY_BYTES } from "@/server/request-body-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

class ManifestRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestRequestError";
  }
}

async function readRequestInput(request: Request): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = await readBoundedBody(request, MAX_MANIFEST_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof GithubRouteBodyError) {
      throw new ManifestRequestError(error.message);
    }
    throw error;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ManifestRequestError("Request body contains malformed UTF-8.");
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text);
    return {
      targetType: form.get("targetType") ?? form.get("target"),
      ownerLogin: form.get("ownerLogin") || undefined,
    };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ManifestRequestError("Request body must be valid JSON or form data.");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ManifestRequestError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof GithubIntegrationValidationError) {
    return NextResponse.json(
      { error: error.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof ServerConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json(
    { error: "GitHub App manifest setup is unavailable." },
    { status: 503 },
  );
}

function manifestForm(
  githubRegistrationUrl: string,
  manifest: object,
): Response {
  const encodedManifest = escapeHtml(JSON.stringify(manifest));
  const encodedAction = escapeHtml(githubRegistrationUrl);
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Continue to GitHub</title></head>
  <body>
    <main>
      <h1>Continue to GitHub</h1>
      <p>Review the narrowly scoped Redrive GitHub App, then create it.</p>
      <form method="post" action="${encodedAction}">
        <input type="hidden" name="manifest" value="${encodedManifest}">
        <button type="submit">Create GitHub App</button>
      </form>
    </main>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await readRequestInput(request);
    const config = getServerConfig();
    const publicUrl = getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const created = createManifestAttempt(database, input, publicUrl);

    if (wantsJson(request)) {
      return NextResponse.json({
        attemptId: created.attempt.id,
        expiresAt: created.attempt.expiresAt,
        githubRegistrationUrl: created.githubRegistrationUrl,
        manifest: created.manifest,
      });
    }
    return manifestForm(created.githubRegistrationUrl, created.manifest);
  } catch (error) {
    return errorResponse(error);
  }
}

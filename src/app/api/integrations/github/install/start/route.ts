import { NextResponse } from "next/server";
import { getServerConfig, getRequiredRedrivePublicUrl, ServerConfigurationError } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { getGithubAppRegistration, createInstallationAttempt } from "@/server/github/github-app-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const registrationId = new URL(request.url).searchParams.get("registrationId");
  if (registrationId === null || registrationId.length === 0) {
    return NextResponse.json({ error: "A GitHub App registration is required." }, { status: 400 });
  }
  try {
    const config = getServerConfig();
    getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const registration = getGithubAppRegistration(database, registrationId);
    if (registration === null) {
      return NextResponse.json({ error: "GitHub App registration was not found." }, { status: 404 });
    }
    const attempt = createInstallationAttempt(database, registration);
    return NextResponse.redirect(attempt.githubInstallationUrl, 303);
  } catch (error) {
    if (error instanceof ServerConfigurationError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "GitHub installation is unavailable." }, { status: 503 });
  }
}

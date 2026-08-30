import { NextResponse } from "next/server";
import { RecoverySandboxConfigurationError } from "@/agents/recovery-sandbox-agent";
import {
  RecoverySandboxAttemptStateError,
  RecoverySandboxIncidentNotFoundError,
  RecoverySandboxPrerequisiteError,
  RecoverySandboxSessionError,
  RecoverySandboxTurnError,
  startSandboxRecovery,
} from "@/server/recovery-sandbox-service";
import {
  TrueForgeConfigurationError,
  TrueForgeSessionCreateError,
} from "@/server/trueforge-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RecoverySandboxRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function POST(
  _request: Request,
  context: RecoverySandboxRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;

  try {
    const result = await startSandboxRecovery(incidentId);
    return NextResponse.json(result);
  } catch (error) {
    return recoverySandboxErrorResponse(error);
  }
}

function recoverySandboxErrorResponse(error: unknown): Response {
  if (error instanceof RecoverySandboxIncidentNotFoundError) {
    return NextResponse.json({ error: "Incident not found." }, { status: 404 });
  }
  if (error instanceof RecoverySandboxPrerequisiteError) {
    return NextResponse.json(
      { error: "The incident is not eligible for sandbox recovery." },
      { status: 422 },
    );
  }
  if (error instanceof RecoverySandboxAttemptStateError) {
    return NextResponse.json(
      { error: "Sandbox recovery is already running or is blocked." },
      { status: 409 },
    );
  }
  if (
    error instanceof RecoverySandboxConfigurationError ||
    error instanceof TrueForgeConfigurationError
  ) {
    return NextResponse.json(
      { error: "Sandbox recovery is not configured." },
      { status: 503 },
    );
  }
  if (error instanceof RecoverySandboxSessionError) {
    return NextResponse.json(
      { error: "The recovery sandbox session is not ready." },
      { status: 503 },
    );
  }
  if (
    error instanceof RecoverySandboxTurnError ||
    error instanceof TrueForgeSessionCreateError
  ) {
    return NextResponse.json(
      { error: "The sandbox recovery turn did not produce a verified repair." },
      { status: 502 },
    );
  }

  console.error("Unable to run sandbox recovery.", error);
  return NextResponse.json(
    { error: "Unable to run sandbox recovery." },
    { status: 500 },
  );
}

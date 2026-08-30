import { NextResponse } from "next/server";
import {
  approveDeploymentPermit,
  DeploymentConfigurationError,
  DeploymentFingerprintMismatchError,
  DeploymentNotEligibleError,
  DeploymentNotFoundError,
  DeploymentPermitError,
} from "@/server/recovery/recovery-deployment-service";
import {
  readReceiverJson,
  ReceiverRouteBodyError,
  requireOperatorSession,
} from "@/server/receiver/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readFingerprint(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("fingerprint" in value)) {
    throw new ReceiverRouteBodyError(
      "Deploy permit request must contain only fingerprint.",
    );
  }
  if (typeof value.fingerprint !== "string" || value.fingerprint.length !== 64) {
    throw new ReceiverRouteBodyError("Deploy permit fingerprint is invalid.");
  }
  return value.fingerprint;
}

function response(body: unknown, status = 200): Response {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  const unauthorized = requireOperatorSession(request);
  if (unauthorized !== null) return unauthorized;

  try {
    const body = await readReceiverJson(request);
    const fingerprint = readFingerprint(body);
    const { incidentId } = await context.params;
    return response(approveDeploymentPermit(incidentId, fingerprint));
  } catch (error) {
    if (error instanceof ReceiverRouteBodyError) {
      return response({ error: error.message }, 400);
    }
    if (error instanceof DeploymentNotFoundError) {
      return response({ error: error.message }, 404);
    }
    if (error instanceof DeploymentConfigurationError) {
      return response({ error: error.message }, 503);
    }
    if (error instanceof DeploymentFingerprintMismatchError || error instanceof DeploymentNotEligibleError || error instanceof DeploymentPermitError) {
      return response({ error: error.message }, 409);
    }
    console.error("Unable to approve the deployment permit.", error);
    return response({ error: "Unable to approve the deployment permit." }, 500);
  }
}

export async function GET(): Promise<Response> {
  return response(
    { error: "Deploy permit approval accepts POST requests only." },
    405,
  );
}

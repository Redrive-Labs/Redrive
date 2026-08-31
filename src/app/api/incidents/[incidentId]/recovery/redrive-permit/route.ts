import { NextResponse } from "next/server";
import {
  readReceiverJson,
  ReceiverRouteBodyError,
  requireOperatorSession,
} from "@/server/receiver/receiver-route-utils";
import {
  createConfiguredRedriveService,
  parseRedrivePermitRequest,
  RedriveError,
  RedriveRequestError,
} from "@/server/recovery/redrive-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  const unauthorized = requireOperatorSession(request);
  if (unauthorized !== null) return unauthorized;

  try {
    const { incidentId } = await context.params;
    const body = parseRedrivePermitRequest(await readReceiverJson(request));
    const permit = await createConfiguredRedriveService().approve(
      incidentId,
      body.fingerprint,
    );
    return NextResponse.json({ permit });
  } catch (error) {
    return redriveRouteErrorResponse(error);
  }
}

function redriveRouteErrorResponse(error: unknown): Response {
  if (error instanceof ReceiverRouteBodyError || error instanceof RedriveRequestError) {
    return NextResponse.json({ error: error.message }, { status: error instanceof ReceiverRouteBodyError ? error.status : 400 });
  }
  if (error instanceof RedriveError) {
    const status =
      error.code === "NOT_FOUND" ? 404
      : error.code === "INVALID_INPUT" ? 400
      : error.code === "INELIGIBLE" || error.code === "PRECONDITION_FAILED" ? 422
      : 409;
    return NextResponse.json({ error: error.message }, { status });
  }
  console.error("Unable to approve redrive permit.", error);
  return NextResponse.json({ error: "Unable to approve redrive permit." }, { status: 503 });
}

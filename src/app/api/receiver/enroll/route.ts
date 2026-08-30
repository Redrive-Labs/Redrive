import { NextResponse } from "next/server";
import { parseReceiverEnrollment } from "@/domain/receiver-connector";
import { getServerConfig } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { createReceiverEnrollmentService } from "@/server/receiver-connection-service";
import {
  readReceiverJson,
  receiverErrorResponse,
  toSafeReceiverConnection,
} from "@/server/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await readReceiverJson(request);
    parseReceiverEnrollment(input);
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const service = createReceiverEnrollmentService({ database });
    const result = service.enroll(input);
    return NextResponse.json(
      {
        receiverConnection: toSafeReceiverConnection(result.receiverConnection),
        disposition: result.disposition,
        healthJobId: result.healthJobId,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return receiverErrorResponse(error, "Receiver enrollment failed.");
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "Receiver enrollment accepts POST requests only." },
    { status: 405, headers: { allow: "POST" } },
  );
}

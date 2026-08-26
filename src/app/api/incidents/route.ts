import { NextResponse } from "next/server";
import { IncidentValidationError } from "@/domain/incident";
import {
  createIncident,
  listIncidents,
} from "@/server/incident-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json({ incidents: await listIncidents() });
  } catch (error) {
    console.error("Unable to list incidents.", error);
    return NextResponse.json(
      { error: "Unable to load incidents." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let input: unknown;
  let isNativeFormSubmission = false;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const isFormEncoded =
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("multipart/form-data");

    if (isFormEncoded) {
      const formData = await request.formData();
      isNativeFormSubmission = true;
      input = {
        provider: formData.get("provider"),
        externalDeliveryId: formData.get("externalDeliveryId"),
        repositoryId: formData.get("repositoryId"),
      };
    } else {
      input = await request.json();
    }
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON or form data." },
      { status: 400 },
    );
  }

  try {
    const incident = await createIncident(input);

    if (isNativeFormSubmission) {
      return NextResponse.redirect(new URL("/", request.url), 303);
    }

    return NextResponse.json({ incident }, { status: 201 });
  } catch (error) {
    if (error instanceof IncidentValidationError) {
      return NextResponse.json(
        {
          error: error.message,
          issues: error.issues,
        },
        { status: 400 },
      );
    }

    console.error("Unable to create incident.", error);
    return NextResponse.json(
      { error: "Unable to create incident." },
      { status: 500 },
    );
  }
}

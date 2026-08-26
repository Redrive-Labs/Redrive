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

  try {
    input = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  try {
    const incident = await createIncident(input);
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

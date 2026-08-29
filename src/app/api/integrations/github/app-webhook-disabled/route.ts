import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The manifest requires a hook URL, but this App is not an event receiver. */
export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "The Redrive GitHub App webhook is intentionally disabled." },
    { status: 410 },
  );
}

export async function POST(): Promise<Response> {
  return NextResponse.json(
    { error: "The Redrive GitHub App webhook is intentionally disabled." },
    { status: 410 },
  );
}

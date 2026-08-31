import { NextResponse } from "next/server";
import { IncidentIdentityConflictError } from "@/server/incidents/incident-service";
import { GithubConnectionError } from "@/server/github/github-connection-service";
import { GithubIntegrationValidationError } from "@/domain/github-integration";
import { ServerConfigurationError } from "@/server/infrastructure/config";

export class GithubRouteBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubRouteBodyError";
  }
}

export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new GithubRouteBodyError("Request body is too large.");
    }
  }

  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded size error is the useful failure.
        }
        throw new GithubRouteBodyError("Request body is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A stream error may already have released the lock.
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedJson(
  request: Request,
  maxBytes = 32 * 1024,
): Promise<unknown> {
  const body = await readBoundedBody(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new GithubRouteBodyError("Request body contains malformed UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GithubRouteBodyError("Request body must be valid JSON.");
  }
}

export function githubErrorResponse(error: unknown): Response {
  if (error instanceof GithubRouteBodyError || error instanceof GithubIntegrationValidationError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error instanceof GithubIntegrationValidationError
          ? { issues: error.issues }
          : {}),
      },
      { status: 400 },
    );
  }
  if (error instanceof IncidentIdentityConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof GithubConnectionError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "INVALID_INPUT"
          ? 400
          : error.code === "NOT_ACCESSIBLE"
            ? 502
            : error.code === "REMOTE_INVALID"
              ? 502
              : 503;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (error instanceof ServerConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json(
    { error: "GitHub integration request failed safely." },
    { status: 503 },
  );
}

import { NextResponse } from "next/server";
import { IncidentValidationError } from "@/domain/incident";
import {
  createIncident,
  listIncidents,
} from "@/server/incident-service";

export const MAX_INCIDENT_REQUEST_BODY_BYTES = 8 * 1024;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "RequestBodyTooLargeError";
  }
}

async function readBoundedRequestBody(
  request: Request,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");

  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_INCIDENT_REQUEST_BODY_BYTES
  ) {
    throw new RequestBodyTooLargeError();
  }

  if (request.body === null) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_INCIDENT_REQUEST_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request is already being rejected; cancellation is best effort.
        }

        throw new RequestBodyTooLargeError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function requestBodyTooLargeResponse(): Response {
  return NextResponse.json(
    { error: "Request body is too large." },
    { status: 413 },
  );
}

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
  const contentType = request.headers.get("content-type") ?? "";
  const isFormEncoded =
    contentType.startsWith("application/x-www-form-urlencoded") ||
    contentType.startsWith("multipart/form-data");
  let requestBody: Uint8Array;

  try {
    requestBody = await readBoundedRequestBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return requestBodyTooLargeResponse();
    }

    return NextResponse.json(
      { error: "Request body must be valid JSON or form data." },
      { status: 400 },
    );
  }

  try {
    if (isFormEncoded) {
      const parseHeaders = new Headers(request.headers);
      parseHeaders.delete("content-length");
      const parseRequest = new Request(request.url, {
        body: Buffer.from(requestBody) as unknown as BodyInit,
        headers: parseHeaders,
        method: request.method,
      });
      const formData = await parseRequest.formData();
      isNativeFormSubmission = true;
      input = {
        provider: formData.get("provider"),
        externalDeliveryId: formData.get("externalDeliveryId"),
        repositoryId: formData.get("repositoryId"),
      };
    } else {
      input = JSON.parse(new TextDecoder().decode(requestBody));
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

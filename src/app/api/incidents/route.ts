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

class MalformedUtf8Error extends Error {
  constructor() {
    super("Request body contains malformed UTF-8.");
    this.name = "MalformedUtf8Error";
  }
}

class MalformedFormEncodingError extends Error {
  constructor() {
    super("Request body contains malformed form encoding.");
    this.name = "MalformedFormEncodingError";
  }
}

function decodeFormComponent(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/g, " "));
  } catch (error) {
    if (error instanceof URIError) {
      throw new MalformedFormEncodingError();
    }

    throw error;
  }
}

function parseUrlEncodedForm(body: string): {
  input: {
    provider: string | null;
    externalDeliveryId: string | null;
    repositoryId: string | null;
  };
  connectionShaped: boolean;
} {
  const fields = new Map<string, string>();

  for (const pair of body.split("&")) {
    if (pair.length === 0) {
      continue;
    }

    const separator = pair.indexOf("=");
    const encodedName = separator === -1 ? pair : pair.slice(0, separator);
    const encodedValue = separator === -1 ? "" : pair.slice(separator + 1);
    const name = decodeFormComponent(encodedName);
    const value = decodeFormComponent(encodedValue);

    if (!fields.has(name)) {
      fields.set(name, value);
    }
  }

  return {
    input: {
      provider: fields.get("provider") ?? null,
      externalDeliveryId: fields.get("externalDeliveryId") ?? null,
      repositoryId: fields.get("repositoryId") ?? null,
    },
    connectionShaped:
      fields.has("applicationConnectionId") || fields.has("deliveryId"),
  };
}

function decodeStrictUtf8(requestBody: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(requestBody);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new MalformedUtf8Error();
    }

    throw error;
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

function invalidRequestBodyResponse(): Response {
  return NextResponse.json(
    { error: "Request body must be valid JSON or form data." },
    { status: 400 },
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
  const isUrlEncodedForm = contentType.toLowerCase().startsWith(
    "application/x-www-form-urlencoded",
  );
  const isUnsupportedMultipartForm = contentType.startsWith(
    "multipart/form-data",
  );
  let requestBody: Uint8Array;

  try {
    requestBody = await readBoundedRequestBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return requestBodyTooLargeResponse();
    }

    console.error("Unable to read incident request body.", error);
    return NextResponse.json(
      { error: "Unable to read incident request body." },
      { status: 500 },
    );
  }

  if (isUnsupportedMultipartForm) {
    return invalidRequestBodyResponse();
  }

  let decodedRequestBody: string;

  try {
    decodedRequestBody = decodeStrictUtf8(requestBody);
  } catch (error) {
    if (error instanceof MalformedUtf8Error) {
      return invalidRequestBodyResponse();
    }

    console.error("Unable to decode incident request body.", error);
    return NextResponse.json(
      { error: "Unable to decode incident request body." },
      { status: 500 },
    );
  }

  if (isUrlEncodedForm) {
    try {
      const parsedForm = parseUrlEncodedForm(decodedRequestBody);
      if (parsedForm.connectionShaped) {
        return invalidRequestBodyResponse();
      }
      input = parsedForm.input;
    } catch (error) {
      if (error instanceof MalformedFormEncodingError) {
        return invalidRequestBodyResponse();
      }

      console.error("Unable to parse incident request body.", error);
      return NextResponse.json(
        { error: "Unable to parse incident request body." },
        { status: 500 },
      );
    }

    isNativeFormSubmission = true;
  } else {
    try {
      input = JSON.parse(decodedRequestBody);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return invalidRequestBodyResponse();
      }

      console.error("Unable to parse incident request body.", error);
      return NextResponse.json(
        { error: "Unable to parse incident request body." },
        { status: 500 },
      );
    }
  }

  try {
    const creation = await createIncident(input);

    if (isNativeFormSubmission) {
      return NextResponse.redirect(new URL("/", request.url), 303);
    }

    return NextResponse.json(
      { incident: creation.incident },
      { status: creation.created ? 201 : 200 },
    );
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

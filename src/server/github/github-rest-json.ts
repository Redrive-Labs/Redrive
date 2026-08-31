import { MAX_JSON_NUMERIC_LITERAL_CHARS } from "@/server/github/github-mcp";

export const MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS =
  MAX_JSON_NUMERIC_LITERAL_CHARS;

export class GithubRestJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubRestJsonError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const JSON_NUMBER_PATTERN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const MAX_NORMALIZED_DECIMAL_EXPONENT =
  MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS * 2;
const MAX_SAFE_INTEGER_DECIMAL = String(Number.MAX_SAFE_INTEGER);

type NormalizedDecimal =
  | { kind: "zero" }
  | {
      kind: "nonzero";
      sign: 1 | -1;
      coefficient: string;
      exponent: number;
    };

function addBoundedDecimalExponent(left: number, right: number): number {
  return Math.max(
    -MAX_NORMALIZED_DECIMAL_EXPONENT,
    Math.min(MAX_NORMALIZED_DECIMAL_EXPONENT, left + right),
  );
}

function parseBoundedDecimalExponent(text: string): number {
  let sign = 1;
  let start = 0;
  if (text[0] === "-" || text[0] === "+") {
    sign = text[0] === "-" ? -1 : 1;
    start = 1;
  }

  let magnitude = 0;
  for (let index = start; index < text.length; index += 1) {
    const digit = text.charCodeAt(index) - 48;
    if (
      magnitude >
      Math.floor((MAX_NORMALIZED_DECIMAL_EXPONENT - digit) / 10)
    ) {
      return sign * MAX_NORMALIZED_DECIMAL_EXPONENT;
    }
    magnitude = magnitude * 10 + digit;
  }

  return magnitude === 0 ? 0 : sign * magnitude;
}

function normalizeDecimalLiteral(literal: string): NormalizedDecimal {
  const match = literal.match(
    /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/,
  );
  if (match === null) {
    throw new GithubRestJsonError("GitHub REST returned invalid JSON.");
  }

  const [, signText, whole, fraction = "", exponentText = "0"] = match;
  let digits = `${whole}${fraction}`;
  const firstNonzero = digits.search(/[1-9]/);
  if (firstNonzero === -1) {
    return { kind: "zero" };
  }

  digits = digits.slice(firstNonzero);
  const coefficient = digits.replace(/0+$/, "");
  const trailingZeroCount = digits.length - coefficient.length;
  let exponent = parseBoundedDecimalExponent(exponentText);
  exponent = addBoundedDecimalExponent(exponent, -fraction.length);
  exponent = addBoundedDecimalExponent(exponent, trailingZeroCount);

  return {
    kind: "nonzero",
    sign: signText === "-" ? -1 : 1,
    coefficient,
    exponent,
  };
}

function decimalValuesAreEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeDecimalLiteral(left);
  const normalizedRight = normalizeDecimalLiteral(right);

  if (normalizedLeft.kind === "zero" || normalizedRight.kind === "zero") {
    return normalizedLeft.kind === "zero" && normalizedRight.kind === "zero";
  }

  return (
    normalizedLeft.sign === normalizedRight.sign &&
    normalizedLeft.coefficient === normalizedRight.coefficient &&
    normalizedLeft.exponent === normalizedRight.exponent
  );
}

function isUnsafeIntegerLiteral(literal: string): boolean {
  const normalized = normalizeDecimalLiteral(literal);
  if (normalized.kind === "zero" || normalized.exponent < 0) return false;

  const integerDigitCount =
    normalized.coefficient.length + normalized.exponent;
  if (integerDigitCount > MAX_SAFE_INTEGER_DECIMAL.length) return true;
  if (integerDigitCount < MAX_SAFE_INTEGER_DECIMAL.length) return false;

  const integer = normalized.coefficient.padEnd(
    MAX_SAFE_INTEGER_DECIMAL.length,
    "0",
  );
  return integer > MAX_SAFE_INTEGER_DECIMAL;
}

const MAX_FINITE_INTEGER_DIGITS = 309;
const MAX_FINITE_INTEGER_AT_MAX_DIGITS =
  "17976931348623157".padEnd(MAX_FINITE_INTEGER_DIGITS, "0");

function isFiniteIntegerLiteral(literal: string): boolean {
  const normalized = normalizeDecimalLiteral(literal);
  if (normalized.kind === "zero" || normalized.exponent < 0) return true;

  const integerDigitCount = normalized.coefficient.length + normalized.exponent;
  if (integerDigitCount < MAX_FINITE_INTEGER_DIGITS) return true;
  if (integerDigitCount > MAX_FINITE_INTEGER_DIGITS) return false;

  const integer = normalized.coefficient.padEnd(
    MAX_FINITE_INTEGER_DIGITS,
    "0",
  );
  return integer <= MAX_FINITE_INTEGER_AT_MAX_DIGITS;
}

function isFaithfullyRepresentedNumberLiteral(literal: string): boolean {
  const value = Number(literal);
  if (!Number.isFinite(value)) return false;
  const serialized = JSON.stringify(value);
  return (
    typeof serialized === "string" &&
    decimalValuesAreEqual(literal, serialized)
  );
}

/**
 * JSON.parse rounds large integer tokens before application code can inspect
 * them. This scanner protects every unsafe integer token before parsing and
 * returns the exact lexical token as a string. Other numbers are accepted only
 * when JavaScript can represent them faithfully. It is intentionally generic:
 * REST consumers can then treat every provider identifier as an opaque string.
 */
export function parseGithubRestJson(text: string): unknown {
  const protectedText: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      protectedText.push(character);
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      protectedText.push(character);
      continue;
    }

    if (character === "-" || /[0-9]/.test(character)) {
      const match = text.slice(index).match(JSON_NUMBER_PATTERN);
      if (match !== null) {
        const literal = match[0];
        if (literal.length > MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS) {
          throw new GithubRestJsonError(
            "GitHub REST returned a JSON numeric literal that is too long.",
          );
        }

        if (isUnsafeIntegerLiteral(literal)) {
          // An integer identifier may be larger than the safe range, but it
          // must still be a finite JSON number. This magnitude check is
          // lexical so the identifier itself never passes through Number.
          if (!isFiniteIntegerLiteral(literal)) {
            throw new GithubRestJsonError(
              "GitHub REST returned a numeric value that cannot be represented faithfully.",
            );
          }
          protectedText.push(JSON.stringify(literal));
        } else {
          if (!isFaithfullyRepresentedNumberLiteral(literal)) {
            throw new GithubRestJsonError(
              "GitHub REST returned a numeric value that cannot be represented faithfully.",
            );
          }
          protectedText.push(literal);
        }
        index += literal.length - 1;
        continue;
      }
    }

    protectedText.push(character);
  }

  try {
    return JSON.parse(protectedText.join("")) as unknown;
  } catch {
    throw new GithubRestJsonError("GitHub REST returned invalid JSON.");
  }
}

// GitHub permits webhook payloads up to 25 MiB. Keep REST reads bounded with
// headroom for delivery metadata; the MCP boundary separately bounds the final
// JSON-RPC envelope after its text content has been escaped.
export const MAX_GITHUB_REST_RESPONSE_BYTES = 32 * 1024 * 1024;

async function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function readGithubRestResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_GITHUB_REST_RESPONSE_BYTES,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new GithubRestJsonError("GitHub REST response is too large.");
    }
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await readChunkWithAbort(reader, signal);
      if (chunk.done) {
        text += decoder.decode();
        return text;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The bounded size error is the useful failure.
        }
        throw new GithubRestJsonError("GitHub REST response is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new GithubRestJsonError("GitHub REST response is not valid UTF-8.");
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted pending read may already own the lock.
    }
  }
}

export async function readGithubRestJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    mediaType !== "application/json" &&
    mediaType !== "application/vnd.github+json"
  ) {
    throw new GithubRestJsonError("GitHub REST returned an unsupported media type.");
  }
  const text = await readGithubRestResponseText(response, signal);
  return parseGithubRestJson(text);
}

export function isGithubRestRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value);
}

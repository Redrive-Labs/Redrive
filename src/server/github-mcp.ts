import { randomUUID } from "node:crypto";

export const GITHUB_WEBHOOK_DELIVERY_TOOL = "get_webhook_delivery" as const;
export const MAX_JSON_NUMERIC_LITERAL_CHARS = 4096;

export interface GithubWebhookDeliveryLookup {
  repositoryId: string;
  deliveryId: string;
}

export class GithubMcpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GithubMcpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const JSON_NUMBER_PATTERN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const MAX_NORMALIZED_DECIMAL_EXPONENT = MAX_JSON_NUMERIC_LITERAL_CHARS * 2;
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

/**
 * Parse an exponent without converting an attacker-controlled decimal string
 * to BigInt. Values beyond the bound cannot equal the exponent emitted for a
 * finite JavaScript Number, even after the bounded mantissa adjustment.
 */
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
    throw new GithubMcpError("GitHub MCP returned invalid JSON.");
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
 * The proven tool result is `full.body`. Preserve an unsafe integer only when
 * it is the provider attempt ID at `full.body.id`. Any other unsafe integer is
 * rejected because JSON.parse would silently round webhook payload data.
 */
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

export function parseGithubMcpToolResultJson(text: string): unknown {
  const unsafeIntegerSentinel = randomUUID();
  const unsafeIntegers: string[] = [];
  let protectedText = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      protectedText += character;
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
      protectedText += character;
      continue;
    }

    if (character === "-" || /[0-9]/.test(character)) {
      const match = text.slice(index).match(JSON_NUMBER_PATTERN);
      if (match !== null) {
        const literal = match[0];
        if (literal.length > MAX_JSON_NUMERIC_LITERAL_CHARS) {
          throw new GithubMcpError(
            "GitHub MCP returned a JSON numeric literal that is too long.",
          );
        }

        if (isUnsafeIntegerLiteral(literal)) {
          unsafeIntegers.push(literal);
          protectedText += `{"__redriveUnsafeInteger":${JSON.stringify(
            unsafeIntegerSentinel,
          )}}`;
        } else {
          if (!isFaithfullyRepresentedNumberLiteral(literal)) {
            throw new GithubMcpError(
              "GitHub MCP returned a numeric value that cannot be represented faithfully.",
            );
          }
          protectedText += literal;
        }
        index += literal.length - 1;
        continue;
      }
    }

    protectedText += character;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(protectedText) as unknown;
  } catch {
    throw new GithubMcpError("GitHub MCP returned invalid JSON.");
  }

  if (unsafeIntegers.length === 0) {
    return parsed;
  }

  const root = isRecord(parsed) ? parsed : null;
  const full = root !== null && isRecord(root.full) ? root.full : null;
  const body = full !== null && isRecord(full.body) ? full.body : null;
  const marker = body !== null && isRecord(body.id) ? body.id : null;

  if (
    unsafeIntegers.length !== 1 ||
    body === null ||
    marker === null ||
    Object.keys(marker).length !== 1 ||
    marker.__redriveUnsafeInteger !== unsafeIntegerSentinel
  ) {
    throw new GithubMcpError(
      "GitHub MCP returned an unsafe integer outside full.body.id.",
    );
  }

  body.id = unsafeIntegers[0];
  return parsed;
}

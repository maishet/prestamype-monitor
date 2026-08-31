import { redactSensitiveText } from "../security/redaction.js";

export type RuntimeErrorKind =
  | "SessionExpiredError"
  | "SessionChallengeError"
  | "RateLimitError"
  | "PageStructureError"
  | "RuntimeError";

export interface StoredRuntimeError {
  readonly class: RuntimeErrorKind;
  readonly message: string;
  readonly timestamp: string;
  readonly requestId?: string;
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/;

export class LambdaRuntimeError extends Error {
  constructor(message = "Lambda runtime is not configured") {
    super(message);
    this.name = "LambdaRuntimeError";
  }
}

export function runtimeErrorKind(error: unknown): RuntimeErrorKind {
  try {
    if (!(error instanceof Error)) return "RuntimeError";
    const name = error.name;
    return [
      "SessionExpiredError",
      "SessionChallengeError",
      "RateLimitError",
      "PageStructureError",
    ].includes(name)
      ? (name as RuntimeErrorKind)
      : "RuntimeError";
  } catch {
    return "RuntimeError";
  }
}

export function storedRuntimeError(
  error: unknown,
  at: Date,
  requestId: string | undefined,
): StoredRuntimeError {
  let raw = "Runtime failure";
  try {
    if (error instanceof Error && typeof error.message === "string")
      raw = error.message;
  } catch {
    raw = "Runtime failure";
  }
  const message = redactSensitiveText(raw).replaceAll(/\s+/gu, " ").trim();
  let timestamp = new Date(0).toISOString();
  try {
    if (at instanceof Date && Number.isFinite(at.getTime()))
      timestamp = at.toISOString();
  } catch {
    timestamp = new Date(0).toISOString();
  }
  return Object.freeze({
    class: runtimeErrorKind(error),
    message: (message || "Runtime failure").slice(0, 500),
    timestamp,
    ...(typeof requestId === "string" && SAFE_REQUEST_ID.test(requestId)
      ? { requestId }
      : {}),
  });
}
